/**
 * Durable storage for session permission modes, reusable grants, and the
 * sanitized security-decision ledger.
 *
 * See openspec/changes/add-session-permission-modes (design.md) for the
 * authority model:
 *
 * - One row per (workspace, authoritative root session) holds the requested
 *   mode, its effective fail-closed evaluation inputs, the authorizing human
 *   principal, and a shared authority revision that every mode/grant mutation
 *   advances so stale automatic decisions lose revalidation races.
 * - Grants are JuggleWork-owned records; they never rely on protocol-native
 *   OpenCode `always` persistence.
 * - Decision units pair a durable intent with one terminal outcome; retention
 *   prunes completed units atomically and keeps unresolved/indeterminate units
 *   until reconciliation.
 */

import {
  SESSION_PERMISSION_DECISION_RESOURCE_SUMMARY_MAX,
  SESSION_PERMISSION_DECISION_RETENTION_COUNT,
  SESSION_PERMISSION_DECISION_RETENTION_MS,
  SESSION_PERMISSION_DECISION_SCHEMA,
  SESSION_PERMISSION_GRANT_SCHEMA,
  SESSION_PERMISSION_MODE_SCHEMA,
  SESSION_PERMISSION_PROFILE_VERSION,
  SESSION_PERMISSION_RESOURCE_MAX_COUNT,
  SESSION_PERMISSION_RESOURCE_MAX_LENGTH,
  type SessionPermissionAuthorizingPrincipal,
  type SessionPermissionDecisionActor,
  type SessionPermissionDecisionKind,
  type SessionPermissionDecisionOutcome,
  type SessionPermissionDecisionRecord,
  type SessionPermissionEffectiveMode,
  type SessionPermissionGrantProtocol,
  type SessionPermissionGrantRecord,
  type SessionPermissionGrantState,
  type SessionPermissionModeChoice,
  type SessionPermissionModeState,
} from "@jugglework/types/session-permission-modes";
import type { AutomationSqlite } from "./automation/sqlite.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { shortId } from "./utils.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

type ModeRow = {
  workspace_id: string;
  root_session_id: string;
  requested_mode: SessionPermissionModeChoice;
  profile_version: number;
  acknowledged_version: number | null;
  author_principal_id: string | null;
  author_principal_scope: "owner" | "collaborator" | null;
  authority_revision: number;
  suspended: number;
  activated_at: number | null;
  created_at: number;
  updated_at: number;
};

type GrantRow = {
  id: string;
  workspace_id: string;
  root_session_id: string;
  protocol: SessionPermissionGrantProtocol;
  permission_action: string;
  resources_json: string;
  profile_version: number;
  state: SessionPermissionGrantState;
  author_principal_id: string;
  author_principal_scope: "owner" | "collaborator";
  source_request_id: string;
  source_target_session_id: string;
  exclusion_json: string;
  invalidation_reason: string | null;
  created_at: number;
  updated_at: number;
};

type DecisionRow = {
  id: string;
  workspace_id: string;
  root_session_id: string | null;
  target_session_id: string | null;
  kind: SessionPermissionDecisionKind;
  outcome: SessionPermissionDecisionOutcome;
  resources_json: string;
  actor_origin: "renderer" | "broker" | "system" | null;
  actor_id: string | null;
  profile_version: number;
  authority_revision: number | null;
  request_id: string | null;
  created_at: number;
  resolved_at: number | null;
};

type ExclusionRow = {
  workspace_id: string;
  root_session_id: string;
  source: string;
  request_id: string;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Sanitization (task 5.2)
// ---------------------------------------------------------------------------

/** Bounded, deduplicated resource list. Never persists raw metadata. */
export function sanitizeSessionPermissionResources(resources: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of resources) {
    if (typeof raw !== "string") continue;
    const bounded = raw.length > SESSION_PERMISSION_RESOURCE_MAX_LENGTH
      ? raw.slice(0, SESSION_PERMISSION_RESOURCE_MAX_LENGTH)
      : raw;
    if (!bounded || seen.has(bounded)) continue;
    seen.add(bounded);
    out.push(bounded);
    if (out.length >= SESSION_PERMISSION_RESOURCE_MAX_COUNT) break;
  }
  return out;
}

/** Bounded summary for decision records (tighter cap than grant resources). */
export function sanitizeDecisionResourceSummary(resources: readonly string[]): string[] {
  return sanitizeSessionPermissionResources(resources)
    .slice(0, SESSION_PERMISSION_DECISION_RESOURCE_SUMMARY_MAX);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type UpdateModeInput = {
  workspaceId: string;
  rootSessionId: string;
  requestedMode: SessionPermissionModeChoice;
  expectedRevision: number;
  acknowledgementProfileVersion: number | null;
  authorizingPrincipal: SessionPermissionAuthorizingPrincipal | null;
  /** Request identities present at the activation boundary (arming snapshot). */
  activationExclusionRequestIds: string[];
  now: number;
};

export type InsertGrantInput = {
  workspaceId: string;
  rootSessionId: string;
  protocol: SessionPermissionGrantProtocol;
  permissionAction: string;
  resources: string[];
  authorizingPrincipal: SessionPermissionAuthorizingPrincipal;
  sourceRequestId: string;
  sourceTargetSessionId: string;
  exclusionRequestIds: string[];
  now: number;
};

export type DecisionIntentInput = {
  workspaceId: string;
  rootSessionId: string | null;
  targetSessionId: string | null;
  kind: SessionPermissionDecisionKind;
  resourceSummary: string[];
  actor: SessionPermissionDecisionActor | null;
  authorityRevision: number | null;
  requestId: string | null;
  now: number;
};

function migrateSessionPermissionTables(database: AutomationSqlite): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_permission_modes (
      workspace_id TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      requested_mode TEXT NOT NULL CHECK (requested_mode IN ('request-approval','full-access')),
      profile_version INTEGER NOT NULL,
      acknowledged_version INTEGER,
      author_principal_id TEXT,
      author_principal_scope TEXT CHECK (author_principal_scope IN ('owner','collaborator') OR author_principal_scope IS NULL),
      authority_revision INTEGER NOT NULL CHECK (authority_revision >= 0),
      suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
      activated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, root_session_id)
    );
    CREATE TABLE IF NOT EXISTS session_permission_grants (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK (protocol IN ('legacy','v2')),
      permission_action TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      profile_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','dispatching','active','failed','indeterminate')),
      author_principal_id TEXT NOT NULL,
      author_principal_scope TEXT NOT NULL CHECK (author_principal_scope IN ('owner','collaborator')),
      source_request_id TEXT NOT NULL,
      source_target_session_id TEXT NOT NULL,
      exclusion_json TEXT NOT NULL,
      invalidation_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_permission_grants_root
      ON session_permission_grants(workspace_id, root_session_id, state);
    CREATE TABLE IF NOT EXISTS session_permission_exclusions (
      workspace_id TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, root_session_id, source, request_id)
    );
    CREATE TABLE IF NOT EXISTS session_permission_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      root_session_id TEXT,
      target_session_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('mode-change','grant-create','grant-remove','auto-approve','policy-blocked')),
      outcome TEXT NOT NULL CHECK (outcome IN ('pending','succeeded','failed','indeterminate')),
      resources_json TEXT NOT NULL,
      actor_origin TEXT CHECK (actor_origin IN ('renderer','broker','system') OR actor_origin IS NULL),
      actor_id TEXT,
      profile_version INTEGER NOT NULL,
      authority_revision INTEGER,
      request_id TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_session_permission_decisions_workspace
      ON session_permission_decisions(workspace_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_session_permission_decisions_request
      ON session_permission_decisions(workspace_id, kind, request_id);
  `);
}

/** Fail-closed effective-mode evaluation for a persisted mode row. */
export function computeEffectiveMode(row: {
  requested_mode: SessionPermissionModeChoice;
  profile_version: number;
  acknowledged_version: number | null;
  suspended: number;
}): SessionPermissionEffectiveMode {
  if (row.requested_mode !== "full-access") return "request-approval";
  if (row.suspended === 1) return "full-access-suspended";
  // Exactly-supported check: older, future, unknown, malformed, or mismatched
  // profile/acknowledgement pairs must resolve to paused (rollback-safe).
  if (
    !Number.isSafeInteger(row.profile_version) ||
    row.profile_version !== SESSION_PERMISSION_PROFILE_VERSION ||
    !Number.isSafeInteger(row.acknowledged_version ?? NaN) ||
    row.acknowledged_version !== SESSION_PERMISSION_PROFILE_VERSION
  ) {
    return "full-access-paused";
  }
  return "full-access";
}

/** Grants fail closed on any version other than the exactly-supported one. */
export function grantProfileVersionSupported(version: number): boolean {
  return Number.isSafeInteger(version) && version === SESSION_PERMISSION_PROFILE_VERSION;
}

function modeRowToState(row: ModeRow): SessionPermissionModeState {
  return {
    schema: SESSION_PERMISSION_MODE_SCHEMA,
    workspaceId: row.workspace_id,
    rootSessionId: row.root_session_id,
    requestedMode: row.requested_mode,
    effectiveMode: computeEffectiveMode(row),
    profileVersion: row.profile_version,
    acknowledgedProfileVersion: row.acknowledged_version,
    authorizingPrincipal: row.author_principal_id && row.author_principal_scope
      ? { id: row.author_principal_id, scope: row.author_principal_scope }
      : null,
    authorityRevision: row.authority_revision,
    activatedAt: row.activated_at,
    updatedAt: row.updated_at,
  };
}

function grantRowToRecord(row: GrantRow): SessionPermissionGrantRecord {
  const resources = safeParseStringArray(row.resources_json);
  const exclusions = safeParseStringArray(row.exclusion_json);
  const effectiveState: SessionPermissionGrantState =
    row.invalidation_reason !== null && row.state !== "failed" && row.state !== "indeterminate"
      ? "failed"
      : row.state;
  return {
    schema: SESSION_PERMISSION_GRANT_SCHEMA,
    id: row.id,
    workspaceId: row.workspace_id,
    rootSessionId: row.root_session_id,
    protocol: row.protocol,
    permissionAction: row.permission_action,
    resources,
    profileVersion: row.profile_version,
    state: effectiveState,
    authorizingPrincipal: {
      id: row.author_principal_id,
      scope: row.author_principal_scope,
    },
    sourceRequestId: row.source_request_id,
    sourceTargetSessionId: row.source_target_session_id,
    exclusionRequestIds: exclusions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decisionRowToRecord(row: DecisionRow): SessionPermissionDecisionRecord {
  return {
    schema: SESSION_PERMISSION_DECISION_SCHEMA,
    id: row.id,
    workspaceId: row.workspace_id,
    rootSessionId: row.root_session_id,
    targetSessionId: row.target_session_id,
    kind: row.kind,
    outcome: row.outcome,
    resourceSummary: safeParseStringArray(row.resources_json),
    actor: row.actor_origin ? { origin: row.actor_origin, id: row.actor_id } : null,
    profileVersion: row.profile_version,
    authorityRevision: row.authority_revision,
    requestId: row.request_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export class SessionPermissionModeStore {
  private constructor(private readonly database: AutomationSqlite) {}

  static async open(config: ServerConfig): Promise<SessionPermissionModeStore> {
    const runtimeDb = await openRuntimeSqliteDatabase(runtimeDbPath(config));
    return SessionPermissionModeStore.fromDatabase(
      // Reuse the automation adapter shape (Bun/Node driver normalization).
      (await import("./automation/sqlite.js")).automationSqliteAdapter(runtimeDb),
    );
  }

  static fromDatabase(database: AutomationSqlite): SessionPermissionModeStore {
    migrateSessionPermissionTables(database);
    return new SessionPermissionModeStore(database);
  }

  close(): void {
    this.database.close();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  readModeState(workspaceId: string, rootSessionId: string): SessionPermissionModeState | null {
    const row = this.database.get<ModeRow>(
      `SELECT * FROM session_permission_modes WHERE workspace_id = ? AND root_session_id = ?`,
      [workspaceId, rootSessionId],
    );
    return row ? modeRowToState(row) : null;
  }

  readAuthorityRevision(workspaceId: string, rootSessionId: string): number {
    const row = this.database.get<{ authority_revision: number }>(
      `SELECT authority_revision FROM session_permission_modes WHERE workspace_id = ? AND root_session_id = ?`,
      [workspaceId, rootSessionId],
    );
    return row?.authority_revision ?? 0;
  }

  listGrants(workspaceId: string, rootSessionId: string): SessionPermissionGrantRecord[] {
    const rows = this.database.all<GrantRow>(
      `SELECT * FROM session_permission_grants WHERE workspace_id = ? AND root_session_id = ? ORDER BY created_at DESC, id DESC`,
      [workspaceId, rootSessionId],
    );
    return rows.map(grantRowToRecord);
  }

  getGrant(grantId: string): SessionPermissionGrantRecord | null {
    const row = this.database.get<GrantRow>(
      `SELECT * FROM session_permission_grants WHERE id = ?`,
      [grantId],
    );
    return row ? grantRowToRecord(row) : null;
  }

  /** Roots whose effective mode is active full-access (broker polling set). */
  listActiveFullAccessRoots(workspaceId: string): string[] {
    const rows = this.database.all<ModeRow>(
      `SELECT * FROM session_permission_modes WHERE workspace_id = ? AND requested_mode = 'full-access'`,
      [workspaceId],
    );
    return rows
      .filter((row) => computeEffectiveMode(row) === "full-access")
      .map((row) => row.root_session_id);
  }

  /** Roots with at least one active, version-supported grant (broker polling set). */
  listGrantRoots(workspaceId: string): string[] {
    const rows = this.database.all<{ root_session_id: string }>(
      `SELECT DISTINCT root_session_id FROM session_permission_grants
       WHERE workspace_id = ? AND state = 'active' AND profile_version = ?
         AND invalidation_reason IS NULL`,
      [workspaceId, SESSION_PERMISSION_PROFILE_VERSION],
    );
    return rows.map((row) => row.root_session_id);
  }

  listActiveGrants(workspaceId: string, rootSessionId: string): SessionPermissionGrantRecord[] {
    const rows = this.database.all<GrantRow>(
      `SELECT * FROM session_permission_grants
       WHERE workspace_id = ? AND root_session_id = ? AND state = 'active'
         AND invalidation_reason IS NULL`,
      [workspaceId, rootSessionId],
    );
    return rows
      .filter((row) => grantProfileVersionSupported(row.profile_version))
      .map(grantRowToRecord);
  }

  /** All grants authored by a principal in a workspace (for invalidation sweeps). */
  listGrantsByPrincipal(workspaceId: string, principalId: string): GrantRow[] {
    return this.database.all<GrantRow>(
      `SELECT * FROM session_permission_grants
       WHERE workspace_id = ? AND author_principal_id = ? AND state IN ('pending','dispatching','active')`,
      [workspaceId, principalId],
    );
  }

  /** Full-access rows authored by a principal (for durable suspension). */
  listFullAccessByPrincipal(workspaceId: string, principalId: string): ModeRow[] {
    return this.database.all<ModeRow>(
      `SELECT * FROM session_permission_modes
       WHERE workspace_id = ? AND author_principal_id = ? AND requested_mode = 'full-access' AND suspended = 0`,
      [workspaceId, principalId],
    );
  }

  listExcludedRequestIds(workspaceId: string, rootSessionId: string): Set<string> {
    const rows = this.database.all<ExclusionRow>(
      `SELECT * FROM session_permission_exclusions WHERE workspace_id = ? AND root_session_id = ?`,
      [workspaceId, rootSessionId],
    );
    return new Set(rows.map((row) => row.request_id));
  }

  // -------------------------------------------------------------------------
  // Mode mutation (compare-and-set with arming data)
  // -------------------------------------------------------------------------

  updateMode(input: UpdateModeInput):
    | { ok: true; state: SessionPermissionModeState; clearedGrantIds: string[] }
    | { ok: false; error: "stale-revision" } {
    return this.database.transaction(() => {
      const existing = this.database.get<ModeRow>(
        `SELECT * FROM session_permission_modes WHERE workspace_id = ? AND root_session_id = ?`,
        [input.workspaceId, input.rootSessionId],
      );
      const currentRevision = existing?.authority_revision ?? 0;
      if (input.expectedRevision !== currentRevision) {
        return { ok: false, error: "stale-revision" } as const;
      }

      let clearedGrantIds: string[] = [];
      if (input.requestedMode === "full-access") {
        // Activation: replace the mode-activation exclusion set with the arming
        // snapshot contents, then commit the effective mode.
        this.database.run(
          `DELETE FROM session_permission_exclusions
           WHERE workspace_id = ? AND root_session_id = ? AND source = 'mode-activation'`,
          [input.workspaceId, input.rootSessionId],
        );
        for (const requestId of new Set(input.activationExclusionRequestIds)) {
          if (typeof requestId !== "string" || !requestId) continue;
          this.database.run(
            `INSERT OR IGNORE INTO session_permission_exclusions
             (workspace_id, root_session_id, source, request_id, created_at) VALUES (?, ?, 'mode-activation', ?, ?)`,
            [input.workspaceId, input.rootSessionId, requestId, input.now],
          );
        }
        this.database.run(
          `INSERT INTO session_permission_modes
             (workspace_id, root_session_id, requested_mode, profile_version, acknowledged_version,
              author_principal_id, author_principal_scope, authority_revision, suspended, activated_at, created_at, updated_at)
           VALUES (?, ?, 'full-access', ?, ?, ?, ?, ?, 0, ?, ?, ?)
           ON CONFLICT(workspace_id, root_session_id) DO UPDATE SET
             requested_mode = 'full-access',
             profile_version = excluded.profile_version,
             acknowledged_version = excluded.acknowledged_version,
             author_principal_id = excluded.author_principal_id,
             author_principal_scope = excluded.author_principal_scope,
             authority_revision = excluded.authority_revision,
             suspended = 0,
             activated_at = excluded.activated_at,
             updated_at = excluded.updated_at`,
          [
            input.workspaceId,
            input.rootSessionId,
            SESSION_PERMISSION_PROFILE_VERSION,
            input.acknowledgementProfileVersion,
            input.authorizingPrincipal?.id ?? null,
            input.authorizingPrincipal?.scope ?? null,
            currentRevision + 1,
            input.now,
            existing?.created_at ?? input.now,
            input.now,
          ],
        );
      } else {
        // Downgrade: unconditionally clear grants and all exclusions for the
        // root in the same authority-revision transaction.
        clearedGrantIds = this.clearGrantsInternal(input.workspaceId, input.rootSessionId, input.now);
        if (existing) {
          this.database.run(
            `UPDATE session_permission_modes SET
               requested_mode = 'request-approval',
               author_principal_id = NULL,
               author_principal_scope = NULL,
               authority_revision = ?,
               suspended = 0,
               updated_at = ?
             WHERE workspace_id = ? AND root_session_id = ?`,
            [currentRevision + 1, input.now, input.workspaceId, input.rootSessionId],
          );
        }
      }

      const state = this.readModeState(input.workspaceId, input.rootSessionId);
      if (!state) throw new Error("session permission mode state missing after update");
      return { ok: true, state, clearedGrantIds } as const;
    });
  }

  /** Durable suspension when the authorizing principal loses authority. */
  suspendFullAccessForPrincipal(
    workspaceId: string,
    rootSessionId: string,
    now: number,
  ): SessionPermissionModeState | null {
    return this.database.transaction(() => {
      const existing = this.database.get<ModeRow>(
        `SELECT * FROM session_permission_modes
         WHERE workspace_id = ? AND root_session_id = ? AND requested_mode = 'full-access' AND suspended = 0`,
        [workspaceId, rootSessionId],
      );
      if (!existing) return null;
      this.database.run(
        `UPDATE session_permission_modes SET suspended = 1, authority_revision = ?, updated_at = ?
         WHERE workspace_id = ? AND root_session_id = ?`,
        [existing.authority_revision + 1, now, workspaceId, rootSessionId],
      );
      return this.readModeState(workspaceId, rootSessionId);
    });
  }

  /** Durable grant invalidation (author lost authority). */
  invalidateGrantsForPrincipal(workspaceId: string, principalId: string, now: number): string[] {
    return this.database.transaction(() => {
      const rows = this.listGrantsByPrincipal(workspaceId, principalId);
      const invalidated: string[] = [];
      for (const row of rows) {
        this.database.run(
          `UPDATE session_permission_grants
           SET invalidation_reason = 'author-authority-lost', state = 'failed', updated_at = ?
           WHERE id = ?`,
          [now, row.id],
        );
        invalidated.push(row.id);
      }
      // Grant invalidation advances each affected root's authority revision.
      const roots = new Set(rows.map((row) => row.root_session_id));
      for (const rootSessionId of roots) {
        this.bumpAuthorityRevision(workspaceId, rootSessionId, now);
      }
      return invalidated;
    });
  }

  private bumpAuthorityRevision(workspaceId: string, rootSessionId: string, now: number): void {
    const existing = this.database.get<{ authority_revision: number }>(
      `SELECT authority_revision FROM session_permission_modes WHERE workspace_id = ? AND root_session_id = ?`,
      [workspaceId, rootSessionId],
    );
    if (!existing) return;
    this.database.run(
      `UPDATE session_permission_modes SET authority_revision = ?, updated_at = ?
       WHERE workspace_id = ? AND root_session_id = ?`,
      [existing.authority_revision + 1, now, workspaceId, rootSessionId],
    );
  }

  // -------------------------------------------------------------------------
  // Grant lifecycle (task 3.5 state machine storage)
  // -------------------------------------------------------------------------

  insertPendingGrant(input: InsertGrantInput): SessionPermissionGrantRecord {
    return this.database.transaction(() => {
      const id = `spg_${shortId()}`;
      const resources = sanitizeSessionPermissionResources(input.resources);
      const exclusions = [...new Set(input.exclusionRequestIds)].filter((item) => typeof item === "string" && item);
      this.database.run(
        `INSERT INTO session_permission_grants
           (id, workspace_id, root_session_id, protocol, permission_action, resources_json, profile_version,
            state, author_principal_id, author_principal_scope, source_request_id, source_target_session_id,
            exclusion_json, invalidation_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          id,
          input.workspaceId,
          input.rootSessionId,
          input.protocol,
          input.permissionAction,
          JSON.stringify(resources),
          SESSION_PERMISSION_PROFILE_VERSION,
          input.authorizingPrincipal.id,
          input.authorizingPrincipal.scope,
          input.sourceRequestId,
          input.sourceTargetSessionId,
          JSON.stringify(exclusions),
          input.now,
          input.now,
        ],
      );
      for (const requestId of exclusions) {
        this.database.run(
          `INSERT OR IGNORE INTO session_permission_exclusions
           (workspace_id, root_session_id, source, request_id, created_at) VALUES (?, ?, ?, ?, ?)`,
          [input.workspaceId, input.rootSessionId, id, requestId, input.now],
        );
      }
      this.bumpAuthorityRevision(input.workspaceId, input.rootSessionId, input.now);
      const record = this.getGrant(id);
      if (!record) throw new Error("session permission grant missing after insert");
      return record;
    });
  }

  transitionGrant(
    grantId: string,
    next: SessionPermissionGrantState,
    now: number,
    options?: { invalidationReason?: string },
  ): SessionPermissionGrantRecord | null {
    this.database.run(
      `UPDATE session_permission_grants SET state = ?, updated_at = ?,
         invalidation_reason = COALESCE(?, invalidation_reason)
       WHERE id = ?`,
      [next, now, options?.invalidationReason ?? null, grantId],
    );
    return this.getGrant(grantId);
  }

  clearGrants(workspaceId: string, rootSessionId: string, now: number): string[] {
    return this.database.transaction(() => this.clearGrantsInternal(workspaceId, rootSessionId, now));
  }

  private clearGrantsInternal(workspaceId: string, rootSessionId: string, now: number): string[] {
    const rows = this.database.all<{ id: string }>(
      `SELECT id FROM session_permission_grants WHERE workspace_id = ? AND root_session_id = ?`,
      [workspaceId, rootSessionId],
    );
    const ids = rows.map((row) => row.id);
    this.database.run(
      `DELETE FROM session_permission_grants WHERE workspace_id = ? AND root_session_id = ?`,
      [workspaceId, rootSessionId],
    );
    this.database.run(
      `DELETE FROM session_permission_exclusions WHERE workspace_id = ? AND root_session_id = ?`,
      [workspaceId, rootSessionId],
    );
    this.bumpAuthorityRevision(workspaceId, rootSessionId, now);
    return ids;
  }

  /**
   * Startup reconciliation: grants stuck in `dispatching` from an interrupted
   * process become `indeterminate` (inactive, never retried) — fail closed.
   */
  reconcileInterruptedGrants(now: number): string[] {
    const rows = this.database.all<{ id: string }>(
      `SELECT id FROM session_permission_grants WHERE state IN ('pending','dispatching')`,
    );
    const reconciled: string[] = [];
    for (const row of rows) {
      this.transitionGrant(row.id, "indeterminate", now, { invalidationReason: "interrupted" });
      reconciled.push(row.id);
    }
    return reconciled;
  }

  // -------------------------------------------------------------------------
  // Security-decision ledger (tasks 5.1/5.3)
  // -------------------------------------------------------------------------

  appendDecisionIntent(input: DecisionIntentInput): SessionPermissionDecisionRecord {
    const id = `spd_${shortId()}`;
    const resources = sanitizeDecisionResourceSummary(input.resourceSummary);
    this.database.run(
      `INSERT INTO session_permission_decisions
         (id, workspace_id, root_session_id, target_session_id, kind, outcome, resources_json,
          actor_origin, actor_id, profile_version, authority_revision, request_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        input.workspaceId,
        input.rootSessionId,
        input.targetSessionId,
        input.kind,
        JSON.stringify(resources),
        input.actor?.origin ?? null,
        input.actor?.id ?? null,
        SESSION_PERMISSION_PROFILE_VERSION,
        input.authorityRevision,
        input.requestId,
        input.now,
      ],
    );
    const record = this.readDecision(id);
    if (!record) throw new Error("session permission decision missing after insert");
    return record;
  }

  resolveDecision(id: string, outcome: Exclude<SessionPermissionDecisionOutcome, "pending">, now: number): void {
    this.database.run(
      `UPDATE session_permission_decisions SET outcome = ?, resolved_at = ? WHERE id = ?`,
      [outcome, now, id],
    );
  }

  readDecision(id: string): SessionPermissionDecisionRecord | null {
    const row = this.database.get<DecisionRow>(
      `SELECT * FROM session_permission_decisions WHERE id = ?`,
      [id],
    );
    return row ? decisionRowToRecord(row) : null;
  }

  hasPolicyBlockedDecision(workspaceId: string, requestId: string): boolean {
    const row = this.database.get<{ id: string }>(
      `SELECT id FROM session_permission_decisions
       WHERE workspace_id = ? AND kind = 'policy-blocked' AND request_id = ? LIMIT 1`,
      [workspaceId, requestId],
    );
    return Boolean(row);
  }

  /**
   * Startup reconciliation: decisions stuck in `pending` from an interrupted
   * process become `indeterminate` — we cannot know whether dispatch landed,
   * and indeterminate units stay retained until a human reviews them.
   */
  reconcileInterruptedDecisions(now: number): number {
    const rows = this.database.all<{ id: string }>(
      `SELECT id FROM session_permission_decisions WHERE outcome = 'pending'`,
    );
    for (const row of rows) {
      this.resolveDecision(row.id, "indeterminate", now);
    }
    return rows.length;
  }

  hasPendingDecisionForRequest(workspaceId: string, requestId: string): boolean {
    const row = this.database.get<{ id: string }>(
      `SELECT id FROM session_permission_decisions
       WHERE workspace_id = ? AND kind = 'auto-approve' AND request_id = ? AND outcome IN ('pending','indeterminate') LIMIT 1`,
      [workspaceId, requestId],
    );
    return Boolean(row);
  }

  /**
   * Retention: prune completed decision units (intent+outcome atomically) per
   * workspace — at most RETENTION_COUNT completed units, none older than
   * RETENTION_MS. Unresolved and indeterminate units are never pruned.
   */
  pruneWorkspaceDecisions(workspaceId: string, now: number): number {
    return this.database.transaction(() => {
      const ageResult = this.database.run(
        `DELETE FROM session_permission_decisions
         WHERE workspace_id = ? AND outcome IN ('succeeded','failed') AND resolved_at IS NOT NULL
           AND resolved_at < ?`,
        [workspaceId, now - SESSION_PERMISSION_DECISION_RETENTION_MS],
      );
      let pruned = ageResult.changes;
      const countRow = this.database.get<{ total: number }>(
        `SELECT COUNT(*) AS total FROM session_permission_decisions
         WHERE workspace_id = ? AND outcome IN ('succeeded','failed')`,
        [workspaceId],
      );
      const total = countRow?.total ?? 0;
      if (total > SESSION_PERMISSION_DECISION_RETENTION_COUNT) {
        const excess = total - SESSION_PERMISSION_DECISION_RETENTION_COUNT;
        this.database.run(
          `DELETE FROM session_permission_decisions WHERE id IN (
             SELECT id FROM session_permission_decisions
             WHERE workspace_id = ? AND outcome IN ('succeeded','failed')
             ORDER BY created_at ASC, id ASC LIMIT ?
           )`,
          [workspaceId, excess],
        );
        pruned += excess;
      }
      return pruned;
    });
  }

  // -------------------------------------------------------------------------
  // Session lifecycle cleanup (task 2.6)
  // -------------------------------------------------------------------------

  deleteRootSessionRecords(workspaceId: string, rootSessionId: string): void {
    this.database.transaction(() => {
      this.database.run(
        `DELETE FROM session_permission_modes WHERE workspace_id = ? AND root_session_id = ?`,
        [workspaceId, rootSessionId],
      );
      this.database.run(
        `DELETE FROM session_permission_grants WHERE workspace_id = ? AND root_session_id = ?`,
        [workspaceId, rootSessionId],
      );
      this.database.run(
        `DELETE FROM session_permission_exclusions WHERE workspace_id = ? AND root_session_id = ?`,
        [workspaceId, rootSessionId],
      );
    });
  }

  listWorkspaceRoots(workspaceId: string): string[] {
    const modeRoots = this.database.all<{ root_session_id: string }>(
      `SELECT root_session_id FROM session_permission_modes WHERE workspace_id = ?`,
      [workspaceId],
    );
    const grantRoots = this.database.all<{ root_session_id: string }>(
      `SELECT DISTINCT root_session_id FROM session_permission_grants WHERE workspace_id = ?`,
      [workspaceId],
    );
    return [...new Set([...modeRoots, ...grantRoots].map((row) => row.root_session_id))];
  }
}
