import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { openRuntimeSqliteDatabase, runtimeDbPath, type RuntimeSqliteDatabase } from "./runtime-db.js";
import { ApiError } from "./errors.js";
import {
  removeWorkspacePluginForMigration,
  restoreWorkspacePluginMigrationSnapshot,
  snapshotWorkspacePluginForMigration,
  withWorkspacePluginMutationLocks,
  type CloudPluginEngineMutation,
  type WorkspacePluginMigrationSnapshot,
} from "./cloud-plugins.js";
import type {
  HostMarketplaceMigrationSnapshot,
  HostMarketplaceMutationResult,
  HostMarketplacePackage,
  HostMarketplacePluginRegistry,
  HostMarketplaceScope,
} from "./host-marketplace-plugins.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type SqlValue = string | number | bigint | Uint8Array | null;
type Sqlite = RuntimeSqliteDatabase;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export type HostMarketplaceMigrationWorkspacePlan = {
  workspaceId: string;
  label: string;
  path: string;
  recordDigest: string;
  resources: WorkspacePluginMigrationSnapshot["resources"];
  blockers: WorkspacePluginMigrationSnapshot["blockers"];
  migratable: boolean;
};

export type HostMarketplaceMigrationPlan = {
  pluginId: string;
  packageDigest: string;
  registryRevision: number;
  workspaces: HostMarketplaceMigrationWorkspacePlan[];
  blockers: Array<{ workspaceId: string; code: string; resource: string; message: string }>;
  migratable: boolean;
  fingerprint: string;
  migrationToken: string;
};

export type HostMarketplaceMigrationCommitInput = {
  scope: HostMarketplaceScope;
  package: HostMarketplacePackage;
  expectedRevision: number;
  idempotencyKey: string;
  workspaceCopies: Array<{ workspaceId: string; recordDigest: string }>;
  confirmed: true;
  fingerprint: string;
  migrationToken: string;
};

export type HostMarketplaceMigrationResult = {
  operation: "migrate_workspace_copies";
  changed: true;
  migratedWorkspaces: string[];
  host: HostMarketplaceMutationResult;
};

type MigrationJournal = {
  operationId: string;
  pluginId: string;
  phase: string;
  requestDigest: string;
  idempotencyKey: string;
  workspaceSnapshots: WorkspacePluginMigrationSnapshot[];
  hostSnapshot: HostMarketplaceMigrationSnapshot;
};

type CoordinatorOptions = {
  config: ServerConfig;
  registry: HostMarketplacePluginRegistry;
  authority: object;
  environmentId: string;
  synchronizeEngine?: (workspace: WorkspaceInfo, mutation: CloudPluginEngineMutation) => Promise<void>;
  faultInjector?: (stage: "after_journal" | "after_stage" | "after_workspace" | "after_host") => void | Promise<void>;
};

/** Simulates process termination after the durable migration journal is written. */
export class HostMarketplaceMigrationFailStopError extends Error {
  constructor(message = "Injected host Marketplace migration fail-stop") {
    super(message);
    this.name = "HostMarketplaceMigrationFailStopError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stableValue((value as Record<string, unknown>)[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function sqlExec(db: Sqlite, sql: string): void {
  db.sqlite.exec(sql);
}

function sqlRun(db: Sqlite, sql: string, values: SqlValue[] = []): void {
  if (db.kind === "bun") db.sqlite.run(sql, values);
  else db.sqlite.prepare(sql).run(...values);
}

function sqlGet<T>(db: Sqlite, sql: string, values: SqlValue[] = []): T | undefined {
  if (db.kind === "bun") return db.sqlite.query(sql).get(...values) as T | undefined;
  return db.sqlite.prepare(sql).get(...values) as T | undefined;
}

function sqlAll<T>(db: Sqlite, sql: string, values: SqlValue[] = []): T[] {
  if (db.kind === "bun") return db.sqlite.query(sql).all(...values) as T[];
  return db.sqlite.prepare(sql).all(...values) as T[];
}

function transaction<T>(db: Sqlite, operation: () => T): T {
  sqlExec(db, "BEGIN IMMEDIATE");
  try {
    const result = operation();
    sqlExec(db, "COMMIT");
    return result;
  } catch (error) {
    try { sqlExec(db, "ROLLBACK"); } catch {}
    throw error;
  }
}

function initialize(db: Sqlite): void {
  sqlExec(db, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  sqlExec(db, `CREATE TABLE IF NOT EXISTS host_marketplace_migration_journal (
    operation_id TEXT PRIMARY KEY NOT NULL,
    plugin_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    before_json TEXT NOT NULL,
    result_json TEXT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS host_marketplace_migration_journal_idempotency
    ON host_marketplace_migration_journal(plugin_id, idempotency_key);
  DROP INDEX IF EXISTS host_marketplace_migration_idempotency;
  CREATE TABLE IF NOT EXISTS host_marketplace_migration_idempotency (
    plugin_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, idempotency_key)
  )`);
  const terminal = sqlGet<{ count: number }>(db, `SELECT COUNT(*) AS count FROM host_marketplace_migration_journal
    WHERE phase IN ('completed', 'rolled_back')`);
  if (Number(terminal?.count ?? 0) > 0) {
    // Preserve replay semantics before scrubbing legacy terminal snapshots and package contents.
    sqlRun(db, `INSERT OR IGNORE INTO host_marketplace_migration_idempotency(
      plugin_id, idempotency_key, request_digest, response_json, created_at
    ) SELECT plugin_id, idempotency_key, request_digest, result_json, updated_at
      FROM host_marketplace_migration_journal WHERE phase = 'completed' AND result_json IS NOT NULL`);
    sqlRun(db, "DELETE FROM host_marketplace_migration_journal WHERE phase IN ('completed', 'rolled_back')");
    sqlRun(db, `DELETE FROM host_marketplace_migration_idempotency WHERE rowid IN (
      SELECT rowid FROM host_marketplace_migration_idempotency ORDER BY created_at DESC LIMIT -1 OFFSET 1000
    )`);
  }
}

function workspaceById(config: ServerConfig, workspaceId: string): WorkspaceInfo {
  const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new ApiError(409, "host_marketplace_migration_workspace_missing", "A planned workspace is no longer configured.", { workspaceId });
  return workspace;
}

export async function createHostMarketplaceMigrationCoordinator(options: CoordinatorOptions) {
  const db = await openRuntimeSqliteDatabase(runtimeDbPath(options.config));
  initialize(db);
  const tokenFor = (fingerprint: string) => createHmac("sha256", options.config.hostToken).update(`${options.environmentId}\0${fingerprint}`).digest("hex");

  async function readSnapshots(pluginId: string): Promise<Array<{ workspace: WorkspaceInfo; snapshot: WorkspacePluginMigrationSnapshot }>> {
    const found: Array<{ workspace: WorkspaceInfo; snapshot: WorkspacePluginMigrationSnapshot }> = [];
    for (const workspace of [...options.config.workspaces].sort((left, right) => left.id.localeCompare(right.id))) {
      if (workspace.workspaceType === "remote") continue;
      const snapshot = await snapshotWorkspacePluginForMigration({
        serverConfig: options.config,
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        pluginId,
      });
      if (snapshot) found.push({ workspace, snapshot });
    }
    return found;
  }

  async function plan(scope: HostMarketplaceScope, packageInput: HostMarketplacePackage): Promise<HostMarketplaceMigrationPlan> {
    const registry = await options.registry.list(scope);
    if (!registry.active) throw new ApiError(409, "host_marketplace_scope_inactive", "The requested identity scope is not active on this host.");
    let validated: Awaited<ReturnType<HostMarketplacePluginRegistry["validateMigrationPackage"]>>;
    try {
      validated = await options.registry.validateMigrationPackage(packageInput);
    } catch (error) {
      if (!(error instanceof ApiError) || (error.code !== "host_marketplace_repair_required" && error.code !== "host_marketplace_ownership_conflict" && error.code !== "host_marketplace_unsafe_path")) throw error;
      const snapshots = await readSnapshots(packageInput.pluginId);
      const workspaces = snapshots.map(({ workspace, snapshot }) => ({
        workspaceId: workspace.id,
        label: workspace.displayName?.trim() || workspace.name,
        path: workspace.path,
        recordDigest: snapshot.recordDigest,
        resources: snapshot.resources,
        blockers: snapshot.blockers,
        migratable: false,
      }));
      const blocker = { workspaceId: "host", code: error.code, resource: packageInput.pluginId, message: error.message };
      const packageDigest = digest(packageInput);
      const fingerprint = digest({
        scope,
        packageDigest,
        registryRevision: registry.registryRevision,
        workspaceCopies: workspaces.map(({ workspaceId, recordDigest }) => ({ workspaceId, recordDigest })),
        hostBlocker: error.code,
      });
      return { pluginId: packageInput.pluginId, packageDigest, registryRevision: registry.registryRevision, workspaces, blockers: [blocker], migratable: false, fingerprint, migrationToken: tokenFor(fingerprint) };
    }
    const snapshots = await readSnapshots(packageInput.pluginId);
    const workspaces = snapshots.map(({ workspace, snapshot }) => ({
      workspaceId: workspace.id,
      label: workspace.displayName?.trim() || workspace.name,
      path: workspace.path,
      recordDigest: snapshot.recordDigest,
      resources: snapshot.resources,
      blockers: snapshot.blockers,
      migratable: snapshot.blockers.length === 0,
    }));
    const blockers = workspaces.flatMap((workspace) => workspace.blockers.map((blocker) => ({ workspaceId: workspace.workspaceId, ...blocker })));
    const fingerprint = digest({
      scope,
      packageDigest: validated.packageDigest,
      registryRevision: registry.registryRevision,
      workspaceCopies: workspaces.map(({ workspaceId, recordDigest }) => ({ workspaceId, recordDigest })),
    });
    const result: HostMarketplaceMigrationPlan = {
      pluginId: packageInput.pluginId,
      packageDigest: validated.packageDigest,
      registryRevision: registry.registryRevision,
      workspaces,
      blockers,
      migratable: workspaces.length > 0 && blockers.length === 0,
      fingerprint,
      migrationToken: tokenFor(fingerprint),
    };
    return result;
  }

  async function restoreJournal(journal: MigrationJournal, synchronizeEngines = true): Promise<void> {
    for (const snapshot of [...journal.workspaceSnapshots].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))) {
      const workspace = workspaceById(options.config, snapshot.workspaceId);
      await restoreWorkspacePluginMigrationSnapshot({
        serverConfig: options.config,
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        snapshot,
        synchronizeEngine: synchronizeEngines && options.synchronizeEngine ? (mutation) => options.synchronizeEngine!(workspace, mutation) : undefined,
      });
    }
    await options.registry.restoreMigrationState(journal.hostSnapshot, options.authority);
  }

  async function commit(input: HostMarketplaceMigrationCommitInput): Promise<HostMarketplaceMigrationResult> {
    if (input.confirmed !== true) throw new ApiError(400, "host_marketplace_migration_confirmation_required", "Migration must be explicitly confirmed.");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0
      || typeof input.fingerprint !== "string" || typeof input.migrationToken !== "string") {
      throw new ApiError(400, "invalid_host_marketplace_payload", "Migration revision, idempotency key, fingerprint, and token are required.");
    }
    const expectedToken = tokenFor(input.fingerprint);
    const supplied = Buffer.from(input.migrationToken, "utf8");
    const expected = Buffer.from(expectedToken, "utf8");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ApiError(409, "host_marketplace_migration_token_invalid", "Migration token is invalid.");
    }
    const requestDigest = digest(input);
    const replay = sqlGet<{ requestDigest: string; responseJson: string }>(db, `SELECT request_digest AS requestDigest, response_json AS responseJson
      FROM host_marketplace_migration_idempotency WHERE plugin_id = ? AND idempotency_key = ?`, [input.package.pluginId, input.idempotencyKey]);
    if (replay) {
      if (replay.requestDigest !== requestDigest) throw new ApiError(409, "host_marketplace_migration_idempotency_conflict", "Idempotency key was used for a different migration request.");
      return JSON.parse(replay.responseJson) as HostMarketplaceMigrationResult;
    }
    const prior = sqlGet<{ requestDigest: string }>(db, `SELECT request_digest AS requestDigest
      FROM host_marketplace_migration_journal WHERE plugin_id = ? AND idempotency_key = ?`, [input.package.pluginId, input.idempotencyKey]);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new ApiError(409, "host_marketplace_migration_idempotency_conflict", "Idempotency key was used for a different migration request.");
      throw new ApiError(409, "host_marketplace_migration_incomplete", "A previous migration attempt requires startup recovery.");
    }
    const expectedCopies = [...input.workspaceCopies].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    if (expectedCopies.length === 0) throw new ApiError(409, "host_marketplace_migration_workspace_set_mismatch", "Migration requires at least one exact workspace copy.");

    return options.registry.withMigrationLock(options.authority, () => withWorkspacePluginMutationLocks(options.config, expectedCopies.map((copy) => copy.workspaceId), async () => {
      const current = await readSnapshots(input.package.pluginId);
      const currentCopies = current.map(({ snapshot }) => ({ workspaceId: snapshot.workspaceId, recordDigest: snapshot.recordDigest })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
      if (stableJson(currentCopies) !== stableJson(expectedCopies) || current.some(({ snapshot }) => snapshot.blockers.length > 0)) {
        throw new ApiError(409, "host_marketplace_migration_plan_stale", "Workspace copies changed after migration planning.");
      }
      const validated = await options.registry.validateMigrationPackage(input.package, options.authority);
      const registryState = await options.registry.list(input.scope);
      const currentFingerprint = digest({ scope: input.scope, packageDigest: validated.packageDigest, registryRevision: registryState.registryRevision, workspaceCopies: currentCopies });
      if (currentFingerprint !== input.fingerprint || registryState.registryRevision !== input.expectedRevision) {
        throw new ApiError(409, "host_marketplace_migration_plan_stale", "Host or package state changed after migration planning.");
      }

      for (const { workspace, snapshot } of current) {
        const latest = await snapshotWorkspacePluginForMigration({
          serverConfig: options.config,
          workspaceId: workspace.id,
          workspaceRoot: workspace.path,
          pluginId: input.package.pluginId,
        });
        if (!latest || latest.recordDigest !== snapshot.recordDigest || latest.blockers.length > 0
          || stableJson(latest.files) !== stableJson(snapshot.files) || stableJson(latest.mcps) !== stableJson(snapshot.mcps)) {
          throw new ApiError(409, "host_marketplace_migration_plan_stale", "Workspace resources changed during migration preflight.", { workspaceId: workspace.id });
        }
      }

      const hostSnapshot = await options.registry.snapshotMigrationState(input.package, options.authority);
      const journal: MigrationJournal = {
        operationId: randomUUID(),
        pluginId: input.package.pluginId,
        phase: "prepared",
        requestDigest,
        idempotencyKey: input.idempotencyKey,
        workspaceSnapshots: current.map(({ snapshot }) => snapshot),
        hostSnapshot,
      };
      const timestamp = Date.now();
      sqlRun(db, `INSERT INTO host_marketplace_migration_journal(operation_id, plugin_id, phase, request_digest, idempotency_key, before_json, result_json, created_at, updated_at)
        VALUES (?, ?, 'prepared', ?, ?, ?, NULL, ?, ?)`, [journal.operationId, journal.pluginId, requestDigest, input.idempotencyKey, JSON.stringify(journal), timestamp, timestamp]);
      await options.faultInjector?.("after_journal");

      try {
        await options.registry.stageMigrationPackage(input.package, options.authority);
        sqlRun(db, "UPDATE host_marketplace_migration_journal SET phase = 'staged', updated_at = ? WHERE operation_id = ?", [Date.now(), journal.operationId]);
        await options.faultInjector?.("after_stage");
        for (const { workspace, snapshot } of current) {
          await removeWorkspacePluginForMigration({
            serverConfig: options.config,
            workspaceId: workspace.id,
            workspaceRoot: workspace.path,
            snapshot,
            synchronizeEngine: options.synchronizeEngine ? (mutation) => options.synchronizeEngine!(workspace, mutation) : undefined,
          });
        }
        sqlRun(db, "UPDATE host_marketplace_migration_journal SET phase = 'workspaces_removed', updated_at = ? WHERE operation_id = ?", [Date.now(), journal.operationId]);
        await options.faultInjector?.("after_workspace");
        const host = await options.registry.installForMigration({
          scope: input.scope,
          authority: "owner",
          expectedRevision: input.expectedRevision,
          idempotencyKey: `migration:${input.idempotencyKey}`,
        }, input.package, options.authority);
        await options.faultInjector?.("after_host");
        const result: HostMarketplaceMigrationResult = {
          operation: "migrate_workspace_copies",
          changed: true,
          migratedWorkspaces: currentCopies.map((copy) => copy.workspaceId),
          host,
        };
        transaction(db, () => {
          const completedAt = Date.now();
          sqlRun(db, `INSERT INTO host_marketplace_migration_idempotency(plugin_id, idempotency_key, request_digest, response_json, created_at)
            VALUES (?, ?, ?, ?, ?)`, [journal.pluginId, journal.idempotencyKey, journal.requestDigest, JSON.stringify(result), completedAt]);
          sqlRun(db, `DELETE FROM host_marketplace_migration_idempotency WHERE rowid IN (
            SELECT rowid FROM host_marketplace_migration_idempotency ORDER BY created_at DESC LIMIT -1 OFFSET 1000
          )`);
          sqlRun(db, "DELETE FROM host_marketplace_migration_journal WHERE operation_id = ?", [journal.operationId]);
        });
        return result;
      } catch (error) {
        if (error instanceof HostMarketplaceMigrationFailStopError) throw error;
        sqlRun(db, "UPDATE host_marketplace_migration_journal SET phase = 'rolling_back', updated_at = ? WHERE operation_id = ?", [Date.now(), journal.operationId]);
        try {
          await restoreJournal(journal);
          sqlRun(db, "DELETE FROM host_marketplace_migration_journal WHERE operation_id = ?", [journal.operationId]);
        } catch (rollbackError) {
          throw new ApiError(500, "host_marketplace_migration_repair_required", "Migration failed and exact rollback was incomplete.", {
            cause: error instanceof Error ? error.message : String(error),
            rollbackCause: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, "host_marketplace_migration_failed", "Migration failed and exact prior state was restored.", { cause: error instanceof Error ? error.message : String(error) });
      }
    }));
  }

  async function recoverNonterminal(): Promise<void> {
    const rows = sqlAll<{ operationId: string; beforeJson: string }>(db, `SELECT operation_id AS operationId, before_json AS beforeJson
      FROM host_marketplace_migration_journal WHERE phase NOT IN ('completed', 'rolled_back') ORDER BY created_at, operation_id`);
    for (const row of rows) {
      const journal = JSON.parse(row.beforeJson) as MigrationJournal;
      await options.registry.withMigrationLock(options.authority, () => withWorkspacePluginMutationLocks(options.config, journal.workspaceSnapshots.map((snapshot) => snapshot.workspaceId), async () => {
        await restoreJournal(journal, false);
        sqlRun(db, "DELETE FROM host_marketplace_migration_journal WHERE operation_id = ?", [row.operationId]);
      }));
    }
  }

  return { plan, commit, recoverNonterminal, close: () => db.close() };
}

export type HostMarketplaceMigrationCoordinator = Awaited<ReturnType<typeof createHostMarketplaceMigrationCoordinator>>;
