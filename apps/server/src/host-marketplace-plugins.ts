import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";
import { resolveGlobalOpenCodeConfigPath } from "./mcp.js";
import {
  openRuntimeSqliteDatabase,
  runtimeDbPath,
  runtimeStorageDir,
  type RuntimeSqliteDatabase,
} from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

const SCHEMA_VERSION = 1;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MAX_COMPONENTS = 128;
const MAX_COMPONENT_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MCP_ENV_REFERENCE_RE = /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const SUPPORTED_TEXT_TYPES = new Set<HostMarketplaceTextObjectType>([
  "skill",
  "agent",
  "command",
  "context",
  "hook",
  "tool",
]);

type SqlValue = string | number | bigint | Uint8Array | null;
type Sqlite = RuntimeSqliteDatabase;

export type HostMarketplaceTextObjectType = "skill" | "agent" | "command" | "context" | "hook" | "tool";
export type HostMarketplaceObjectType = HostMarketplaceTextObjectType | "mcp" | "custom";
export type HostMarketplaceDelivery = "desktop" | "cloud";

export type HostMarketplaceScope = {
  environmentId: string;
  controlPlaneOrigin: string;
  userId: string;
  organizationId: string;
};

export type HostMarketplaceTextComponent = {
  id: string;
  type: HostMarketplaceTextObjectType;
  title: string;
  versionId: string;
  source: string;
  delivery: HostMarketplaceDelivery;
};

export type HostMarketplaceMcpComponent = {
  id: string;
  type: "mcp";
  title: string;
  versionId: string;
  payload: Record<string, unknown>;
  delivery: HostMarketplaceDelivery;
};

export type HostMarketplaceCustomComponent = {
  id: string;
  type: "custom";
  title: string;
  versionId: string;
  payload?: unknown;
  delivery: HostMarketplaceDelivery;
};

export type HostMarketplacePackage = {
  pluginId: string;
  marketplaceId: string;
  name: string;
  description?: string | null;
  revision: string;
  /** Must equal revision when the package contains hooks, tools, or local-command MCPs. */
  confirmedExecutableRevision?: string;
  components: Array<HostMarketplaceTextComponent | HostMarketplaceMcpComponent | HostMarketplaceCustomComponent>;
};

export type HostMarketplaceInstallationStatus = "installed" | "repair_required";

export type HostMarketplaceOwnedResource = {
  kind: "file" | "mcp";
  componentId: string;
  target: string;
  digest: string;
};

export type HostMarketplaceRepair = {
  operation: "install" | "update" | "remove" | "activate" | "deactivate";
  cause: string;
  resources: string[];
  rollbackFailures?: Array<{ stage: string; message: string }>;
  quarantine?: {
    id: string;
    root: string;
    entries: Array<{
      resource: string;
      kind: "file" | "mcp" | "missing" | "unsafe";
      path: string;
    }>;
  };
  recordedAt: number;
};

export type HostMarketplaceInstallation = {
  pluginId: string;
  marketplaceId: string;
  name: string;
  description: string | null;
  packageRevision: string;
  packageDigest: string;
  status: HostMarketplaceInstallationStatus;
  resources: HostMarketplaceOwnedResource[];
  installedAt: number;
  updatedAt: number;
  repair?: HostMarketplaceRepair;
};

export type HostMarketplaceRegistryList = {
  schemaVersion: number;
  registryRevision: number;
  scope: HostMarketplaceScope;
  active: boolean;
  installations: HostMarketplaceInstallation[];
};

export type HostMarketplaceMutationContext = {
  scope: HostMarketplaceScope;
  authority: "owner";
  idempotencyKey: string;
  expectedRevision: number;
};

export type HostMarketplaceMutationResult = {
  operation: "activate" | "deactivate" | "install" | "update" | "remove" | "cloud_only";
  changed: boolean;
  registryRevision: number;
  activeScope: HostMarketplaceScope | null;
  installation: HostMarketplaceInstallation | null;
  mcpOverlay: Record<string, Record<string, unknown>>;
};

export type HostMarketplacePluginRegistryOptions = {
  config?: ServerConfig;
  databasePath?: string;
  storageDirectory?: string;
  globalOpenCodeDirectory?: string;
  managed?: boolean;
  readOnly?: boolean;
  /** Reads the dedicated Server-owned host Marketplace MCP overlay, not merged user config. */
  readMcpOverlay?: () => Promise<Record<string, Record<string, unknown>>>;
  applyMcpOverlay?: (overlay: Record<string, Record<string, unknown>>) => Promise<void>;
  findWorkspaceConflicts?: (pluginId: string) => Promise<string[]>;
  migrationAuthority?: object;
  /** Test seam used to prove compensation or process-crash recovery at an operation boundary. */
  faultInjector?: (stage: "after_files" | "after_registry" | "after_engine" | "rollback_files" | "rollback_registry" | "rollback_engine") => void | Promise<void>;
  now?: () => number;
};

export type HostMarketplaceMigrationSnapshot = {
  packageDigest: string;
  database: DatabaseSnapshot;
  globalFiles: Array<[string, string | null]>;
  storageFiles: Array<[string, string | null]>;
  overlay: Record<string, Record<string, unknown>>;
};

type InternalFileResource = HostMarketplaceOwnedResource & {
  kind: "file";
  content: string;
};

type InternalMcpResource = HostMarketplaceOwnedResource & {
  kind: "mcp";
  config: Record<string, unknown>;
};

type InternalResource = InternalFileResource | InternalMcpResource;

type InternalInstallation = Omit<HostMarketplaceInstallation, "resources"> & {
  resources: InternalResource[];
  cachePath: string;
};

type RegistryMeta = {
  schemaVersion: number;
  registryRevision: number;
  activeScopeKey: string | null;
};

type ScopeRow = {
  scopeKey: string;
  environmentId: string;
  controlPlaneOrigin: string;
  userId: string;
  organizationId: string;
};

type InstallationRow = {
  scopeKey: string;
  pluginId: string;
  recordJson: string;
};

type IdempotencyRow = {
  scopeKey: string;
  operation: string;
  idempotencyKey: string;
  requestDigest: string;
  responseJson: string;
  createdAt: number;
};

export type DatabaseSnapshot = {
  meta: RegistryMeta;
  scopes: ScopeRow[];
  installations: InstallationRow[];
  idempotency: IdempotencyRow[];
};

type ProjectionChange = {
  writes: Map<string, string>;
  removals: Set<string>;
};

type FileSnapshot = Map<string, string | null>;

type JournalPhase = "prepared" | "files_applied" | "registry_applied" | "overlay_applied" | "rolling_back" | "completed" | "rolled_back";

type JournalBefore = {
  database: DatabaseSnapshot;
  globalFiles: Array<[string, string | null]>;
  storageFiles: Array<[string, string | null]>;
  overlay: Record<string, Record<string, unknown>>;
};

type JournalDesired = {
  globalWrites: Array<[string, string]>;
  globalRemovals: string[];
  storageWrites: Array<[string, string]>;
  storageRemovals: string[];
  overlay: Record<string, Record<string, unknown>>;
};

type JournalRow = {
  operationId: string;
  operation: string;
  phase: JournalPhase;
  beforeJson: string;
  desiredJson: string;
};

export class HostMarketplacePluginError extends ApiError {}

/** Simulates abrupt process termination: callers must close and reopen for recovery. */
export class HostMarketplaceFailStopError extends Error {
  constructor(message = "Injected host Marketplace fail-stop") {
    super(message);
    this.name = "HostMarketplaceFailStopError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : stableJson(value), "utf8");
}

function assertBoundedStructure(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 20_000 || current.depth > 32) {
      throw new HostMarketplacePluginError(413, "host_marketplace_payload_too_large", "Marketplace package structure exceeds the host payload limit.");
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) throw new HostMarketplacePluginError(400, "invalid_host_marketplace_payload", "Marketplace package must not contain cyclic values.");
    seen.add(current.value);
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
}

function assertBoundedString(value: unknown, label: string, max = MAX_ID_LENGTH): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HostMarketplacePluginError(400, "invalid_host_marketplace_payload", `${label} is invalid.`);
  }
}

function normalizeScope(scope: HostMarketplaceScope): HostMarketplaceScope {
  assertBoundedString(scope.environmentId, "environmentId");
  assertBoundedString(scope.userId, "userId");
  assertBoundedString(scope.organizationId, "organizationId");
  assertBoundedString(scope.controlPlaneOrigin, "controlPlaneOrigin", 2048);
  let origin: URL;
  try {
    origin = new URL(scope.controlPlaneOrigin);
  } catch {
    throw new HostMarketplacePluginError(400, "invalid_host_marketplace_scope", "controlPlaneOrigin must be an HTTP(S) origin.");
  }
  if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.username || origin.password || origin.origin === "null") {
    throw new HostMarketplacePluginError(400, "invalid_host_marketplace_scope", "controlPlaneOrigin must be an HTTP(S) origin without credentials.");
  }
  return {
    environmentId: scope.environmentId.trim(),
    controlPlaneOrigin: origin.origin,
    userId: scope.userId.trim(),
    organizationId: scope.organizationId.trim(),
  };
}

function scopeKey(scope: HostMarketplaceScope): string {
  return digest([scope.environmentId, scope.controlPlaneOrigin, scope.userId, scope.organizationId]);
}

function scopeFromRow(row: ScopeRow): HostMarketplaceScope {
  return {
    environmentId: row.environmentId,
    controlPlaneOrigin: row.controlPlaneOrigin,
    userId: row.userId,
    organizationId: row.organizationId,
  };
}

function slug(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/g, "");
  return normalized || fallback;
}

function pluginNamespace(pluginId: string): string {
  return `jw-${slug(pluginId, "plugin")}-${digest(pluginId).slice(0, 12)}`;
}

function componentName(component: { id: string; title: string }): string {
  return `${slug(component.title, "component")}-${digest(component.id).slice(0, 10)}`;
}

function textResourcePath(pluginId: string, component: HostMarketplaceTextComponent): string {
  const namespace = pluginNamespace(pluginId);
  const name = componentName(component);
  switch (component.type) {
    case "skill": return `skills/${namespace}/${name}/SKILL.md`;
    case "agent": return `agents/${namespace}/${name}.md`;
    case "command": return `commands/${namespace}/${name}.md`;
    case "context": return `context/${namespace}/${name}.md`;
    case "hook": return `hooks/${namespace}/${name}.json`;
    case "tool": return `tools/${namespace}/${name}.ts`;
  }
}

function mcpName(pluginId: string, component: HostMarketplaceMcpComponent, sourceName: string): string {
  const namespace = pluginNamespace(pluginId).replace(/-/g, "_");
  return `${namespace}_${slug(sourceName, componentName(component)).replace(/-/g, "_")}_${digest(`${component.id}\0${sourceName}`).slice(0, 8)}`;
}

function normalizeTextContent(source: string): string {
  return source.endsWith("\n") ? source : `${source}\n`;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 64) throw new HostMarketplacePluginError(413, "host_marketplace_payload_too_large", "MCP environment has too many entries.");
  const output: Record<string, string> = {};
  for (const [key, entry] of entries) {
    assertBoundedString(key, "MCP environment name", 128);
    if (typeof entry !== "string" || entry.length > 4096 || entry.includes("\0")) {
      throw new HostMarketplacePluginError(400, "invalid_host_marketplace_payload", "MCP environment values must be bounded strings.");
    }
    if (!MCP_ENV_REFERENCE_RE.test(entry)) {
      throw new HostMarketplacePluginError(400, "host_marketplace_mcp_environment_reference_required", "Host Marketplace MCP environment values must use exact {env:NAME} references.");
    }
    output[key] = entry;
  }
  return Object.keys(output).length ? output : undefined;
}

function commandArray(value: Record<string, unknown>): string[] {
  const raw = Array.isArray(value.command)
    ? value.command
    : typeof value.command === "string"
      ? [value.command, ...(Array.isArray(value.args) ? value.args : [])]
      : [];
  if (raw.length === 0 || raw.length > 64 || raw.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 4096 || entry.includes("\0"))) {
    throw new HostMarketplacePluginError(400, "unsupported_host_marketplace_mcp", "Desktop MCP components must contain a bounded local command.");
  }
  return raw as string[];
}

function normalizeLocalMcpConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.url === "string" || value.type === "remote") {
    throw new HostMarketplacePluginError(400, "unsupported_host_marketplace_mcp", "Remote MCP materialization is not supported by the host registry.");
  }
  const config: Record<string, unknown> = {
    type: "local",
    command: commandArray(value),
    enabled: typeof value.enabled === "boolean" ? value.enabled : value.disabled === true ? false : true,
  };
  const environment = stringRecord(value.environment) ?? stringRecord(value.env);
  if (environment) config.environment = environment;
  if (typeof value.cwd === "string") {
    if (value.cwd.length > 4096 || value.cwd.includes("\0")) throw new HostMarketplacePluginError(400, "invalid_host_marketplace_payload", "MCP cwd is invalid.");
    config.cwd = value.cwd;
  }
  if (typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0) config.timeout = Math.round(value.timeout);
  return config;
}

function mcpEntries(component: HostMarketplaceMcpComponent): Array<{ sourceName: string; config: Record<string, unknown> }> {
  const root = component.payload;
  const container = isRecord(root.mcp) ? root.mcp : isRecord(root.mcpServers) ? root.mcpServers : null;
  const entries = container ? Object.entries(container) : [[component.title, root] as [string, unknown]];
  if (entries.length === 0 || entries.length > 64) {
    throw new HostMarketplacePluginError(400, "unsupported_host_marketplace_mcp", "MCP component contains no supported local servers.");
  }
  return entries.map(([sourceName, config]) => {
    assertBoundedString(sourceName, "MCP server name", 128);
    return { sourceName, config: normalizeLocalMcpConfig(config) };
  });
}

function validatePackage(input: HostMarketplacePackage): HostMarketplacePackage {
  assertBoundedStructure(input);
  assertBoundedString(input.pluginId, "pluginId");
  assertBoundedString(input.marketplaceId, "marketplaceId");
  assertBoundedString(input.name, "name", 512);
  assertBoundedString(input.revision, "revision");
  if (input.description !== undefined && input.description !== null && (typeof input.description !== "string" || input.description.length > 16_384)) {
    throw new HostMarketplacePluginError(400, "invalid_host_marketplace_payload", "description is invalid.");
  }
  if (!Array.isArray(input.components) || input.components.length === 0 || input.components.length > MAX_COMPONENTS) {
    throw new HostMarketplacePluginError(400, "invalid_host_marketplace_payload", `A package must contain 1-${MAX_COMPONENTS} components.`);
  }
  if (byteLength(input) > MAX_PACKAGE_BYTES) {
    throw new HostMarketplacePluginError(413, "host_marketplace_payload_too_large", "Marketplace package exceeds the host payload limit.");
  }
  const componentIds = new Set<string>();
  let executable = false;
  for (const component of input.components) {
    assertBoundedString(component.id, "component id");
    assertBoundedString(component.title, "component title", 512);
    assertBoundedString(component.versionId, "component versionId");
    if (componentIds.has(component.id)) throw new HostMarketplacePluginError(400, "invalid_host_marketplace_payload", `Duplicate component id: ${component.id}`);
    componentIds.add(component.id);
    if (component.delivery !== "cloud" && component.delivery !== "desktop") {
      throw new HostMarketplacePluginError(400, "invalid_host_marketplace_payload", "Component delivery must be explicit.");
    }
    if (component.type === "custom") {
      if (component.delivery === "desktop") {
        throw new HostMarketplacePluginError(400, "unsupported_host_marketplace_component", "Custom Marketplace components cannot be materialized by the host.");
      }
      continue;
    }
    if (component.type === "mcp") {
      if (component.delivery === "desktop") {
        executable = true;
        mcpEntries(component);
      }
    } else {
      if (!SUPPORTED_TEXT_TYPES.has(component.type)) throw new HostMarketplacePluginError(400, "unsupported_host_marketplace_component", `Unsupported component type: ${String(component.type)}`);
      if (typeof component.source !== "string" || byteLength(component.source) > MAX_COMPONENT_BYTES) {
        throw new HostMarketplacePluginError(413, "host_marketplace_payload_too_large", `Component ${component.id} exceeds the text payload limit.`);
      }
      if ((component.type === "hook" || component.type === "tool") && component.delivery === "desktop") executable = true;
    }
  }
  if (executable && input.confirmedExecutableRevision !== input.revision) {
    throw new HostMarketplacePluginError(409, "host_marketplace_executable_revision_unconfirmed", "Executable Marketplace content requires confirmation of the exact package revision.");
  }
  return input;
}

function packageIsCloudOnly(input: HostMarketplacePackage): boolean {
  return input.components.every((component) => component.delivery === "cloud");
}

function buildResources(input: HostMarketplacePackage): InternalResource[] {
  const resources: InternalResource[] = [];
  for (const component of input.components) {
    if (component.delivery === "cloud") continue;
    if (component.type === "custom") continue;
    if (component.type === "mcp") {
      for (const entry of mcpEntries(component)) {
        const target = mcpName(input.pluginId, component, entry.sourceName);
        resources.push({
          kind: "mcp",
          componentId: component.id,
          target,
          digest: digest(entry.config),
          config: entry.config,
        });
      }
      continue;
    }
    const target = textResourcePath(input.pluginId, component);
    const content = normalizeTextContent(component.source);
    resources.push({ kind: "file", componentId: component.id, target, digest: digest(content), content });
  }
  const targets = new Set<string>();
  for (const resource of resources) {
    const key = `${resource.kind}\0${resource.target}`;
    if (targets.has(key)) throw new HostMarketplacePluginError(400, "invalid_host_marketplace_payload", `Components resolve to duplicate target ${resource.target}.`);
    targets.add(key);
  }
  return resources.sort((left, right) => `${left.kind}:${left.target}`.localeCompare(`${right.kind}:${right.target}`));
}

function publicInstallation(record: InternalInstallation): HostMarketplaceInstallation {
  return {
    pluginId: record.pluginId,
    marketplaceId: record.marketplaceId,
    name: record.name,
    description: record.description,
    packageRevision: record.packageRevision,
    packageDigest: record.packageDigest,
    status: record.status,
    resources: record.resources.map(({ kind, componentId, target, digest: resourceDigest }) => ({ kind, componentId, target, digest: resourceDigest })),
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    ...(record.repair ? { repair: record.repair } : {}),
  };
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

function initializeDatabase(db: Sqlite): void {
  sqlExec(db, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  sqlExec(db, `CREATE TABLE IF NOT EXISTS host_marketplace_schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(sqlAll<{ version: number }>(db, "SELECT version FROM host_marketplace_schema_migrations ORDER BY version").map((row) => Number(row.version)));
  const unsupported = [...applied].find((version) => !Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION);
  if (unsupported !== undefined) {
    throw new HostMarketplacePluginError(500, "host_marketplace_schema_unsupported", `Unsupported host Marketplace migration version: ${unsupported}.`);
  }
  if (!applied.has(1)) transaction(db, () => {
    sqlExec(db, `CREATE TABLE IF NOT EXISTS host_marketplace_registry_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      registry_revision INTEGER NOT NULL,
      active_scope_key TEXT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_marketplace_scopes (
      scope_key TEXT PRIMARY KEY NOT NULL,
      environment_id TEXT NOT NULL,
      control_plane_origin TEXT NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_marketplace_installations (
      scope_key TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_key, plugin_id)
    );
    CREATE TABLE IF NOT EXISTS host_marketplace_idempotency (
      scope_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (scope_key, operation, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS host_marketplace_operation_journal (
      operation_id TEXT PRIMARY KEY NOT NULL,
      operation TEXT NOT NULL,
      phase TEXT NOT NULL,
      before_json TEXT NOT NULL,
      desired_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sqlRun(db, `INSERT OR IGNORE INTO host_marketplace_registry_meta(
      singleton, schema_version, registry_revision, active_scope_key, updated_at
    ) VALUES (1, ?, 0, NULL, ?)`, [SCHEMA_VERSION, Date.now()]);
    sqlRun(db, "INSERT INTO host_marketplace_schema_migrations(version, applied_at) VALUES (1, ?)", [Date.now()]);
  });
  const row = sqlGet<Record<string, unknown>>(db, "SELECT schema_version AS schemaVersion FROM host_marketplace_registry_meta WHERE singleton = 1");
  if (!row) throw new HostMarketplacePluginError(500, "host_marketplace_registry_unavailable", "Host Marketplace registry metadata is missing after migration.");
  const version = Number(row.schemaVersion);
  if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
    throw new HostMarketplacePluginError(500, "host_marketplace_schema_unsupported", `Unsupported host Marketplace registry schema version: ${String(row.schemaVersion)}.`);
  }
  // Terminal rows are legacy residue only. Replay data lives in host_marketplace_idempotency.
  const terminal = sqlGet<{ count: number }>(db, `SELECT COUNT(*) AS count FROM host_marketplace_operation_journal
    WHERE phase IN ('completed', 'rolled_back')`);
  if (Number(terminal?.count ?? 0) > 0) {
    sqlRun(db, "DELETE FROM host_marketplace_operation_journal WHERE phase IN ('completed', 'rolled_back')");
  }
}

function readMeta(db: Sqlite): RegistryMeta {
  const row = sqlGet<Record<string, unknown>>(db, "SELECT schema_version AS schemaVersion, registry_revision AS registryRevision, active_scope_key AS activeScopeKey FROM host_marketplace_registry_meta WHERE singleton = 1");
  if (!row) throw new HostMarketplacePluginError(500, "host_marketplace_registry_unavailable", "Host Marketplace registry metadata is missing.");
  return {
    schemaVersion: Number(row.schemaVersion),
    registryRevision: Number(row.registryRevision),
    activeScopeKey: typeof row.activeScopeKey === "string" ? row.activeScopeKey : null,
  };
}

function readScopeRow(db: Sqlite, key: string): ScopeRow | undefined {
  const row = sqlGet<Record<string, unknown>>(db, `SELECT scope_key AS scopeKey, environment_id AS environmentId,
    control_plane_origin AS controlPlaneOrigin, user_id AS userId, organization_id AS organizationId
    FROM host_marketplace_scopes WHERE scope_key = ?`, [key]);
  if (!row) return undefined;
  return row as ScopeRow;
}

function upsertScope(db: Sqlite, scope: HostMarketplaceScope, now: number): string {
  const key = scopeKey(scope);
  sqlRun(db, `INSERT INTO host_marketplace_scopes(scope_key, environment_id, control_plane_origin, user_id, organization_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET environment_id = excluded.environment_id,
      control_plane_origin = excluded.control_plane_origin, user_id = excluded.user_id,
      organization_id = excluded.organization_id, updated_at = excluded.updated_at`,
  [key, scope.environmentId, scope.controlPlaneOrigin, scope.userId, scope.organizationId, now, now]);
  return key;
}

function parseInstallation(row: { recordJson?: unknown }): InternalInstallation {
  if (typeof row.recordJson !== "string") throw new HostMarketplacePluginError(500, "host_marketplace_registry_corrupt", "An installation record is invalid.");
  const value: unknown = JSON.parse(row.recordJson);
  if (!isRecord(value) || !Array.isArray(value.resources)) throw new HostMarketplacePluginError(500, "host_marketplace_registry_corrupt", "An installation record is invalid.");
  return value as InternalInstallation;
}

function readInstallation(db: Sqlite, key: string, pluginId: string): InternalInstallation | null {
  const row = sqlGet<{ recordJson: string }>(db, "SELECT record_json AS recordJson FROM host_marketplace_installations WHERE scope_key = ? AND plugin_id = ?", [key, pluginId]);
  return row ? parseInstallation(row) : null;
}

function readInstallations(db: Sqlite, key: string): InternalInstallation[] {
  return sqlAll<{ recordJson: string }>(db, "SELECT record_json AS recordJson FROM host_marketplace_installations WHERE scope_key = ? ORDER BY plugin_id", [key]).map(parseInstallation);
}

function writeInstallation(db: Sqlite, key: string, record: InternalInstallation, now: number): void {
  sqlRun(db, `INSERT INTO host_marketplace_installations(scope_key, plugin_id, record_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(scope_key, plugin_id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at`,
  [key, record.pluginId, JSON.stringify(record), now]);
}

function bumpRevision(db: Sqlite, now: number, activeScopeKey?: string | null): number {
  if (activeScopeKey === undefined) {
    sqlRun(db, "UPDATE host_marketplace_registry_meta SET registry_revision = registry_revision + 1, updated_at = ? WHERE singleton = 1", [now]);
  } else {
    sqlRun(db, "UPDATE host_marketplace_registry_meta SET registry_revision = registry_revision + 1, active_scope_key = ?, updated_at = ? WHERE singleton = 1", [activeScopeKey, now]);
  }
  return readMeta(db).registryRevision;
}

function databaseSnapshot(db: Sqlite): DatabaseSnapshot {
  return {
    meta: readMeta(db),
    scopes: sqlAll<ScopeRow>(db, `SELECT scope_key AS scopeKey, environment_id AS environmentId,
      control_plane_origin AS controlPlaneOrigin, user_id AS userId, organization_id AS organizationId FROM host_marketplace_scopes`),
    installations: sqlAll<InstallationRow>(db, "SELECT scope_key AS scopeKey, plugin_id AS pluginId, record_json AS recordJson FROM host_marketplace_installations"),
    idempotency: sqlAll<IdempotencyRow>(db, `SELECT scope_key AS scopeKey, operation, idempotency_key AS idempotencyKey,
      request_digest AS requestDigest, response_json AS responseJson, created_at AS createdAt FROM host_marketplace_idempotency`),
  };
}

function restoreDatabaseSnapshot(db: Sqlite, snapshot: DatabaseSnapshot, now: number): void {
  transaction(db, () => {
    sqlRun(db, "DELETE FROM host_marketplace_idempotency");
    sqlRun(db, "DELETE FROM host_marketplace_installations");
    sqlRun(db, "DELETE FROM host_marketplace_scopes");
    for (const scope of snapshot.scopes) {
      sqlRun(db, `INSERT INTO host_marketplace_scopes(scope_key, environment_id, control_plane_origin, user_id, organization_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [scope.scopeKey, scope.environmentId, scope.controlPlaneOrigin, scope.userId, scope.organizationId, now, now]);
    }
    for (const record of snapshot.installations) {
      sqlRun(db, "INSERT INTO host_marketplace_installations(scope_key, plugin_id, record_json, updated_at) VALUES (?, ?, ?, ?)", [record.scopeKey, record.pluginId, record.recordJson, now]);
    }
    for (const entry of snapshot.idempotency ?? []) {
      sqlRun(db, `INSERT INTO host_marketplace_idempotency(scope_key, operation, idempotency_key, request_digest, response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [entry.scopeKey, entry.operation, entry.idempotencyKey, entry.requestDigest, entry.responseJson, entry.createdAt]);
    }
    sqlRun(db, `UPDATE host_marketplace_registry_meta SET schema_version = ?, registry_revision = ?, active_scope_key = ?, updated_at = ? WHERE singleton = 1`,
      [snapshot.meta.schemaVersion, snapshot.meta.registryRevision, snapshot.meta.activeScopeKey, now]);
  });
}

function overlayForScope(db: Sqlite, key: string | null): Record<string, Record<string, unknown>> {
  if (!key) return {};
  return overlayFromInstallations(readInstallations(db, key));
}

function overlayFromInstallations(installations: InternalInstallation[]): Record<string, Record<string, unknown>> {
  const overlay: Record<string, Record<string, unknown>> = {};
  for (const installation of installations) {
    for (const resource of installation.resources) {
      if (resource.kind === "mcp") overlay[resource.target] = resource.config;
    }
  }
  return overlay;
}

function mcpOverlayDrift(
  actual: Record<string, Record<string, unknown>>,
  expected: Record<string, Record<string, unknown>>,
): { modified: string[]; nonowned: string[] } {
  const modified = Object.entries(expected).flatMap(([name, config]) =>
    !actual[name] || digest(actual[name]) !== digest(config) ? [name] : []);
  const nonowned = Object.keys(actual).filter((name) => expected[name] === undefined);
  return { modified: modified.sort(), nonowned: nonowned.sort() };
}

function activeScope(db: Sqlite): HostMarketplaceScope | null {
  const key = readMeta(db).activeScopeKey;
  if (!key) return null;
  const row = readScopeRow(db, key);
  return row ? scopeFromRow(row) : null;
}

function assertMutationContext(db: Sqlite, context: HostMarketplaceMutationContext, requireActive = true): { scope: HostMarketplaceScope; key: string; meta: RegistryMeta } {
  if (context.authority !== "owner") throw new HostMarketplacePluginError(403, "host_marketplace_owner_required", "Host Marketplace mutations require owner authority.");
  assertBoundedString(context.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision < 0) {
    throw new HostMarketplacePluginError(400, "invalid_host_marketplace_revision", "expectedRevision must be a non-negative integer.");
  }
  const scope = normalizeScope(context.scope);
  const key = scopeKey(scope);
  const meta = readMeta(db);
  if (requireActive && meta.activeScopeKey !== key) {
    throw new HostMarketplacePluginError(409, "host_marketplace_scope_inactive", "The requested identity scope is not active on this host.");
  }
  return { scope, key, meta };
}

function assertExpectedRevision(meta: RegistryMeta, expected: number): void {
  if (meta.registryRevision !== expected) {
    throw new HostMarketplacePluginError(409, "host_marketplace_revision_conflict", "Host Marketplace registry changed before this mutation.", {
      expectedRevision: expected,
      currentRevision: meta.registryRevision,
    });
  }
}

function readIdempotentResult(db: Sqlite, key: string, operation: string, idempotencyKey: string, requestDigest: string): HostMarketplaceMutationResult | null {
  const row = sqlGet<{ requestDigest: string; responseJson: string }>(db, `SELECT request_digest AS requestDigest, response_json AS responseJson
    FROM host_marketplace_idempotency WHERE scope_key = ? AND operation = ? AND idempotency_key = ?`, [key, operation, idempotencyKey]);
  if (!row) return null;
  if (row.requestDigest !== requestDigest) {
    throw new HostMarketplacePluginError(409, "host_marketplace_idempotency_conflict", "Idempotency key was already used for a different request.");
  }
  return JSON.parse(row.responseJson) as HostMarketplaceMutationResult;
}

function writeIdempotentResult(db: Sqlite, key: string, operation: string, idempotencyKey: string, requestDigest: string, result: HostMarketplaceMutationResult, now: number): void {
  sqlRun(db, `INSERT INTO host_marketplace_idempotency(scope_key, operation, idempotency_key, request_digest, response_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [key, operation, idempotencyKey, requestDigest, JSON.stringify(result), now]);
  sqlRun(db, `DELETE FROM host_marketplace_idempotency WHERE rowid IN (
    SELECT rowid FROM host_marketplace_idempotency ORDER BY created_at DESC LIMIT -1 OFFSET 1000
  )`);
}

async function ensureSafeRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new HostMarketplacePluginError(409, "host_marketplace_unsafe_path", "The global OpenCode resource root is not a safe directory.");
  }
}

function resolveChild(root: string, child: string): string {
  const normalized = child.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) {
    throw new HostMarketplacePluginError(400, "host_marketplace_unsafe_path", `Unsafe resource path: ${child}`);
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...parts);
  if (!candidate.startsWith(`${resolvedRoot}${sep}`)) throw new HostMarketplacePluginError(400, "host_marketplace_unsafe_path", `Unsafe resource path: ${child}`);
  return candidate;
}

async function assertSafePath(root: string, child: string): Promise<string> {
  await ensureSafeRoot(root);
  const absolute = resolveChild(root, child);
  const parts = relative(resolve(root), absolute).split(sep).filter(Boolean);
  let current = resolve(root);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || (index < parts.length - 1 && !metadata.isDirectory()) || (index === parts.length - 1 && !metadata.isFile())) {
        throw new HostMarketplacePluginError(409, "host_marketplace_unsafe_path", `Resource path traverses a symlink or non-file entry: ${child}`);
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") break;
      throw error;
    }
  }
  return absolute;
}

async function ensureSafeParentDirectory(root: string, child: string): Promise<void> {
  await ensureSafeRoot(root);
  const absolute = resolveChild(root, child);
  const parentParts = relative(resolve(root), dirname(absolute)).split(sep).filter(Boolean);
  let current = resolve(root);
  for (const part of parentParts) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new HostMarketplacePluginError(409, "host_marketplace_unsafe_path", `Resource path traverses a symlink or non-directory entry: ${child}`);
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (!isRecord(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError;
      }
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new HostMarketplacePluginError(409, "host_marketplace_unsafe_path", `Resource path traverses a symlink or non-directory entry: ${child}`);
      }
    }
  }
}

async function readResource(root: string, child: string): Promise<string | null> {
  const absolute = await assertSafePath(root, child);
  try {
    return await readFile(absolute, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readResourceWithoutMutation(root: string, child: string): Promise<string | null> {
  const resolvedRoot = resolve(root);
  try {
    const rootMetadata = await lstat(resolvedRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new HostMarketplacePluginError(409, "host_marketplace_unsafe_path", "The resource root is not a safe directory.");
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const absolute = resolveChild(resolvedRoot, child);
  const parts = relative(resolvedRoot, absolute).split(sep).filter(Boolean);
  let current = resolvedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || (index < parts.length - 1 && !metadata.isDirectory()) || (index === parts.length - 1 && !metadata.isFile())) {
        throw new HostMarketplacePluginError(409, "host_marketplace_unsafe_path", `Resource path traverses a symlink or non-file entry: ${child}`);
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }
  return readFile(absolute, "utf8");
}

async function stageResource(root: string, child: string, content: string): Promise<{ target: string; temporary: string }> {
  const target = resolveChild(root, child);
  await ensureSafeParentDirectory(root, child);
  await assertSafePath(root, child);
  const temporary = `${target}.jugglework-${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { target, temporary };
}

async function atomicWriteResource(root: string, child: string, content: string): Promise<void> {
  const staged = await stageResource(root, child, content);
  try {
    await rename(staged.temporary, staged.target);
  } catch (error) {
    await rm(staged.temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeEmptyResourceDirectories(root: string, child: string): Promise<void> {
  const first = child.split("/")[0]!;
  const stop = join(resolve(root), first);
  let current = dirname(resolveChild(root, child));
  while (current !== stop && current.startsWith(`${stop}${sep}`)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST")) return;
      throw error;
    }
    current = dirname(current);
  }
}

async function removeResource(root: string, child: string): Promise<void> {
  const absolute = await assertSafePath(root, child);
  await rm(absolute, { force: true });
  await removeEmptyResourceDirectories(root, child);
}

async function snapshotFiles(root: string, paths: Iterable<string>): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  for (const path of [...new Set(paths)].sort()) snapshot.set(path, await readResource(root, path));
  return snapshot;
}

async function snapshotFilesWithoutMutation(root: string, paths: Iterable<string>): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  for (const path of [...new Set(paths)].sort()) snapshot.set(path, await readResourceWithoutMutation(root, path));
  return snapshot;
}

async function applyProjection(root: string, change: ProjectionChange): Promise<void> {
  const staged: Array<{ path: string; target: string; temporary: string }> = [];
  try {
    for (const [path, content] of [...change.writes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const item = await stageResource(root, path, content);
      staged.push({ path, ...item });
    }
    for (const item of staged) await rename(item.temporary, item.target);
    for (const path of [...change.removals].sort()) {
      if (!change.writes.has(path)) await removeResource(root, path);
    }
  } catch (error) {
    for (const item of staged) await rm(item.temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreFiles(root: string, snapshot: FileSnapshot): Promise<void> {
  for (const [path, content] of snapshot) {
    if (content === null) await removeResource(root, path);
    else await atomicWriteResource(root, path, content);
  }
}

function projectionJson(change: ProjectionChange): { writes: Array<[string, string]>; removals: string[] } {
  return {
    writes: [...change.writes.entries()].sort(([left], [right]) => left.localeCompare(right)),
    removals: [...change.removals].sort(),
  };
}

function snapshotJson(snapshot: FileSnapshot): Array<[string, string | null]> {
  return [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function readJournalRows(db: Sqlite): JournalRow[] {
  return sqlAll<JournalRow>(db, `SELECT operation_id AS operationId, operation, phase, before_json AS beforeJson,
    desired_json AS desiredJson FROM host_marketplace_operation_journal
    WHERE phase NOT IN ('completed', 'rolled_back') ORDER BY created_at, operation_id`);
}

function writeJournal(
  db: Sqlite,
  operation: string,
  before: JournalBefore,
  desired: JournalDesired,
  timestamp: number,
): string {
  const operationId = randomUUID();
  sqlRun(db, `INSERT INTO host_marketplace_operation_journal(
    operation_id, operation, phase, before_json, desired_json, created_at, updated_at
  ) VALUES (?, ?, 'prepared', ?, ?, ?, ?)`, [
    operationId,
    operation,
    JSON.stringify(before),
    JSON.stringify(desired),
    timestamp,
    timestamp,
  ]);
  return operationId;
}

function updateJournalPhase(db: Sqlite, operationId: string, phase: JournalPhase, timestamp: number): void {
  sqlRun(db, "UPDATE host_marketplace_operation_journal SET phase = ?, updated_at = ? WHERE operation_id = ?", [phase, timestamp, operationId]);
}

function fileResources(installations: InternalInstallation[]): InternalFileResource[] {
  return installations.flatMap((installation) => installation.resources.filter((resource): resource is InternalFileResource => resource.kind === "file"));
}

async function modifiedOwnedResources(root: string, installations: InternalInstallation[]): Promise<string[]> {
  const modified: string[] = [];
  for (const resource of fileResources(installations)) {
    const content = await readResource(root, resource.target);
    if (content === null || digest(content) !== resource.digest) modified.push(resource.target);
  }
  return modified.sort();
}

async function assertNoUnownedTargets(
  root: string,
  desired: InternalFileResource[],
  allowedOwners: InternalFileResource[],
  allowModifiedOwners = false,
): Promise<void> {
  const owners = new Map(allowedOwners.map((resource) => [resource.target, resource]));
  const conflicts: string[] = [];
  for (const resource of desired) {
    const current = await readResource(root, resource.target);
    if (current === null) continue;
    const owner = owners.get(resource.target);
    if (!owner || (!allowModifiedOwners && digest(current) !== owner.digest)) conflicts.push(resource.target);
  }
  if (conflicts.length > 0) {
    throw new HostMarketplacePluginError(409, "host_marketplace_ownership_conflict", "Global OpenCode resources already exist and are not owned by this installation.", { resources: conflicts.sort() });
  }
}

async function assertNoUnownedTargetsWithoutMutation(
  root: string,
  desired: InternalFileResource[],
  allowedOwners: InternalFileResource[],
): Promise<void> {
  const owners = new Map(allowedOwners.map((resource) => [resource.target, resource]));
  const conflicts: string[] = [];
  for (const resource of desired) {
    const current = await readResourceWithoutMutation(root, resource.target);
    if (current === null) continue;
    const owner = owners.get(resource.target);
    if (!owner || digest(current) !== owner.digest) conflicts.push(resource.target);
  }
  if (conflicts.length > 0) {
    throw new HostMarketplacePluginError(409, "host_marketplace_ownership_conflict", "Global OpenCode resources already exist and are not owned by this installation.", { resources: conflicts.sort() });
  }
}

function projectionChange(previous: InternalInstallation[], next: InternalInstallation[]): ProjectionChange {
  const previousPaths = new Set(fileResources(previous).map((resource) => resource.target));
  const nextFiles = fileResources(next);
  const writes = new Map(nextFiles.map((resource) => [resource.target, resource.content]));
  const nextPaths = new Set(writes.keys());
  return {
    writes,
    removals: new Set([...previousPaths].filter((path) => !nextPaths.has(path))),
  };
}

async function preparePackageCache(storageRoot: string, input: HostMarketplacePackage): Promise<{
  path: string;
  packageDigest: string;
  change: ProjectionChange;
}> {
  const packageJson = `${stableJson(input)}\n`;
  const packageDigest = digest(packageJson);
  const path = `host-marketplace/packages/${digest(input.pluginId).slice(0, 32)}/${digest(input.revision).slice(0, 32)}.json`;
  const existing = await readResource(storageRoot, path);
  if (existing !== null) {
    if (digest(existing) !== packageDigest) {
      throw new HostMarketplacePluginError(409, "host_marketplace_revision_conflict", "An immutable package revision was previously cached with different content.");
    }
    return { path, packageDigest, change: { writes: new Map(), removals: new Set() } };
  }
  return { path, packageDigest, change: { writes: new Map([[path, packageJson]]), removals: new Set() } };
}

function installationFromPackage(input: HostMarketplacePackage, resources: InternalResource[], cache: { path: string; packageDigest: string }, previous: InternalInstallation | null, now: number): InternalInstallation {
  return {
    pluginId: input.pluginId,
    marketplaceId: input.marketplaceId,
    name: input.name,
    description: input.description ?? null,
    packageRevision: input.revision,
    packageDigest: cache.packageDigest,
    status: "installed",
    resources,
    cachePath: cache.path,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
  };
}

export type HostMarketplacePluginRegistry = {
  list(scope: HostMarketplaceScope): Promise<HostMarketplaceRegistryList>;
  getActiveRegistry(): Promise<HostMarketplaceRegistryList | null>;
  getActiveScope(): Promise<HostMarketplaceScope | null>;
  getMcpOverlay(): Promise<Record<string, Record<string, unknown>>>;
  activateScope(context: HostMarketplaceMutationContext): Promise<HostMarketplaceMutationResult>;
  deactivateScope(context: HostMarketplaceMutationContext): Promise<HostMarketplaceMutationResult>;
  install(context: HostMarketplaceMutationContext, packageInput: HostMarketplacePackage): Promise<HostMarketplaceMutationResult>;
  update(context: HostMarketplaceMutationContext, packageInput: HostMarketplacePackage): Promise<HostMarketplaceMutationResult>;
  remove(context: HostMarketplaceMutationContext, pluginId: string): Promise<HostMarketplaceMutationResult>;
  validateMigrationPackage(packageInput: HostMarketplacePackage, authority?: object): Promise<{ packageDigest: string; resources: HostMarketplaceOwnedResource[] }>;
  snapshotMigrationState(packageInput: HostMarketplacePackage, authority: object): Promise<HostMarketplaceMigrationSnapshot>;
  stageMigrationPackage(packageInput: HostMarketplacePackage, authority: object): Promise<void>;
  installForMigration(context: HostMarketplaceMutationContext, packageInput: HostMarketplacePackage, authority: object): Promise<HostMarketplaceMutationResult>;
  restoreMigrationState(snapshot: HostMarketplaceMigrationSnapshot, authority: object): Promise<void>;
  withMigrationLock<T>(authority: object, operation: () => Promise<T>): Promise<T>;
  startupRecoverOperations(): Promise<void>;
  startupDeactivate(): Promise<void>;
  startupDeactivateAndRecover(): Promise<void>;
  close(): void;
};

export async function createHostMarketplacePluginRegistry(options: HostMarketplacePluginRegistryOptions): Promise<HostMarketplacePluginRegistry> {
  const databasePath = options.databasePath ?? (options.config ? runtimeDbPath(options.config) : null);
  const storageRoot = options.storageDirectory ?? (options.config ? runtimeStorageDir(options.config) : databasePath ? dirname(databasePath) : null);
  const globalRoot = options.globalOpenCodeDirectory ?? dirname(resolveGlobalOpenCodeConfigPath());
  if (!databasePath || !storageRoot) throw new HostMarketplacePluginError(500, "host_marketplace_registry_unavailable", "A runtime database and storage directory are required.");
  const resolvedStorageRoot = storageRoot;
  const db = await openRuntimeSqliteDatabase(databasePath);
  initializeDatabase(db);
  const now = options.now ?? Date.now;
  let mutationTail = Promise.resolve();
  let activeMigrationAuthority: object | null = null;

  async function recoverNonterminalOperations(): Promise<void> {
    for (const row of readJournalRows(db)) {
      let before: JournalBefore;
      try {
        before = JSON.parse(row.beforeJson) as JournalBefore;
      } catch (error) {
        throw new HostMarketplacePluginError(500, "host_marketplace_journal_corrupt", "Host Marketplace operation journal is corrupt.", {
          operationId: row.operationId,
          cause: errorMessage(error),
        });
      }
      updateJournalPhase(db, row.operationId, "rolling_back", now());
      await restoreFiles(globalRoot, new Map(before.globalFiles));
      await restoreFiles(resolvedStorageRoot, new Map(before.storageFiles));
      restoreDatabaseSnapshot(db, before.database, now());
      if (options.applyMcpOverlay) await options.applyMcpOverlay(before.overlay);
      sqlRun(db, "DELETE FROM host_marketplace_operation_journal WHERE operation_id = ?", [row.operationId]);
    }
  }

  function assertHostWritable(): void {
    if (options.managed === false || options.readOnly === true) {
      throw new HostMarketplacePluginError(409, "host_marketplace_mutation_unavailable", "This execution host is not a writable JuggleWork-managed runtime.");
    }
  }

  async function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  function serializeMigrationAuthorized<T>(authority: object | undefined, operation: () => Promise<T>): Promise<T> {
    return authority !== undefined && authority === activeMigrationAuthority ? operation() : serialize(operation);
  }

  async function runCompensatedMutation(input: {
    operation: "activate" | "deactivate" | "install" | "update" | "remove";
    idempotencyOperation?: string;
    idempotencyScopeKey: string;
    idempotencyKey?: string;
    requestDigest?: string;
    change: ProjectionChange;
    storageChange?: ProjectionChange;
    desiredOverlay: Record<string, Record<string, unknown>>;
    repairTargets: Array<{ key: string; record: InternalInstallation }>;
    mutateDatabase: () => number;
    result: (revision: number) => HostMarketplaceMutationResult;
  }): Promise<HostMarketplaceMutationResult> {
    const dbBefore = databaseSnapshot(db);
    const overlayBefore = options.readMcpOverlay
      ? await options.readMcpOverlay()
      : overlayForScope(db, dbBefore.meta.activeScopeKey);
    const paths = [...input.change.writes.keys(), ...input.change.removals];
    const filesBefore = await snapshotFiles(globalRoot, paths);
    const storageChange = input.storageChange ?? { writes: new Map(), removals: new Set() };
    const storagePaths = [...storageChange.writes.keys(), ...storageChange.removals];
    const storageBefore = await snapshotFiles(resolvedStorageRoot, storagePaths);
    const desiredOverlayFromDatabase = () => overlayForScope(db, readMeta(db).activeScopeKey);
    const journalBefore: JournalBefore = {
      database: dbBefore,
      globalFiles: snapshotJson(filesBefore),
      storageFiles: snapshotJson(storageBefore),
      overlay: overlayBefore,
    };
    const globalDesired = projectionJson(input.change);
    const storageDesired = projectionJson(storageChange);
    const operationId = writeJournal(db, input.operation, journalBefore, {
      globalWrites: globalDesired.writes,
      globalRemovals: globalDesired.removals,
      storageWrites: storageDesired.writes,
      storageRemovals: storageDesired.removals,
      overlay: input.desiredOverlay,
    }, now());
    let registryChanged = false;
    let engineAttempted = false;
    try {
      await applyProjection(resolvedStorageRoot, storageChange);
      await applyProjection(globalRoot, input.change);
      updateJournalPhase(db, operationId, "files_applied", now());
      await options.faultInjector?.("after_files");
      const revision = input.mutateDatabase();
      registryChanged = true;
      updateJournalPhase(db, operationId, "registry_applied", now());
      await options.faultInjector?.("after_registry");
      const overlay = desiredOverlayFromDatabase();
      if (options.applyMcpOverlay) {
        engineAttempted = true;
        await options.applyMcpOverlay(overlay);
      }
      updateJournalPhase(db, operationId, "overlay_applied", now());
      await options.faultInjector?.("after_engine");
      const result = input.result(revision);
      transaction(db, () => {
        if (input.idempotencyKey && input.requestDigest) {
          writeIdempotentResult(db, input.idempotencyScopeKey, input.idempotencyOperation ?? input.operation, input.idempotencyKey, input.requestDigest, result, now());
        }
        sqlRun(db, "DELETE FROM host_marketplace_operation_journal WHERE operation_id = ?", [operationId]);
      });
      return result;
    } catch (error) {
      if (error instanceof HostMarketplaceFailStopError) throw error;
      const rollbackFailures: Array<{ stage: string; message: string }> = [];
      updateJournalPhase(db, operationId, "rolling_back", now());
      try {
        await options.faultInjector?.("rollback_files");
        await restoreFiles(globalRoot, filesBefore);
        await restoreFiles(resolvedStorageRoot, storageBefore);
      } catch (rollbackError) {
        rollbackFailures.push({ stage: "files", message: errorMessage(rollbackError) });
      }
      if (registryChanged) {
        try {
          await options.faultInjector?.("rollback_registry");
          restoreDatabaseSnapshot(db, dbBefore, now());
        } catch (rollbackError) {
          rollbackFailures.push({ stage: "registry", message: errorMessage(rollbackError) });
        }
      }
      if (options.applyMcpOverlay && engineAttempted) {
        try {
          await options.faultInjector?.("rollback_engine");
          await options.applyMcpOverlay(overlayBefore);
        } catch (rollbackError) {
          rollbackFailures.push({ stage: "engine", message: errorMessage(rollbackError) });
        }
      }
      if (rollbackFailures.length > 0) {
        const recordedAt = now();
        try {
          transaction(db, () => {
            const targets = new Map(input.repairTargets.map((target) => [`${target.key}\0${target.record.pluginId}`, target]));
            for (const target of targets.values()) {
              const repairRecord: InternalInstallation = {
                ...target.record,
                status: "repair_required",
                updatedAt: recordedAt,
                repair: {
                  operation: input.operation,
                  cause: errorMessage(error),
                  resources: target.record.resources.map((resource) => resource.target).sort(),
                  rollbackFailures,
                  recordedAt,
                },
              };
              writeInstallation(db, target.key, repairRecord, recordedAt);
            }
            bumpRevision(db, recordedAt);
          });
        } catch (repairError) {
          rollbackFailures.push({ stage: "repair_registry", message: errorMessage(repairError) });
        }
        throw new HostMarketplacePluginError(500, "host_marketplace_repair_required", "Host Marketplace mutation failed and rollback was incomplete.", {
          status: "repair_required",
          operation: input.operation,
          cause: errorMessage(error),
          rollbackFailures,
        });
      }
      sqlRun(db, "DELETE FROM host_marketplace_operation_journal WHERE operation_id = ?", [operationId]);
      if (error instanceof HostMarketplacePluginError) throw error;
      throw new HostMarketplacePluginError(500, "host_marketplace_mutation_failed", "Host Marketplace mutation failed and the previous projection was restored.", {
        operation: input.operation,
        cause: errorMessage(error),
      });
    }
  }

  async function markRepairRequired(key: string, record: InternalInstallation, operation: HostMarketplaceRepair["operation"], resources: string[]): Promise<never> {
    const timestamp = now();
    const repaired: InternalInstallation = {
      ...record,
      status: "repair_required",
      updatedAt: timestamp,
      repair: {
        operation,
        cause: "Plugin-owned resources were modified after installation.",
        resources,
        recordedAt: timestamp,
      },
    };
    transaction(db, () => {
      writeInstallation(db, key, repaired, timestamp);
      bumpRevision(db, timestamp);
    });
    throw new HostMarketplacePluginError(409, "host_marketplace_repair_required", "Modified plugin-owned resources were preserved and the installation now requires repair.", {
      status: "repair_required",
      installation: publicInstallation(repaired),
      resources,
    });
  }

  async function assertMcpOverlayIntegrity(operation: HostMarketplaceRepair["operation"]): Promise<void> {
    const key = readMeta(db).activeScopeKey;
    const expected = overlayForScope(db, key);
    const actual = options.readMcpOverlay ? await options.readMcpOverlay() : expected;
    const drift = mcpOverlayDrift(actual, expected);
    if (drift.modified.length > 0 && key) {
      const owner = readInstallations(db, key).find((record) => record.resources.some((resource) =>
        resource.kind === "mcp" && drift.modified.includes(resource.target)));
      if (owner) return markRepairRequired(key, owner, operation, drift.modified);
    }
    if (drift.modified.length > 0 || drift.nonowned.length > 0) {
      throw new HostMarketplacePluginError(409, "host_marketplace_mcp_ownership_conflict", "The Server-owned Marketplace MCP overlay contains modified or nonowned entries.", {
        modified: drift.modified,
        nonowned: drift.nonowned,
      });
    }
  }

  async function prepareScopeDeactivation(
    installations: InternalInstallation[],
    currentOverlay: Record<string, Record<string, unknown>>,
    operation: "activate" | "deactivate",
    timestamp: number,
    cause: string,
  ): Promise<{
    change: ProjectionChange;
    storageChange: ProjectionChange;
    repairUpdates: Map<string, InternalInstallation>;
  }> {
    const removals = new Set<string>();
    const quarantineWrites = new Map<string, string>();
    const repairUpdates = new Map<string, InternalInstallation>();
    const quarantineId = `${timestamp}-${randomUUID()}`;
    const quarantineRoot = `host-marketplace/quarantine/${quarantineId}`;

    for (const installation of installations) {
      const modified = new Set(installation.repair?.resources ?? []);
      const entries: NonNullable<HostMarketplaceRepair["quarantine"]>["entries"] = [];

      for (const resource of installation.resources) {
        if (resource.kind === "mcp") {
          const actual = currentOverlay[resource.target];
          if (actual && digest(actual) === resource.digest) continue;

          const resourceName = `mcp:${resource.target}`;
          modified.add(resourceName);
          const markerPath = actual
            ? `${quarantineRoot}/mcp/${digest(resource.target).slice(0, 32)}.json`
            : `${quarantineRoot}/missing/${digest(resourceName).slice(0, 32)}.json`;
          quarantineWrites.set(markerPath, actual
            ? `${stableJson({ target: resource.target, config: actual })}\n`
            : `${stableJson({ target: resource.target, cause: "missing MCP overlay entry" })}\n`);
          entries.push({ resource: resourceName, kind: actual ? "mcp" : "missing", path: markerPath });
          continue;
        }

        let content: string | null;
        try {
          content = await readResource(globalRoot, resource.target);
        } catch (error) {
          if (!(error instanceof HostMarketplacePluginError) || error.code !== "host_marketplace_unsafe_path") throw error;
          modified.add(resource.target);
          const markerPath = `${quarantineRoot}/unsafe/${digest(resource.target).slice(0, 32)}.json`;
          quarantineWrites.set(markerPath, `${stableJson({ target: resource.target, cause: error.message })}\n`);
          entries.push({ resource: resource.target, kind: "unsafe", path: markerPath });
          // Do not traverse or unlink an untrusted ancestor. Clearing the scope and overlay
          // still prevents the registry from treating this path as an active projection.
          continue;
        }

        if (content === null) {
          modified.add(resource.target);
          const markerPath = `${quarantineRoot}/missing/${digest(resource.target).slice(0, 32)}.json`;
          quarantineWrites.set(markerPath, `${stableJson({ target: resource.target, cause: "missing" })}\n`);
          entries.push({ resource: resource.target, kind: "missing", path: markerPath });
          continue;
        }

        removals.add(resource.target);
        if (digest(content) === resource.digest) continue;
        modified.add(resource.target);
        const quarantinePath = `${quarantineRoot}/files/${resource.target}`;
        quarantineWrites.set(quarantinePath, content);
        entries.push({ resource: resource.target, kind: "file", path: quarantinePath });
      }

      if (entries.length === 0) continue;
      repairUpdates.set(installation.pluginId, {
        ...installation,
        status: "repair_required",
        updatedAt: timestamp,
        repair: {
          operation,
          cause,
          resources: [...modified].sort(),
          quarantine: {
            id: quarantineId,
            root: quarantineRoot,
            entries: entries.sort((left, right) => left.resource.localeCompare(right.resource)),
          },
          recordedAt: timestamp,
        },
      });
    }

    return {
      change: { writes: new Map(), removals },
      storageChange: { writes: quarantineWrites, removals: new Set() },
      repairUpdates,
    };
  }

  async function mutatePackage(
    _requestedOperation: "install" | "update",
    context: HostMarketplaceMutationContext,
    rawPackage: HostMarketplacePackage,
    migrationAuthority?: object,
  ): Promise<HostMarketplaceMutationResult> {
    return serializeMigrationAuthorized(migrationAuthority, async () => {
      assertHostWritable();
      const packageInput = validatePackage(rawPackage);
      const checked = assertMutationContext(db, context);
      const requestDigest = digest({ context: { scope: checked.scope, expectedRevision: context.expectedRevision }, package: packageInput });
      const repeated = readIdempotentResult(db, checked.key, "put", context.idempotencyKey, requestDigest);
      if (repeated) return repeated;
      assertExpectedRevision(checked.meta, context.expectedRevision);

      const previous = readInstallation(db, checked.key, packageInput.pluginId);
      const operation = previous ? "update" : "install";

      if (packageIsCloudOnly(packageInput)) {
        if (previous) {
          await assertMcpOverlayIntegrity(operation);
          const modified = await modifiedOwnedResources(globalRoot, [previous]);
          if (modified.length > 0) return markRepairRequired(checked.key, previous, operation, modified);
          const timestamp = now();
          const change = projectionChange([previous], []);
          const nextInstallations = readInstallations(db, checked.key).filter((record) => record.pluginId !== packageInput.pluginId);
          return runCompensatedMutation({
            operation,
            idempotencyOperation: "put",
            idempotencyScopeKey: checked.key,
            idempotencyKey: context.idempotencyKey,
            requestDigest,
            change,
            desiredOverlay: overlayFromInstallations(nextInstallations),
            repairTargets: [{ key: checked.key, record: previous }],
            mutateDatabase: () => transaction(db, () => {
              sqlRun(db, "DELETE FROM host_marketplace_installations WHERE scope_key = ? AND plugin_id = ?", [checked.key, packageInput.pluginId]);
              return bumpRevision(db, timestamp);
            }),
            result: (revision) => ({
              operation: "cloud_only",
              changed: true,
              registryRevision: revision,
              activeScope: checked.scope,
              installation: null,
              mcpOverlay: overlayFromInstallations(nextInstallations),
            }),
          });
        }
        const result: HostMarketplaceMutationResult = {
          operation: "cloud_only",
          changed: false,
          registryRevision: checked.meta.registryRevision,
          activeScope: checked.scope,
          installation: null,
          mcpOverlay: overlayForScope(db, checked.key),
        };
        writeIdempotentResult(db, checked.key, "put", context.idempotencyKey, requestDigest, result, now());
        return result;
      }

      await assertMcpOverlayIntegrity(operation);

      if (previous) {
        if (previous.packageRevision === packageInput.revision && previous.packageDigest === digest(`${stableJson(packageInput)}\n`) && previous.status === "installed") {
          const result: HostMarketplaceMutationResult = {
            operation,
            changed: false,
            registryRevision: checked.meta.registryRevision,
            activeScope: checked.scope,
            installation: publicInstallation(previous),
            mcpOverlay: overlayForScope(db, checked.key),
          };
          writeIdempotentResult(db, checked.key, "put", context.idempotencyKey, requestDigest, result, now());
          return result;
        }
      }
      const workspaceConflicts = migrationAuthority === options.migrationAuthority
        ? []
        : await options.findWorkspaceConflicts?.(packageInput.pluginId) ?? [];
      if (workspaceConflicts.length > 0) {
        throw new HostMarketplacePluginError(409, "host_marketplace_workspace_copy_conflict", "An existing workspace installation must remain workspace-scoped and cannot be promoted.", { workspaces: workspaceConflicts });
      }
      if (previous) {
        const modified = await modifiedOwnedResources(globalRoot, [previous]);
        if (modified.length > 0) return markRepairRequired(checked.key, previous, operation, modified);
      }
      const resources = buildResources(packageInput);
      const cache = await preparePackageCache(resolvedStorageRoot, packageInput);
      const timestamp = now();
      const next = installationFromPackage(packageInput, resources, cache, previous, timestamp);
      await assertNoUnownedTargets(globalRoot, fileResources([next]), previous ? fileResources([previous]) : []);
      const change = projectionChange(previous ? [previous] : [], [next]);
      return runCompensatedMutation({
        operation,
        idempotencyOperation: "put",
        idempotencyScopeKey: checked.key,
        idempotencyKey: context.idempotencyKey,
        requestDigest,
        change,
        storageChange: cache.change,
        desiredOverlay: overlayFromInstallations([
          ...readInstallations(db, checked.key).filter((record) => record.pluginId !== packageInput.pluginId),
          next,
        ]),
        repairTargets: [{ key: checked.key, record: next }],
        mutateDatabase: () => transaction(db, () => {
          upsertScope(db, checked.scope, timestamp);
          writeInstallation(db, checked.key, next, timestamp);
          return bumpRevision(db, timestamp);
        }),
        result: (revision) => ({
          operation,
          changed: true,
          registryRevision: revision,
          activeScope: checked.scope,
          installation: publicInstallation(next),
          mcpOverlay: overlayForScope(db, checked.key),
        }),
      });
    });
  }

  return {
    async list(rawScope) {
      const scope = normalizeScope(rawScope);
      const key = scopeKey(scope);
      const meta = readMeta(db);
      return {
        schemaVersion: meta.schemaVersion,
        registryRevision: meta.registryRevision,
        scope,
        active: meta.activeScopeKey === key,
        installations: readInstallations(db, key).map(publicInstallation),
      };
    },

    async getActiveScope() {
      return activeScope(db);
    },

    async getActiveRegistry() {
      const meta = readMeta(db);
      if (!meta.activeScopeKey) return null;
      const row = readScopeRow(db, meta.activeScopeKey);
      if (!row) return null;
      return {
        schemaVersion: meta.schemaVersion,
        registryRevision: meta.registryRevision,
        scope: scopeFromRow(row),
        active: true,
        installations: readInstallations(db, meta.activeScopeKey).map(publicInstallation),
      };
    },

    async getMcpOverlay() {
      const meta = readMeta(db);
      return overlayForScope(db, meta.activeScopeKey);
    },

    async startupRecoverOperations() {
      return serialize(recoverNonterminalOperations);
    },

    async startupDeactivate() {
      return serialize(async () => {
        const meta = readMeta(db);
        if (!meta.activeScopeKey) {
          if (options.applyMcpOverlay) await options.applyMcpOverlay({});
          return;
        }

        const previous = readInstallations(db, meta.activeScopeKey);
        const currentOverlay = options.readMcpOverlay
          ? await options.readMcpOverlay()
          : overlayFromInstallations(previous);
        const timestamp = now();
        const deactivation = await prepareScopeDeactivation(
          previous,
          currentOverlay,
          "deactivate",
          timestamp,
          "Startup quarantined plugin-owned resources modified after installation.",
        );
        await runCompensatedMutation({
          operation: "deactivate",
          idempotencyScopeKey: meta.activeScopeKey,
          change: deactivation.change,
          storageChange: deactivation.storageChange,
          desiredOverlay: {},
          repairTargets: previous.map((record) => ({ key: meta.activeScopeKey!, record })),
          mutateDatabase: () => transaction(db, () => {
            for (const record of deactivation.repairUpdates.values()) writeInstallation(db, meta.activeScopeKey!, record, timestamp);
            return bumpRevision(db, timestamp, null);
          }),
          result: (revision) => ({
            operation: "deactivate",
            changed: true,
            registryRevision: revision,
            activeScope: null,
            installation: null,
            mcpOverlay: {},
          }),
        });
      });
    },

    async startupDeactivateAndRecover() {
      await serialize(async () => {
        await recoverNonterminalOperations();
      });
      await serialize(async () => {
        const meta = readMeta(db);
        if (!meta.activeScopeKey) {
          if (options.applyMcpOverlay) await options.applyMcpOverlay({});
          return;
        }
        const previous = readInstallations(db, meta.activeScopeKey);
        const currentOverlay = options.readMcpOverlay ? await options.readMcpOverlay() : overlayFromInstallations(previous);
        const timestamp = now();
        const deactivation = await prepareScopeDeactivation(previous, currentOverlay, "deactivate", timestamp,
          "Startup quarantined plugin-owned resources modified after installation.");
        await runCompensatedMutation({
          operation: "deactivate",
          idempotencyScopeKey: meta.activeScopeKey,
          change: deactivation.change,
          storageChange: deactivation.storageChange,
          desiredOverlay: {},
          repairTargets: previous.map((record) => ({ key: meta.activeScopeKey!, record })),
          mutateDatabase: () => transaction(db, () => {
            for (const record of deactivation.repairUpdates.values()) writeInstallation(db, meta.activeScopeKey!, record, timestamp);
            return bumpRevision(db, timestamp, null);
          }),
          result: (revision) => ({ operation: "deactivate", changed: true, registryRevision: revision, activeScope: null, installation: null, mcpOverlay: {} }),
        });
      });
    },

    async activateScope(context) {
      return serialize(async () => {
        assertHostWritable();
        const checked = assertMutationContext(db, context, false);
        const requestDigest = digest({ scope: checked.scope, expectedRevision: context.expectedRevision });
        const repeated = readIdempotentResult(db, checked.key, "activate", context.idempotencyKey, requestDigest);
        if (repeated) return repeated;
        assertExpectedRevision(checked.meta, context.expectedRevision);
        if (checked.meta.activeScopeKey === checked.key) {
          const result: HostMarketplaceMutationResult = {
            operation: "activate",
            changed: false,
            registryRevision: checked.meta.registryRevision,
            activeScope: checked.scope,
            installation: null,
            mcpOverlay: overlayForScope(db, checked.key),
          };
          writeIdempotentResult(db, checked.key, "activate", context.idempotencyKey, requestDigest, result, now());
          return result;
        }
        const previous = checked.meta.activeScopeKey ? readInstallations(db, checked.meta.activeScopeKey) : [];
        const previousScopeKey = checked.meta.activeScopeKey;
        const next = readInstallations(db, checked.key);
        if (next.some((record) => record.status === "repair_required")) {
          throw new HostMarketplacePluginError(409, "host_marketplace_repair_required", "Repair-required installations block identity scope activation.");
        }
        const timestamp = now();
        const currentOverlay = options.readMcpOverlay
          ? await options.readMcpOverlay()
          : overlayFromInstallations(previous);
        const deactivation = await prepareScopeDeactivation(
          previous,
          currentOverlay,
          "activate",
          timestamp,
          "Scope activation quarantined modified resources from the previous identity scope.",
        );
        await assertNoUnownedTargets(globalRoot, fileResources(next), fileResources(previous), true);
        const nextFiles = fileResources(next);
        const change: ProjectionChange = {
          writes: new Map(nextFiles.map((resource) => [resource.target, resource.content])),
          removals: new Set([...deactivation.change.removals].filter((path) => !nextFiles.some((resource) => resource.target === path))),
        };
        return runCompensatedMutation({
          operation: "activate",
          idempotencyScopeKey: checked.key,
          idempotencyKey: context.idempotencyKey,
          requestDigest,
          change,
          storageChange: deactivation.storageChange,
          desiredOverlay: overlayFromInstallations(next),
          repairTargets: [
            ...(checked.meta.activeScopeKey ? previous.map((record) => ({ key: checked.meta.activeScopeKey!, record })) : []),
            ...next.map((record) => ({ key: checked.key, record })),
          ],
          mutateDatabase: () => transaction(db, () => {
            if (previousScopeKey) {
              for (const record of deactivation.repairUpdates.values()) writeInstallation(db, previousScopeKey, record, timestamp);
            }
            upsertScope(db, checked.scope, timestamp);
            return bumpRevision(db, timestamp, checked.key);
          }),
          result: (revision) => ({
            operation: "activate",
            changed: true,
            registryRevision: revision,
            activeScope: checked.scope,
            installation: null,
            mcpOverlay: overlayForScope(db, checked.key),
          }),
        });
      });
    },

    async deactivateScope(context) {
      return serialize(async () => {
        assertHostWritable();
        const checked = assertMutationContext(db, context, false);
        const requestDigest = digest({ scope: checked.scope, expectedRevision: context.expectedRevision });
        const repeated = readIdempotentResult(db, checked.key, "deactivate", context.idempotencyKey, requestDigest);
        if (repeated) return repeated;
        if (checked.meta.activeScopeKey !== checked.key) {
          throw new HostMarketplacePluginError(409, "host_marketplace_scope_inactive", "The requested identity scope is not active on this host.");
        }
        assertExpectedRevision(checked.meta, context.expectedRevision);
        const previous = readInstallations(db, checked.key);
        const timestamp = now();
        const currentOverlay = options.readMcpOverlay
          ? await options.readMcpOverlay()
          : overlayFromInstallations(previous);
        const deactivation = await prepareScopeDeactivation(
          previous,
          currentOverlay,
          "deactivate",
          timestamp,
          "Scope deactivation quarantined plugin-owned resources modified after installation.",
        );
        return runCompensatedMutation({
          operation: "deactivate",
          idempotencyScopeKey: checked.key,
          idempotencyKey: context.idempotencyKey,
          requestDigest,
          change: deactivation.change,
          storageChange: deactivation.storageChange,
          desiredOverlay: {},
          repairTargets: previous.map((record) => ({ key: checked.key, record })),
          mutateDatabase: () => transaction(db, () => {
            for (const record of deactivation.repairUpdates.values()) writeInstallation(db, checked.key, record, timestamp);
            return bumpRevision(db, timestamp, null);
          }),
          result: (revision) => ({
            operation: "deactivate",
            changed: true,
            registryRevision: revision,
            activeScope: null,
            installation: null,
            mcpOverlay: {},
          }),
        });
      });
    },

    install(context, packageInput) {
      return mutatePackage("install", context, packageInput);
    },

    update(context, packageInput) {
      return mutatePackage("update", context, packageInput);
    },

    async validateMigrationPackage(rawPackage, authority) {
      return serializeMigrationAuthorized(authority, async () => {
        const packageInput = validatePackage(rawPackage);
        const resources = buildResources(packageInput);
        const meta = readMeta(db);
        const previous = meta.activeScopeKey ? readInstallation(db, meta.activeScopeKey, packageInput.pluginId) : null;
        if (previous?.status === "repair_required") {
          throw new HostMarketplacePluginError(409, "host_marketplace_repair_required", "The host installation requires repair before migration.");
        }
        if (previous) {
          const drifted: string[] = [];
          const overlay = options.readMcpOverlay ? await options.readMcpOverlay() : overlayForScope(db, meta.activeScopeKey);
          for (const resource of previous.resources) {
            if (resource.kind === "mcp") {
              if (!overlay[resource.target] || digest(overlay[resource.target]) !== resource.digest) drifted.push(`mcp:${resource.target}`);
              continue;
            }
            const content = await readResourceWithoutMutation(globalRoot, resource.target);
            if (content === null || digest(content) !== resource.digest) drifted.push(resource.target);
          }
          if (drifted.length > 0) {
            throw new HostMarketplacePluginError(409, "host_marketplace_repair_required", "Modified or missing host-owned resources block migration.", { resources: drifted.sort() });
          }
        }
        await assertNoUnownedTargetsWithoutMutation(globalRoot, resources.filter((resource): resource is InternalFileResource => resource.kind === "file"), previous ? fileResources([previous]) : []);
        return {
          packageDigest: digest(`${stableJson(packageInput)}\n`),
          resources: resources.map(({ kind, componentId, target, digest: resourceDigest }) => ({ kind, componentId, target, digest: resourceDigest })),
        };
      });
    },

    async snapshotMigrationState(rawPackage, authority) {
      if (!options.migrationAuthority || authority !== options.migrationAuthority) {
        throw new HostMarketplacePluginError(403, "host_marketplace_migration_authority_required", "Internal migration authority is required.");
      }
      return serializeMigrationAuthorized(authority, async () => {
        const packageInput = validatePackage(rawPackage);
        const resources = buildResources(packageInput);
        const meta = readMeta(db);
        const previous = meta.activeScopeKey ? readInstallation(db, meta.activeScopeKey, packageInput.pluginId) : null;
        const fileTargets = [
          ...resources.filter((resource): resource is InternalFileResource => resource.kind === "file").map((resource) => resource.target),
          ...(previous ? fileResources([previous]).map((resource) => resource.target) : []),
        ];
        const packageJson = `${stableJson(packageInput)}\n`;
        const cachePath = `host-marketplace/packages/${digest(packageInput.pluginId).slice(0, 32)}/${digest(packageInput.revision).slice(0, 32)}.json`;
        return {
          packageDigest: digest(packageJson),
          database: databaseSnapshot(db),
          globalFiles: snapshotJson(await snapshotFilesWithoutMutation(globalRoot, fileTargets)),
          storageFiles: snapshotJson(await snapshotFilesWithoutMutation(resolvedStorageRoot, [cachePath])),
          overlay: options.readMcpOverlay ? await options.readMcpOverlay() : overlayForScope(db, readMeta(db).activeScopeKey),
        };
      });
    },

    async stageMigrationPackage(rawPackage, authority) {
      if (!options.migrationAuthority || authority !== options.migrationAuthority) {
        throw new HostMarketplacePluginError(403, "host_marketplace_migration_authority_required", "Internal migration authority is required.");
      }
      await serializeMigrationAuthorized(authority, async () => {
        const packageInput = validatePackage(rawPackage);
        const cache = await preparePackageCache(resolvedStorageRoot, packageInput);
        await applyProjection(resolvedStorageRoot, cache.change);
      });
    },

    installForMigration(context, packageInput, authority) {
      if (!options.migrationAuthority || authority !== options.migrationAuthority) {
        return Promise.reject(new HostMarketplacePluginError(403, "host_marketplace_migration_authority_required", "Internal migration authority is required."));
      }
      return mutatePackage("install", context, packageInput, authority);
    },

    async restoreMigrationState(snapshot, authority) {
      if (!options.migrationAuthority || authority !== options.migrationAuthority) {
        throw new HostMarketplacePluginError(403, "host_marketplace_migration_authority_required", "Internal migration authority is required.");
      }
      await serializeMigrationAuthorized(authority, async () => {
        await restoreFiles(globalRoot, new Map(snapshot.globalFiles));
        await restoreFiles(resolvedStorageRoot, new Map(snapshot.storageFiles));
        restoreDatabaseSnapshot(db, snapshot.database, now());
        if (options.applyMcpOverlay) await options.applyMcpOverlay(snapshot.overlay);
      });
    },

    async withMigrationLock(authority, operation) {
      if (!options.migrationAuthority || authority !== options.migrationAuthority) {
        throw new HostMarketplacePluginError(403, "host_marketplace_migration_authority_required", "Internal migration authority is required.");
      }
      return serialize(async () => {
        activeMigrationAuthority = authority;
        try {
          return await operation();
        } finally {
          activeMigrationAuthority = null;
        }
      });
    },

    async remove(context, pluginId) {
      return serialize(async () => {
        assertHostWritable();
        assertBoundedString(pluginId, "pluginId");
        const checked = assertMutationContext(db, context);
        const requestDigest = digest({ scope: checked.scope, expectedRevision: context.expectedRevision, pluginId });
        const repeated = readIdempotentResult(db, checked.key, "remove", context.idempotencyKey, requestDigest);
        if (repeated) return repeated;
        assertExpectedRevision(checked.meta, context.expectedRevision);
        await assertMcpOverlayIntegrity("remove");
        const record = readInstallation(db, checked.key, pluginId);
        if (!record) throw new HostMarketplacePluginError(404, "host_marketplace_not_installed", "Marketplace package is not installed in this host scope.");
        const modified = await modifiedOwnedResources(globalRoot, [record]);
        if (modified.length > 0) return markRepairRequired(checked.key, record, "remove", modified);
        const change = projectionChange([record], []);
        const timestamp = now();
        return runCompensatedMutation({
          operation: "remove",
          idempotencyScopeKey: checked.key,
          idempotencyKey: context.idempotencyKey,
          requestDigest,
          change,
          desiredOverlay: overlayFromInstallations(readInstallations(db, checked.key).filter((candidate) => candidate.pluginId !== pluginId)),
          repairTargets: [{ key: checked.key, record }],
          mutateDatabase: () => transaction(db, () => {
            sqlRun(db, "DELETE FROM host_marketplace_installations WHERE scope_key = ? AND plugin_id = ?", [checked.key, pluginId]);
            return bumpRevision(db, timestamp);
          }),
          result: (revision) => ({
            operation: "remove",
            changed: true,
            registryRevision: revision,
            activeScope: checked.scope,
            installation: null,
            mcpOverlay: overlayForScope(db, checked.key),
          }),
        });
      });
    },

    close() {
      db.close();
    },
  };
}

/** Convenience constructor for server composition without exposing path policy to routes. */
export function hostMarketplacePluginRegistryOptions(config: ServerConfig): HostMarketplacePluginRegistryOptions {
  return {
    config,
    databasePath: runtimeDbPath(config),
    storageDirectory: runtimeStorageDir(config),
    globalOpenCodeDirectory: dirname(resolveGlobalOpenCodeConfigPath()),
    managed: config.managedRuntime === true,
    readOnly: config.readOnly,
  };
}
