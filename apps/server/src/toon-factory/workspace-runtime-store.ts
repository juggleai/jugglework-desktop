import { randomUUID } from "node:crypto";
import type {
  ToonAssistantCanvasProposalRecord,
  ToonAssistantConversation,
  ToonAssistantEditResendRequest,
  ToonAssistantInteraction,
  ToonAssistantMessage,
  ToonAssistantStreamEvent,
  ToonSessionVisibility,
} from "@jugglework/types/toon-assistant";
import type { ToonMediaJobRequestSnapshot, ToonModelPolicySnapshot, ToonModelReference } from "@jugglework/types/toon-factory";
import type { ToonGenerationAuthorizationState, ToonWorkspaceOperationOutcome } from "@jugglework/types/toon-workspace";
import { automationSqliteAdapter, type AutomationSqlite } from "../automation/sqlite.js";
import { ApiError } from "../errors.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { migrateToonWorkspaceRuntimeDatabase } from "./workspace-runtime-migrations.js";

export type ToonWorkspaceJournalRecord = {
  workspaceScope: string;
  projectId: string;
  operationId: string;
  payloadHash: string;
  state: "prepared" | "committing" | "committed" | "terminal";
  terminalStatus?: string;
  journal: Record<string, unknown>;
};

export type ToonWorkspaceToolCallRecord = {
  id: string;
  conversationId: string;
  turnId?: string;
  sessionId?: string;
  operationId?: string;
  state: string;
  executionState?: string;
  proposal?: unknown;
  result?: unknown;
};

export type ToonWorkspaceActiveTurn = {
  workspaceScope: string;
  projectId: string;
  conversationId: string;
  sessionId: string;
  turnId: string;
  branchId: string;
};

export type ToonWorkspacePendingAssistantReplacement = {
  workspaceScope: string;
  projectId: string;
  conversationId: string;
  replacementTurnId: string;
  waitingForTurnId: string;
  branchId: string;
  sourceMessageId: string;
  request: ToonAssistantEditResendRequest;
};

export type ToonWorkspaceAssistantBranchRecord = {
  branchId: string;
  rootSessionId: string;
  sourceMessageId: string | null;
  replayContext: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ToonWorkspaceGenerationLink = {
  workspaceScope: string;
  projectId: string;
  generationId: string;
  runtimeJobId: string;
  canvasId: string | null;
  nodeId: string | null;
};

export type ToonWorkspaceRuntimeMediaJob = {
  id: string;
  requestId: string;
  requestHash: string;
  canvasId: string;
  nodeId: string;
  workflowRecordId: string;
};

export type ToonWorkspaceAuthorization = {
  authorizationId: string;
  principalId: string;
  workspaceScope: string;
  projectId: string;
  generationId: string;
  requestHash: string;
  requestSnapshot: ToonMediaJobRequestSnapshot;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  runtimeJobId: string | null;
};

export type ToonWorkspaceCleanupPolicy = {
  now?: number;
  completedJournalGraceMs: number;
  unavailableMappingGraceMs: number;
  assistantEventGraceMs: number;
  retainedAssistantEvents: number;
};

export type ToonWorkspaceCleanupResult = {
  leases: number;
  journals: number;
  mappings: number;
  events: number;
};

export type ToonWorkspaceStoredModelPolicy = {
  snapshot: ToonModelPolicySnapshot;
  updatedAt: number;
  staleAt: number;
};

export type ToonWorkspaceConversationCleanupSession = {
  sessionId: string;
  parentSessionId: string | null;
  depth: number;
  kind: "root" | "child";
  state: "pending" | "deleted" | "not_found";
  abortAttempts: number;
  deleteAttempts: number;
  lastError: string | null;
};

export type ToonWorkspaceConversationCleanup = {
  workspaceScope: string;
  projectId: string;
  conversationId: string;
  lastError: string | null;
  updatedAt: number;
  sessions: ToonWorkspaceConversationCleanupSession[];
};

type JournalRow = {
  workspace_scope: string;
  project_id: string;
  operation_id: string;
  payload_hash: string;
  state: ToonWorkspaceJournalRecord["state"];
  terminal_status: string | null;
  journal_json: string;
};

export class ToonWorkspaceRuntimeStore {
  private constructor(private readonly database: AutomationSqlite) {}

  static async open(config: ServerConfig): Promise<ToonWorkspaceRuntimeStore> {
    return ToonWorkspaceRuntimeStore.fromDatabase(
      automationSqliteAdapter(await openRuntimeSqliteDatabase(runtimeDbPath(config))),
    );
  }

  static fromDatabase(database: AutomationSqlite): ToonWorkspaceRuntimeStore {
    migrateToonWorkspaceRuntimeDatabase(database);
    return new ToonWorkspaceRuntimeStore(database);
  }

  close(): void { this.database.close(); }

  listModelPolicies(): ToonWorkspaceStoredModelPolicy[] {
    return this.database.all<{ workspace_scope: string; revision: number; digest: string; payload: string; updated_at: number; stale_at: number }>(
      "SELECT workspace_scope, revision, digest, payload, updated_at, stale_at FROM toon_workspace_model_policies ORDER BY workspace_scope",
    ).flatMap((row) => {
      try {
        const snapshot = JSON.parse(row.payload) as ToonModelPolicySnapshot;
        if (snapshot.workspaceId !== row.workspace_scope || snapshot.revision !== row.revision || snapshot.digest !== row.digest) return [];
        return [{ snapshot, updatedAt: row.updated_at, staleAt: row.stale_at }];
      } catch {
        return [];
      }
    });
  }

  saveModelPolicy(snapshot: ToonModelPolicySnapshot, staleAt: number, updatedAt = Date.now()): void {
    this.database.transaction(() => {
      const current = this.database.get<{ revision: number; digest: string }>(
        "SELECT revision, digest FROM toon_workspace_model_policies WHERE workspace_scope = ?",
        [snapshot.workspaceId],
      );
      if (current && snapshot.revision < current.revision) {
        throw new ApiError(409, "toon_model_policy_revision_stale", "The desktop model policy update is older than the persisted workspace policy");
      }
      if (current && snapshot.revision === current.revision && snapshot.digest !== current.digest) {
        throw new ApiError(409, "toon_model_policy_revision_conflict", "The desktop model policy revision is already bound to different persisted content");
      }
      this.database.run(`INSERT INTO toon_workspace_model_policies(workspace_scope, revision, digest, payload, updated_at, stale_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_scope) DO UPDATE SET
        revision=excluded.revision, digest=excluded.digest, payload=excluded.payload,
        updated_at=excluded.updated_at, stale_at=excluded.stale_at`,
      [snapshot.workspaceId, snapshot.revision, snapshot.digest, JSON.stringify(snapshot), updatedAt, staleAt]);
    });
  }

  createConversation(input: {
    workspaceScope: string; projectId: string; conversationId: string; sessionId: string;
    title: string; model: ToonModelReference; now?: number;
  }): ToonAssistantConversation {
    const now = input.now ?? Date.now();
    this.database.transaction(() => {
      this.database.run(`INSERT INTO toon_workspace_conversations(workspace_scope, project_id, conversation_id, session_id, visibility, parent_conversation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'toon_project_assistant', NULL, ?, ?)`, [input.workspaceScope, input.projectId, input.conversationId, input.sessionId, now, now]);
      this.database.run(`INSERT INTO toon_workspace_conversation_details(workspace_scope, project_id, conversation_id, title, archived, model_json, active_turn_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)`, [input.workspaceScope, input.projectId, input.conversationId, input.title, JSON.stringify(input.model), now, now]);
      this.database.run(`INSERT INTO toon_workspace_session_lineage(workspace_scope, project_id, session_id, parent_session_id, visibility)
        VALUES (?, ?, ?, NULL, 'toon_project_assistant')`, [input.workspaceScope, input.projectId, input.sessionId]);
    });
    return this.requireConversation(input.workspaceScope, input.projectId, input.conversationId);
  }

  listConversations(workspaceScope: string, projectId: string, includeArchived = false): ToonAssistantConversation[] {
    const rows = this.database.all<{ conversation_id: string; title: string; archived: number; model_json: string; created_at: number; updated_at: number; cleanup_updated_at: number | null; cleanup_last_error: string | null; cleanup_total: number; cleanup_completed: number }>(`SELECT c.conversation_id, d.title, d.archived, d.model_json, d.created_at, d.updated_at,
        cleanup.updated_at AS cleanup_updated_at, cleanup.last_error AS cleanup_last_error,
        (SELECT COUNT(*) FROM toon_workspace_conversation_cleanup_sessions s WHERE s.workspace_scope=c.workspace_scope AND s.project_id=c.project_id AND s.conversation_id=c.conversation_id) AS cleanup_total,
        (SELECT COUNT(*) FROM toon_workspace_conversation_cleanup_sessions s WHERE s.workspace_scope=c.workspace_scope AND s.project_id=c.project_id AND s.conversation_id=c.conversation_id AND s.state IN ('deleted','not_found')) AS cleanup_completed
      FROM toon_workspace_conversations c JOIN toon_workspace_conversation_details d
      ON d.workspace_scope = c.workspace_scope AND d.project_id = c.project_id AND d.conversation_id = c.conversation_id
      LEFT JOIN toon_workspace_conversation_cleanups cleanup ON cleanup.workspace_scope=c.workspace_scope AND cleanup.project_id=c.project_id AND cleanup.conversation_id=c.conversation_id
      WHERE c.workspace_scope = ? AND c.project_id = ? AND c.visibility = 'toon_project_assistant' ${includeArchived ? "" : "AND (d.archived = 0 OR cleanup.conversation_id IS NOT NULL)"}
      ORDER BY d.updated_at DESC`, [workspaceScope, projectId]);
    return rows.map((row) => ({ id: row.conversation_id, projectId, title: row.title, model: JSON.parse(row.model_json) as ToonModelReference, visibility: "toon_project_assistant", archived: row.archived === 1,
      state: row.cleanup_updated_at === null ? "active" as const : "deleting" as const,
      cleanup: row.cleanup_updated_at === null ? null : { pending: true as const, totalSessions: row.cleanup_total, completedSessions: row.cleanup_completed, lastError: row.cleanup_last_error, updatedAt: new Date(row.cleanup_updated_at).toISOString() },
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }));
  }

  requireConversation(workspaceScope: string, projectId: string, conversationId: string): ToonAssistantConversation {
    const item = this.listConversations(workspaceScope, projectId, true).find((conversation) => conversation.id === conversationId);
    if (!item) throw new ApiError(404, "toon_conversation_not_found", "Project assistant conversation not found");
    return item;
  }

  conversationSession(workspaceScope: string, projectId: string, conversationId: string): string {
    const row = this.database.get<{ session_id: string }>(`SELECT session_id FROM toon_workspace_conversations
      WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ? AND visibility = 'toon_project_assistant'`, [workspaceScope, projectId, conversationId]);
    if (!row) throw new ApiError(404, "toon_conversation_not_found", "Project assistant conversation not found");
    return row.session_id;
  }

  conversationForSession(workspaceScope: string, sessionId: string): { projectId: string; conversationId: string; rootSessionId: string } | null {
    let current = sessionId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const direct = this.database.get<{ project_id: string; conversation_id: string; session_id: string }>(
        "SELECT project_id, conversation_id, session_id FROM toon_workspace_conversations WHERE workspace_scope = ? AND session_id = ? AND visibility = 'toon_project_assistant'",
        [workspaceScope, current],
      );
      if (direct) return { projectId: direct.project_id, conversationId: direct.conversation_id, rootSessionId: direct.session_id };
      const lineage = this.database.get<{ parent_session_id: string | null; visibility: ToonSessionVisibility }>(
        "SELECT parent_session_id, visibility FROM toon_workspace_session_lineage WHERE workspace_scope = ? AND session_id = ?",
        [workspaceScope, current],
      );
      if (!lineage || lineage.visibility !== "toon_project_subagent" || !lineage.parent_session_id) {
        const owner = this.database.get<{ project_id: string; conversation_id: string }>(`SELECT project_id, conversation_id FROM toon_workspace_turn_sessions
          WHERE workspace_scope=? AND session_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1`, [workspaceScope, sessionId]);
        if (!owner) return null;
        return { projectId: owner.project_id, conversationId: owner.conversation_id, rootSessionId: this.conversationSession(workspaceScope, owner.project_id, owner.conversation_id) };
      }
      current = lineage.parent_session_id;
    }
    return null;
  }

  replaceConversationSession(workspaceScope: string, projectId: string, conversationId: string, sessionId: string, now = Date.now()): void {
    this.requireConversation(workspaceScope, projectId, conversationId);
    this.database.transaction(() => {
      this.database.run("UPDATE toon_workspace_conversations SET session_id=?, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [sessionId, now, workspaceScope, projectId, conversationId]);
      this.database.run("UPDATE toon_workspace_conversation_details SET isolation_required=0, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [now, workspaceScope, projectId, conversationId]);
      this.database.run(`INSERT INTO toon_workspace_session_lineage(workspace_scope, project_id, session_id, parent_session_id, visibility)
        VALUES (?, ?, ?, NULL, 'toon_project_assistant') ON CONFLICT(workspace_scope, project_id, session_id)
        DO UPDATE SET parent_session_id=NULL, visibility='toon_project_assistant'`, [workspaceScope, projectId, sessionId]);
    });
  }

  conversationModel(workspaceScope: string, projectId: string, conversationId: string): ToonModelReference {
    const row = this.database.get<{ model_json: string }>(`SELECT model_json FROM toon_workspace_conversation_details WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ?`, [workspaceScope, projectId, conversationId]);
    if (!row) throw new ApiError(404, "toon_conversation_not_found", "Project assistant conversation not found");
    return JSON.parse(row.model_json) as ToonModelReference;
  }

  updateConversation(workspaceScope: string, projectId: string, conversationId: string, input: { title?: string; archived?: boolean }, now = Date.now()): ToonAssistantConversation {
    this.assertConversationMutable(workspaceScope, projectId, conversationId);
    if (input.title !== undefined) this.database.run(`UPDATE toon_workspace_conversation_details SET title = ?, updated_at = ? WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ?`, [input.title, now, workspaceScope, projectId, conversationId]);
    if (input.archived !== undefined) this.database.run(`UPDATE toon_workspace_conversation_details SET archived = ?, updated_at = ? WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ?`, [input.archived ? 1 : 0, now, workspaceScope, projectId, conversationId]);
    return this.requireConversation(workspaceScope, projectId, conversationId);
  }

  deleteConversation(workspaceScope: string, projectId: string, conversationId: string): string {
    const sessionId = this.conversationSession(workspaceScope, projectId, conversationId);
    this.database.transaction(() => {
      this.database.run(`DELETE FROM toon_workspace_session_lineage WHERE workspace_scope=? AND project_id=? AND session_id IN (
        SELECT session_id FROM toon_workspace_conversation_cleanup_sessions WHERE workspace_scope=? AND project_id=? AND conversation_id=?)`, [workspaceScope, projectId, workspaceScope, projectId, conversationId]);
      for (const table of ["toon_workspace_assistant_events", "toon_workspace_assistant_messages", "toon_workspace_assistant_interactions", "toon_workspace_pending_assistant_replacements", "toon_workspace_assistant_branches", "toon_workspace_turn_sessions", "toon_workspace_assistant_turns", "toon_workspace_tool_calls", "toon_workspace_conversation_details", "toon_workspace_event_cursors"]) {
        this.database.run(`DELETE FROM ${table} WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ?`, [workspaceScope, projectId, conversationId]);
      }
      this.database.run("DELETE FROM toon_workspace_session_lineage WHERE workspace_scope = ? AND project_id = ? AND (session_id = ? OR parent_session_id = ?)", [workspaceScope, projectId, sessionId, sessionId]);
      this.database.run("DELETE FROM toon_workspace_conversations WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ?", [workspaceScope, projectId, conversationId]);
      this.database.run("DELETE FROM toon_workspace_conversation_cleanup_sessions WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [workspaceScope, projectId, conversationId]);
      this.database.run("DELETE FROM toon_workspace_conversation_cleanups WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [workspaceScope, projectId, conversationId]);
    });
    return sessionId;
  }

  assertConversationMutable(workspaceScope: string, projectId: string, conversationId: string): ToonAssistantConversation {
    const conversation = this.requireConversation(workspaceScope, projectId, conversationId);
    if (conversation.state === "deleting") throw new ApiError(409, "toon_assistant_cleanup_pending", "The project conversation is deleting; cleanup will retry in the background");
    return conversation;
  }

  beginConversationCleanup(workspaceScope: string, projectId: string, conversationId: string, sessions: Array<{ sessionId: string; parentSessionId: string | null; depth: number; kind: "root" | "child" }>, now = Date.now()): ToonWorkspaceConversationCleanup {
    this.requireConversation(workspaceScope, projectId, conversationId);
    this.database.transaction(() => {
      this.database.run(`INSERT INTO toon_workspace_conversation_cleanups(workspace_scope, project_id, conversation_id, state, last_error, created_at, updated_at)
        VALUES (?, ?, ?, 'deleting', NULL, ?, ?) ON CONFLICT(workspace_scope, project_id, conversation_id) DO UPDATE SET updated_at=excluded.updated_at`, [workspaceScope, projectId, conversationId, now, now]);
      this.addConversationCleanupSessions(workspaceScope, projectId, conversationId, sessions, now);
    });
    return this.requireConversationCleanup(workspaceScope, projectId, conversationId);
  }

  addConversationCleanupSessions(workspaceScope: string, projectId: string, conversationId: string, sessions: Array<{ sessionId: string; parentSessionId: string | null; depth: number; kind: "root" | "child" }>, now = Date.now()): void {
    for (const session of sessions) this.database.run(`INSERT INTO toon_workspace_conversation_cleanup_sessions(
      workspace_scope, project_id, conversation_id, session_id, parent_session_id, depth, kind, state, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(workspace_scope, project_id, conversation_id, session_id) DO UPDATE SET
      parent_session_id=COALESCE(toon_workspace_conversation_cleanup_sessions.parent_session_id, excluded.parent_session_id),
      depth=MAX(toon_workspace_conversation_cleanup_sessions.depth, excluded.depth),
      kind=CASE WHEN toon_workspace_conversation_cleanup_sessions.kind='root' OR excluded.kind='root' THEN 'root' ELSE 'child' END,
      updated_at=excluded.updated_at`, [workspaceScope, projectId, conversationId, session.sessionId, session.parentSessionId, session.depth, session.kind, now]);
  }

  conversationCleanup(workspaceScope: string, projectId: string, conversationId: string): ToonWorkspaceConversationCleanup | null {
    const row = this.database.get<{ last_error: string | null; updated_at: number }>("SELECT last_error, updated_at FROM toon_workspace_conversation_cleanups WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [workspaceScope, projectId, conversationId]);
    if (!row) return null;
    const sessions = this.database.all<{ session_id: string; parent_session_id: string | null; depth: number; kind: "root" | "child"; state: "pending" | "deleted" | "not_found"; abort_attempts: number; delete_attempts: number; last_error: string | null }>(`SELECT session_id, parent_session_id, depth, kind, state, abort_attempts, delete_attempts, last_error
      FROM toon_workspace_conversation_cleanup_sessions WHERE workspace_scope=? AND project_id=? AND conversation_id=? ORDER BY depth DESC, session_id`, [workspaceScope, projectId, conversationId]);
    return { workspaceScope, projectId, conversationId, lastError: row.last_error, updatedAt: row.updated_at, sessions: sessions.map((session) => ({ sessionId: session.session_id, parentSessionId: session.parent_session_id, depth: session.depth, kind: session.kind, state: session.state, abortAttempts: session.abort_attempts, deleteAttempts: session.delete_attempts, lastError: session.last_error })) };
  }

  requireConversationCleanup(workspaceScope: string, projectId: string, conversationId: string): ToonWorkspaceConversationCleanup {
    const cleanup = this.conversationCleanup(workspaceScope, projectId, conversationId);
    if (!cleanup) throw new ApiError(404, "toon_assistant_cleanup_not_found", "Project conversation cleanup was not found");
    return cleanup;
  }

  listPendingConversationCleanups(workspaceScope?: string): ToonWorkspaceConversationCleanup[] {
    const rows = workspaceScope
      ? this.database.all<{ workspace_scope: string; project_id: string; conversation_id: string }>("SELECT workspace_scope, project_id, conversation_id FROM toon_workspace_conversation_cleanups WHERE workspace_scope=? ORDER BY updated_at", [workspaceScope])
      : this.database.all<{ workspace_scope: string; project_id: string; conversation_id: string }>("SELECT workspace_scope, project_id, conversation_id FROM toon_workspace_conversation_cleanups ORDER BY updated_at");
    return rows.map((row) => this.requireConversationCleanup(row.workspace_scope, row.project_id, row.conversation_id));
  }

  recordConversationCleanupAbort(workspaceScope: string, projectId: string, conversationId: string, sessionId: string, error: string | null, now = Date.now()): void {
    this.database.run("UPDATE toon_workspace_conversation_cleanup_sessions SET abort_attempts=abort_attempts+1, last_error=COALESCE(?, last_error), updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND session_id=? AND state='pending'", [error, now, workspaceScope, projectId, conversationId, sessionId]);
    if (error) this.recordConversationCleanupError(workspaceScope, projectId, conversationId, error, now);
  }

  recordConversationCleanupDelete(workspaceScope: string, projectId: string, conversationId: string, sessionId: string, state: "deleted" | "not_found" | "pending", error: string | null, now = Date.now()): void {
    this.database.transaction(() => {
      this.database.run("UPDATE toon_workspace_conversation_cleanup_sessions SET state=?, delete_attempts=delete_attempts+1, last_error=?, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND session_id=?", [state, error, now, workspaceScope, projectId, conversationId, sessionId]);
      if (error) this.recordConversationCleanupError(workspaceScope, projectId, conversationId, error, now);
      else this.database.run("UPDATE toon_workspace_conversation_cleanups SET updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [now, workspaceScope, projectId, conversationId]);
    });
  }

  recordConversationCleanupError(workspaceScope: string, projectId: string, conversationId: string, error: string, now = Date.now()): void {
    this.database.run("UPDATE toon_workspace_conversation_cleanups SET last_error=?, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [error.slice(0, 2_000), now, workspaceScope, projectId, conversationId]);
  }

  listConversationTurnSessions(workspaceScope: string, projectId: string, conversationId: string): Array<{ sessionId: string; parentSessionId: string | null }> {
    const rows = this.database.all<{ session_id: string; parent_session_id: string | null }>(`SELECT session_id, parent_session_id FROM toon_workspace_turn_sessions
      WHERE workspace_scope=? AND project_id=? AND conversation_id=? ORDER BY created_at`, [workspaceScope, projectId, conversationId]);
    const sessions = new Map<string, { sessionId: string; parentSessionId: string | null }>();
    for (const row of rows) {
      const current = sessions.get(row.session_id);
      if (!current || current.parentSessionId === null && row.parent_session_id !== null) sessions.set(row.session_id, { sessionId: row.session_id, parentSessionId: row.parent_session_id });
    }
    return [...sessions.values()];
  }

  sessionVisibility(workspaceScope: string, sessionId: string): { visibility: ToonSessionVisibility; projectId: string; parentSessionId: string | null } | null {
    const row = this.database.get<{ visibility: ToonSessionVisibility; project_id: string; parent_session_id: string | null }>(`SELECT visibility, project_id, parent_session_id FROM toon_workspace_session_lineage WHERE workspace_scope = ? AND session_id = ?`, [workspaceScope, sessionId]);
    return row ? { visibility: row.visibility, projectId: row.project_id, parentSessionId: row.parent_session_id } : null;
  }

  listSessionLineage(workspaceScope?: string): Array<{ workspaceScope: string; projectId: string; sessionId: string; parentSessionId: string | null; visibility: ToonSessionVisibility }> {
    const rows = workspaceScope
      ? this.database.all<{ workspace_scope: string; project_id: string; session_id: string; parent_session_id: string | null; visibility: ToonSessionVisibility }>("SELECT workspace_scope, project_id, session_id, parent_session_id, visibility FROM toon_workspace_session_lineage WHERE workspace_scope = ?", [workspaceScope])
      : this.database.all<{ workspace_scope: string; project_id: string; session_id: string; parent_session_id: string | null; visibility: ToonSessionVisibility }>("SELECT workspace_scope, project_id, session_id, parent_session_id, visibility FROM toon_workspace_session_lineage");
    return rows.map((row) => ({ workspaceScope: row.workspace_scope, projectId: row.project_id, sessionId: row.session_id, parentSessionId: row.parent_session_id, visibility: row.visibility }));
  }

  recordLineage(workspaceScope: string, projectId: string, sessionId: string, parentSessionId: string, visibility: "toon_project_subagent"): void {
    const parent = this.sessionVisibility(workspaceScope, parentSessionId);
    if (!parent || parent.projectId !== projectId || parent.visibility === "normal" || parent.visibility === "toon_transient_generation") throw new ApiError(409, "toon_session_lineage_invalid", "Project assistant session lineage is invalid");
    this.database.transaction(() => {
      this.database.run(`INSERT INTO toon_workspace_session_lineage(workspace_scope, project_id, session_id, parent_session_id, visibility) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_scope, project_id, session_id) DO UPDATE SET parent_session_id = excluded.parent_session_id, visibility = excluded.visibility`, [workspaceScope, projectId, sessionId, parentSessionId, visibility]);
      const owner = this.turnForSession(workspaceScope, projectId, parentSessionId);
      if (owner) this.recordTurnSession(workspaceScope, projectId, owner.conversationId, owner.turnId, sessionId, parentSessionId);
    });
  }

  listDescendants(workspaceScope: string, projectId: string, rootSessionId: string): Array<{ sessionId: string; parentSessionId: string }> {
    const rows = this.database.all<{ session_id: string; parent_session_id: string | null; visibility: ToonSessionVisibility }>(`SELECT session_id, parent_session_id, visibility FROM toon_workspace_session_lineage WHERE workspace_scope = ? AND project_id = ?`, [workspaceScope, projectId]);
    const result: Array<{ sessionId: string; parentSessionId: string }> = [];
    const accepted = new Set([rootSessionId]);
    for (let depth = 0; depth < 64; depth += 1) {
      let changed = false;
      for (const row of rows) {
        if (row.visibility !== "toon_project_subagent" || !row.parent_session_id || !accepted.has(row.parent_session_id) || accepted.has(row.session_id)) continue;
        accepted.add(row.session_id);
        result.push({ sessionId: row.session_id, parentSessionId: row.parent_session_id });
        changed = true;
      }
      if (!changed) break;
    }
    return result;
  }

  saveMessage(workspaceScope: string, projectId: string, message: ToonAssistantMessage, now = Date.now()): void {
    this.database.run(`INSERT INTO toon_workspace_assistant_messages(workspace_scope, project_id, conversation_id, message_id, turn_id, branch_id, message_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_scope, project_id, conversation_id, message_id) DO UPDATE SET message_json = excluded.message_json, updated_at = excluded.updated_at`,
    [workspaceScope, projectId, message.conversationId, message.id, message.turnId, message.branchId, JSON.stringify(message), Date.parse(message.createdAt) || now, now]);
    this.database.run("UPDATE toon_workspace_conversation_details SET updated_at = ? WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ?", [now, workspaceScope, projectId, message.conversationId]);
  }

  listMessages(workspaceScope: string, projectId: string, conversationId: string): ToonAssistantMessage[] {
    return this.database.all<{ message_json: string }>(`SELECT message_json FROM toon_workspace_assistant_messages WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ? ORDER BY created_at, rowid`, [workspaceScope, projectId, conversationId]).map((row) => JSON.parse(row.message_json) as ToonAssistantMessage);
  }

  conversationActiveBranch(workspaceScope: string, projectId: string, conversationId: string): string | null {
    const row = this.database.get<{ active_branch_id: string | null }>("SELECT active_branch_id FROM toon_workspace_conversation_details WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [workspaceScope, projectId, conversationId]);
    if (!row) throw new ApiError(404, "toon_conversation_not_found", "Project assistant conversation not found");
    if (row.active_branch_id) return row.active_branch_id;
    return this.database.get<{ branch_id: string }>("SELECT branch_id FROM toon_workspace_assistant_turns WHERE workspace_scope=? AND project_id=? AND conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", [workspaceScope, projectId, conversationId])?.branch_id ?? null;
  }

  conversationIsolationRequired(workspaceScope: string, projectId: string, conversationId: string): boolean {
    const row = this.database.get<{ isolation_required: number }>("SELECT isolation_required FROM toon_workspace_conversation_details WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [workspaceScope, projectId, conversationId]);
    if (!row) throw new ApiError(404, "toon_conversation_not_found", "Project assistant conversation not found");
    return row.isolation_required === 1;
  }

  requireConversationIsolation(workspaceScope: string, projectId: string, conversationId: string, now = Date.now()): void {
    this.database.run("UPDATE toon_workspace_conversation_details SET isolation_required=1, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [now, workspaceScope, projectId, conversationId]);
  }

  saveAssistantBranch(workspaceScope: string, projectId: string, conversationId: string, branch: Omit<ToonWorkspaceAssistantBranchRecord, "createdAt" | "updatedAt">, now = Date.now()): ToonWorkspaceAssistantBranchRecord {
    this.requireConversation(workspaceScope, projectId, conversationId);
    this.database.transaction(() => {
      this.database.run(`INSERT INTO toon_workspace_assistant_branches(workspace_scope, project_id, conversation_id, branch_id, root_session_id, source_message_id, replay_context, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_scope, project_id, conversation_id, branch_id)
        DO UPDATE SET root_session_id=excluded.root_session_id, source_message_id=COALESCE(toon_workspace_assistant_branches.source_message_id, excluded.source_message_id), replay_context=COALESCE(toon_workspace_assistant_branches.replay_context, excluded.replay_context), updated_at=excluded.updated_at`,
      [workspaceScope, projectId, conversationId, branch.branchId, branch.rootSessionId, branch.sourceMessageId, branch.replayContext, now, now]);
      this.database.run("UPDATE toon_workspace_conversation_details SET active_branch_id=?, isolation_required=0, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [branch.branchId, now, workspaceScope, projectId, conversationId]);
    });
    return this.requireAssistantBranch(workspaceScope, projectId, conversationId, branch.branchId);
  }

  assistantBranch(workspaceScope: string, projectId: string, conversationId: string, branchId: string): ToonWorkspaceAssistantBranchRecord | null {
    const row = this.database.get<{ branch_id: string; root_session_id: string; source_message_id: string | null; replay_context: string | null; created_at: number; updated_at: number }>(`SELECT branch_id, root_session_id, source_message_id, replay_context, created_at, updated_at FROM toon_workspace_assistant_branches
      WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND branch_id=?`, [workspaceScope, projectId, conversationId, branchId]);
    return row ? { branchId: row.branch_id, rootSessionId: row.root_session_id, sourceMessageId: row.source_message_id, replayContext: row.replay_context, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  requireAssistantBranch(workspaceScope: string, projectId: string, conversationId: string, branchId: string): ToonWorkspaceAssistantBranchRecord {
    const branch = this.assistantBranch(workspaceScope, projectId, conversationId, branchId);
    if (!branch) throw new ApiError(404, "toon_assistant_branch_not_found", "Project assistant branch not found");
    return branch;
  }

  rootSessionForTurn(workspaceScope: string, projectId: string, conversationId: string, turnId: string): string | null {
    return this.database.get<{ session_id: string }>(`SELECT session_id FROM toon_workspace_turn_sessions WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=? AND parent_session_id IS NULL ORDER BY created_at LIMIT 1`, [workspaceScope, projectId, conversationId, turnId])?.session_id ?? null;
  }

  listConversationRootSessions(workspaceScope: string, projectId: string, conversationId: string): string[] {
    const current = this.conversationSession(workspaceScope, projectId, conversationId);
    const rows = this.database.all<{ session_id: string }>(`SELECT DISTINCT session_id FROM toon_workspace_turn_sessions WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND parent_session_id IS NULL ORDER BY created_at`, [workspaceScope, projectId, conversationId]);
    const branches = this.database.all<{ root_session_id: string }>("SELECT root_session_id FROM toon_workspace_assistant_branches WHERE workspace_scope=? AND project_id=? AND conversation_id=? ORDER BY created_at", [workspaceScope, projectId, conversationId]);
    return [...new Set([...rows.map((row) => row.session_id), ...branches.map((row) => row.root_session_id), current])];
  }

  listAssistantBranches(workspaceScope: string, projectId: string, conversationId: string): Array<{ id: string; fromMessageId: string | null; turnIds: string[]; remoteMayContinue: boolean; active: boolean; createdAt: string }> {
    const activeBranchId = this.conversationActiveBranch(workspaceScope, projectId, conversationId);
    const rows = this.database.all<{ branch_id: string; source_message_id: string | null; turn_id: string; remote_may_continue: number; created_at: number }>(`SELECT branch_id, source_message_id, turn_id, remote_may_continue, created_at FROM toon_workspace_assistant_turns
      WHERE workspace_scope=? AND project_id=? AND conversation_id=? ORDER BY created_at, rowid`, [workspaceScope, projectId, conversationId]);
    const branches = new Map<string, { id: string; fromMessageId: string | null; turnIds: string[]; remoteMayContinue: boolean; active: boolean; createdAt: string }>();
    for (const row of rows) {
      const existing = branches.get(row.branch_id);
      if (existing) {
        existing.turnIds.push(row.turn_id);
        existing.remoteMayContinue ||= row.remote_may_continue === 1;
      } else branches.set(row.branch_id, { id: row.branch_id, fromMessageId: row.source_message_id, turnIds: [row.turn_id], remoteMayContinue: row.remote_may_continue === 1, active: row.branch_id === activeBranchId, createdAt: new Date(row.created_at).toISOString() });
    }
    return [...branches.values()];
  }

  listRemoteContinueWarnings(workspaceScope: string, projectId: string, conversationId: string): Array<{ turnId: string; branchId: string; status: "detached" | "interrupted"; remoteMayContinue: true; createdAt: string }> {
    return this.database.all<{ turn_id: string; branch_id: string; status: "detached" | "interrupted"; updated_at: number }>(`SELECT turn_id, branch_id, status, updated_at FROM toon_workspace_assistant_turns
      WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND remote_may_continue=1 AND remote_warning_acknowledged_at IS NULL AND status IN ('detached','interrupted') ORDER BY updated_at`, [workspaceScope, projectId, conversationId])
      .map((row) => ({ turnId: row.turn_id, branchId: row.branch_id, status: row.status, remoteMayContinue: true as const, createdAt: new Date(row.updated_at).toISOString() }));
  }

  listRemoteContinueConversations(workspaceScope: string): Array<{ projectId: string; conversationId: string }> {
    return this.database.all<{ project_id: string; conversation_id: string }>(`SELECT DISTINCT project_id, conversation_id FROM toon_workspace_assistant_turns
      WHERE workspace_scope=? AND remote_may_continue=1 AND status IN ('detached','interrupted')`, [workspaceScope])
      .map((row) => ({ projectId: row.project_id, conversationId: row.conversation_id }));
  }

  acknowledgeRemoteContinueWarning(workspaceScope: string, projectId: string, conversationId: string, turnId: string, now = Date.now()): void {
    const result = this.database.run(`UPDATE toon_workspace_assistant_turns SET remote_warning_acknowledged_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=? AND remote_may_continue=1 AND status IN ('detached','interrupted') AND remote_warning_acknowledged_at IS NULL`, [now, workspaceScope, projectId, conversationId, turnId]);
    if (!result.changes && !this.turn(workspaceScope, projectId, conversationId, turnId)) throw new ApiError(404, "toon_assistant_turn_not_found", "Project assistant turn not found");
  }

  assetAssistantReferences(workspaceScope: string, projectId: string, assetId: string): Array<{ conversationId: string; messageId: string }> {
    const rows = this.database.all<{ conversation_id: string; message_id: string; message_json: string }>(
      "SELECT conversation_id, message_id, message_json FROM toon_workspace_assistant_messages WHERE workspace_scope = ? AND project_id = ? ORDER BY created_at",
      [workspaceScope, projectId],
    );
    return rows.flatMap((row) => {
      const message = JSON.parse(row.message_json) as ToonAssistantMessage;
      const referenced = message.attachments.some((item) => item.kind === "asset" && item.targetId === assetId)
        || message.mentions.some((item) => item.kind === "asset" && item.id === assetId);
      return referenced ? [{ conversationId: row.conversation_id, messageId: row.message_id }] : [];
    });
  }

  saveInteraction(workspaceScope: string, projectId: string, interaction: ToonAssistantInteraction, now = Date.now()): void {
    this.database.run(`INSERT INTO toon_workspace_assistant_interactions(workspace_scope, project_id, conversation_id, interaction_id, interaction_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_scope, project_id, conversation_id, interaction_id) DO UPDATE SET interaction_json = excluded.interaction_json, updated_at = excluded.updated_at`, [workspaceScope, projectId, interaction.conversationId, interaction.id, JSON.stringify(interaction), Date.parse(interaction.createdAt) || now, now]);
  }

  listInteractions(workspaceScope: string, projectId: string, conversationId: string): ToonAssistantInteraction[] {
    return this.database.all<{ interaction_json: string }>(`SELECT interaction_json FROM toon_workspace_assistant_interactions WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ? ORDER BY created_at`, [workspaceScope, projectId, conversationId]).map((row) => JSON.parse(row.interaction_json) as ToonAssistantInteraction);
  }

  findPendingGenerationInteraction(workspaceScope: string, projectId: string, generationId: string): ToonAssistantInteraction | null {
    const rows = this.database.all<{ interaction_json: string }>(`SELECT interaction_json FROM toon_workspace_assistant_interactions
      WHERE workspace_scope = ? AND project_id = ? ORDER BY created_at`, [workspaceScope, projectId]);
    for (const row of rows) {
      const interaction = JSON.parse(row.interaction_json) as ToonAssistantInteraction;
      if (interaction.kind !== "compute-authorization" || interaction.state !== "pending") continue;
      const payload = interaction.payload && typeof interaction.payload === "object" && !Array.isArray(interaction.payload) ? interaction.payload as Record<string, unknown> : null;
      const proposal = payload?.proposal && typeof payload.proposal === "object" && !Array.isArray(payload.proposal) ? payload.proposal as Record<string, unknown> : payload;
      if (proposal?.id === generationId) return interaction;
    }
    return null;
  }

  resolveInteraction(workspaceScope: string, projectId: string, conversationId: string, interactionId: string, answer: unknown, state: "resolved" | "denied", now = Date.now()): ToonAssistantInteraction {
    const interaction = this.listInteractions(workspaceScope, projectId, conversationId).find((item) => item.id === interactionId);
    if (!interaction) throw new ApiError(404, "toon_assistant_interaction_not_found", "Project assistant interaction not found");
    if (interaction.state !== "pending") throw new ApiError(409, "toon_assistant_interaction_resolved", "Project assistant interaction was already answered");
    const next: ToonAssistantInteraction = { ...interaction, state, answer, resolvedAt: new Date(now).toISOString() };
    this.saveInteraction(workspaceScope, projectId, next, now);
    return next;
  }

  saveToolCall(workspaceScope: string, projectId: string, record: ToonWorkspaceToolCallRecord, now = Date.now()): void {
    this.assertToolCallOwner(workspaceScope, projectId, record);
    this.database.run(`INSERT INTO toon_workspace_tool_calls(workspace_scope, project_id, tool_call_id, conversation_id, turn_id, session_id, operation_id, state, execution_state, proposal_json, sanitized_result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_scope, project_id, tool_call_id) DO UPDATE SET turn_id=COALESCE(toon_workspace_tool_calls.turn_id, excluded.turn_id), session_id=COALESCE(toon_workspace_tool_calls.session_id, excluded.session_id), operation_id=COALESCE(toon_workspace_tool_calls.operation_id, excluded.operation_id), state=excluded.state, execution_state=COALESCE(excluded.execution_state, toon_workspace_tool_calls.execution_state), proposal_json=COALESCE(toon_workspace_tool_calls.proposal_json, excluded.proposal_json), sanitized_result_json=excluded.sanitized_result_json, updated_at=excluded.updated_at`,
    [workspaceScope, projectId, record.id, record.conversationId, record.turnId ?? null, record.sessionId ?? null, record.operationId ?? null, record.state, record.executionState ?? null, record.proposal === undefined ? null : JSON.stringify(record.proposal), record.result === undefined ? null : JSON.stringify(record.result), now, now]);
  }

  saveToolCallExecution(workspaceScope: string, projectId: string, record: Omit<ToonWorkspaceToolCallRecord, "operationId" | "proposal">, now = Date.now()): void {
    const existing = this.database.get<{ turn_id: string | null; session_id: string | null }>(`SELECT turn_id, session_id FROM toon_workspace_tool_calls WHERE workspace_scope=? AND project_id=? AND tool_call_id=?`, [workspaceScope, projectId, record.id]);
    const owned = { ...record, turnId: existing?.turn_id ?? record.turnId, sessionId: existing?.session_id ?? record.sessionId };
    this.assertToolCallOwner(workspaceScope, projectId, owned);
    this.database.run(`INSERT INTO toon_workspace_tool_calls(workspace_scope, project_id, tool_call_id, conversation_id, turn_id, session_id, operation_id, state, execution_state, proposal_json, sanitized_result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'observed', ?, NULL, ?, ?, ?) ON CONFLICT(workspace_scope, project_id, tool_call_id) DO UPDATE SET turn_id=COALESCE(toon_workspace_tool_calls.turn_id, excluded.turn_id), session_id=COALESCE(toon_workspace_tool_calls.session_id, excluded.session_id), execution_state=excluded.execution_state, updated_at=excluded.updated_at`,
    [workspaceScope, projectId, owned.id, owned.conversationId, owned.turnId ?? null, owned.sessionId ?? null, owned.state, owned.result === undefined ? null : JSON.stringify(owned.result), now, now]);
  }

  private assertToolCallOwner(workspaceScope: string, projectId: string, record: Pick<ToonWorkspaceToolCallRecord, "id" | "conversationId" | "turnId" | "sessionId">): void {
    const existing = this.database.get<{ conversation_id: string | null; turn_id: string | null; session_id: string | null }>(`SELECT conversation_id, turn_id, session_id FROM toon_workspace_tool_calls WHERE workspace_scope=? AND project_id=? AND tool_call_id=?`, [workspaceScope, projectId, record.id]);
    if (!existing) return;
    const changed = existing.conversation_id && existing.conversation_id !== record.conversationId
      || existing.turn_id && record.turnId && existing.turn_id !== record.turnId
      || existing.session_id && record.sessionId && existing.session_id !== record.sessionId;
    if (changed) throw new ApiError(409, "toon_assistant_tool_call_id_conflict", "Project assistant tool call ID is already owned by another call");
  }

  requireToolCall(workspaceScope: string, projectId: string, conversationId: string, toolCallId: string): ToonWorkspaceToolCallRecord {
    const row = this.database.get<{ tool_call_id: string; conversation_id: string | null; turn_id: string | null; session_id: string | null; operation_id: string | null; state: string; execution_state: string | null; proposal_json: string | null; sanitized_result_json: string | null }>(`SELECT tool_call_id, conversation_id, turn_id, session_id, operation_id, state, execution_state, proposal_json, sanitized_result_json FROM toon_workspace_tool_calls WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND tool_call_id=?`, [workspaceScope, projectId, conversationId, toolCallId]);
    if (!row || !row.conversation_id) throw new ApiError(404, "toon_assistant_tool_call_not_found", "Project assistant tool call not found");
    return { id: row.tool_call_id, conversationId: row.conversation_id, ...(row.turn_id ? { turnId: row.turn_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.operation_id ? { operationId: row.operation_id } : {}), state: row.state, ...(row.execution_state ? { executionState: row.execution_state } : {}), ...(row.proposal_json ? { proposal: JSON.parse(row.proposal_json) } : {}), ...(row.sanitized_result_json ? { result: JSON.parse(row.sanitized_result_json) } : {}) };
  }

  requireCanvasProposal(workspaceScope: string, projectId: string, conversationId: string, proposalId: string): ToonWorkspaceToolCallRecord {
    const rows = this.database.all<{ tool_call_id: string; conversation_id: string | null; operation_id: string | null; state: string; proposal_json: string | null; sanitized_result_json: string | null }>(`SELECT tool_call_id, conversation_id, operation_id, state, proposal_json, sanitized_result_json FROM toon_workspace_tool_calls WHERE workspace_scope=? AND project_id=? AND conversation_id=?`, [workspaceScope, projectId, conversationId]);
    for (const row of rows) {
      if (!row.conversation_id || !row.proposal_json && !row.sanitized_result_json) continue;
      const result = row.sanitized_result_json ? JSON.parse(row.sanitized_result_json) as Record<string, unknown> : {};
      const proposal = row.proposal_json ? JSON.parse(row.proposal_json) : result && typeof result === "object" && "proposal" in result ? result.proposal : result;
      if (proposal && typeof proposal === "object" && !Array.isArray(proposal) && (proposal as { id?: unknown }).id === proposalId) {
        return { id: row.tool_call_id, conversationId: row.conversation_id, ...(row.operation_id ? { operationId: row.operation_id } : {}), state: row.state, proposal, result };
      }
    }
    throw new ApiError(404, "toon_assistant_canvas_proposal_not_found", "Project assistant canvas proposal not found");
  }

  generationAssistantOwner(workspaceScope: string, projectId: string, requestId: string): { conversationId: string; turnId: string } | null {
    const rows = this.database.all<{ conversation_id: string | null; operation_id: string | null; sanitized_result_json: string | null }>(
      "SELECT conversation_id, operation_id, sanitized_result_json FROM toon_workspace_tool_calls WHERE workspace_scope=? AND project_id=? AND operation_id=? ORDER BY created_at",
      [workspaceScope, projectId, requestId],
    );
    for (const row of rows) {
      if (!row.conversation_id || !row.sanitized_result_json) continue;
      const result = JSON.parse(row.sanitized_result_json) as { turnId?: unknown };
      if (typeof result.turnId === "string") return { conversationId: row.conversation_id, turnId: result.turnId };
    }
    return null;
  }

  listCanvasProposals(workspaceScope: string, projectId: string, conversationId: string): ToonAssistantCanvasProposalRecord[] {
    const rows = this.database.all<{ state: string; proposal_json: string | null; sanitized_result_json: string | null }>(`SELECT state, proposal_json, sanitized_result_json FROM toon_workspace_tool_calls
      WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND operation_id IS NOT NULL ORDER BY created_at`, [workspaceScope, projectId, conversationId]);
    const proposals: ToonAssistantCanvasProposalRecord[] = [];
    for (const row of rows) {
      if (!row.proposal_json && !row.sanitized_result_json) continue;
      const result = row.sanitized_result_json ? JSON.parse(row.sanitized_result_json) as Record<string, unknown> : {};
      const proposal = row.proposal_json ? JSON.parse(row.proposal_json) : result && typeof result === "object" && "proposal" in result ? result.proposal : result;
      if (!proposal || typeof proposal !== "object" || !("command" in proposal)) continue;
      const state = row.state === "committed" || row.state === "denied" || row.state === "failed" ? row.state : "proposed";
      proposals.push({
        proposal: proposal as ToonAssistantCanvasProposalRecord["proposal"],
        state,
        ...(result && "outcome" in result ? { outcome: result.outcome } : {}),
        ...(result && "error" in result && result.error && typeof result.error === "object" ? { error: result.error as { code: string; message: string } } : {}),
      });
    }
    return proposals;
  }

  beginTurn(workspaceScope: string, projectId: string, conversationId: string, turnId: string, branchId: string, sourceMessageId?: string, now = Date.now()): void {
    this.database.transaction(() => {
      this.assertConversationMutable(workspaceScope, projectId, conversationId);
      const active = this.activeTurn(workspaceScope, projectId, conversationId);
      if (active) throw new ApiError(409, "toon_assistant_busy", "The project conversation already has an active turn", { turnId: active.turnId });
      this.database.run(`INSERT INTO toon_workspace_assistant_turns(workspace_scope, project_id, conversation_id, turn_id, branch_id, source_message_id, status, remote_may_continue, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)`, [workspaceScope, projectId, conversationId, turnId, branchId, sourceMessageId ?? null, now, now]);
      this.database.run("UPDATE toon_workspace_conversation_details SET active_turn_id = ?, updated_at = ? WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ?", [turnId, now, workspaceScope, projectId, conversationId]);
      this.database.run("UPDATE toon_workspace_conversation_details SET active_branch_id=?, isolation_required=0 WHERE workspace_scope=? AND project_id=? AND conversation_id=?", [branchId, workspaceScope, projectId, conversationId]);
      this.database.run("UPDATE toon_workspace_assistant_turns SET remote_warning_acknowledged_at=COALESCE(remote_warning_acknowledged_at, ?) WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND remote_may_continue=1", [now, workspaceScope, projectId, conversationId]);
      this.database.run(`INSERT INTO toon_workspace_turn_sessions(workspace_scope, project_id, conversation_id, turn_id, session_id, parent_session_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, ?)`, [workspaceScope, projectId, conversationId, turnId, this.conversationSession(workspaceScope, projectId, conversationId), now, now]);
    });
  }

  recordTurnSession(workspaceScope: string, projectId: string, conversationId: string, turnId: string, sessionId: string, parentSessionId: string | null, now = Date.now()): void {
    this.database.run(`INSERT INTO toon_workspace_turn_sessions(workspace_scope, project_id, conversation_id, turn_id, session_id, parent_session_id, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(workspace_scope, project_id, conversation_id, turn_id, session_id)
      DO UPDATE SET parent_session_id=excluded.parent_session_id, state='active', updated_at=excluded.updated_at`,
    [workspaceScope, projectId, conversationId, turnId, sessionId, parentSessionId, now, now]);
  }

  turnForSession(workspaceScope: string, projectId: string, sessionId: string): { conversationId: string; turnId: string; state: "active" | "terminal" | "detached" } | null {
    const row = this.database.get<{ conversation_id: string; turn_id: string; state: "active" | "terminal" | "detached" }>(`SELECT conversation_id, turn_id, state FROM toon_workspace_turn_sessions
      WHERE workspace_scope=? AND project_id=? AND session_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1`, [workspaceScope, projectId, sessionId]);
    return row ? { conversationId: row.conversation_id, turnId: row.turn_id, state: row.state } : null;
  }

  listTurnSessions(workspaceScope: string, projectId: string, conversationId: string, turnId: string): Array<{ sessionId: string; parentSessionId: string | null; state: "active" | "terminal" | "detached"; abortRequestedAt: number | null; abortAttempts: number }> {
    return this.database.all<{ session_id: string; parent_session_id: string | null; state: "active" | "terminal" | "detached"; abort_requested_at: number | null; abort_attempts: number }>(`SELECT session_id, parent_session_id, state, abort_requested_at, abort_attempts FROM toon_workspace_turn_sessions
      WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=? ORDER BY created_at`, [workspaceScope, projectId, conversationId, turnId])
      .map((row) => ({ sessionId: row.session_id, parentSessionId: row.parent_session_id, state: row.state, abortRequestedAt: row.abort_requested_at, abortAttempts: row.abort_attempts }));
  }

  setTurnSessionState(workspaceScope: string, projectId: string, conversationId: string, turnId: string, sessionId: string, state: "active" | "terminal" | "detached", now = Date.now()): void {
    this.database.run(`UPDATE toon_workspace_turn_sessions SET state=?, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=? AND session_id=?`,
      [state, now, workspaceScope, projectId, conversationId, turnId, sessionId]);
  }

  recordTurnSessionAbortAttempt(workspaceScope: string, projectId: string, conversationId: string, turnId: string, sessionId: string, accepted: boolean, now = Date.now()): void {
    this.database.run(`UPDATE toon_workspace_turn_sessions
      SET abort_attempts=abort_attempts+1, abort_requested_at=CASE WHEN ? THEN COALESCE(abort_requested_at, ?) ELSE abort_requested_at END, updated_at=?
      WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=? AND session_id=? AND state='active'`,
    [accepted ? 1 : 0, now, now, workspaceScope, projectId, conversationId, turnId, sessionId]);
  }

  activeTurn(workspaceScope: string, projectId: string, conversationId: string): { turnId: string; branchId: string; status: string; remoteMayContinue: boolean; updatedAt: number; stopStartedAt: number | null; stopDeadlineAt: number | null; stopQuietSince: number | null; stopObservationHash: string | null; stopStablePolls: number } | null {
    const row = this.database.get<{ turn_id: string; branch_id: string; status: string; remote_may_continue: number; updated_at: number; stop_started_at: number | null; stop_deadline_at: number | null; stop_quiet_since: number | null; stop_observation_hash: string | null; stop_stable_polls: number }>(`SELECT t.turn_id, t.branch_id, t.status, t.remote_may_continue, t.updated_at, t.stop_started_at, t.stop_deadline_at, t.stop_quiet_since, t.stop_observation_hash, t.stop_stable_polls FROM toon_workspace_assistant_turns t JOIN toon_workspace_conversation_details d
      ON d.workspace_scope=t.workspace_scope AND d.project_id=t.project_id AND d.conversation_id=t.conversation_id AND d.active_turn_id=t.turn_id
      WHERE t.workspace_scope=? AND t.project_id=? AND t.conversation_id=?`, [workspaceScope, projectId, conversationId]);
    return row ? { turnId: row.turn_id, branchId: row.branch_id, status: row.status, remoteMayContinue: row.remote_may_continue === 1, updatedAt: row.updated_at, stopStartedAt: row.stop_started_at, stopDeadlineAt: row.stop_deadline_at, stopQuietSince: row.stop_quiet_since, stopObservationHash: row.stop_observation_hash, stopStablePolls: row.stop_stable_polls } : null;
  }

  markTurnStopping(workspaceScope: string, projectId: string, conversationId: string, turnId: string, deadlineAt: number, now = Date.now()): void {
    this.database.run(`UPDATE toon_workspace_assistant_turns SET updated_at=CASE WHEN status='running' THEN ? ELSE updated_at END,
      status='stopping', remote_may_continue=1, stop_started_at=COALESCE(stop_started_at, ?), stop_deadline_at=COALESCE(stop_deadline_at, ?)
      WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=? AND status IN ('running','stopping')`, [now, now, deadlineAt, workspaceScope, projectId, conversationId, turnId]);
  }

  observeStoppingTurn(workspaceScope: string, projectId: string, conversationId: string, turnId: string, observationHash: string, quiet: boolean, now = Date.now()): void {
    const active = this.activeTurn(workspaceScope, projectId, conversationId);
    if (!active || active.turnId !== turnId || active.status !== "stopping") return;
    const stable = active.stopObservationHash === observationHash;
    this.database.run(`UPDATE toon_workspace_assistant_turns SET stop_observation_hash=?, stop_stable_polls=?, stop_quiet_since=?
      WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=? AND status='stopping'`, [
      observationHash,
      stable ? active.stopStablePolls + 1 : 1,
      quiet ? stable ? active.stopQuietSince ?? now : now : null,
      workspaceScope, projectId, conversationId, turnId,
    ]);
  }

  turn(workspaceScope: string, projectId: string, conversationId: string, turnId: string): { status: string; remoteMayContinue: boolean } | null {
    const row = this.database.get<{ status: string; remote_may_continue: number }>("SELECT status, remote_may_continue FROM toon_workspace_assistant_turns WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=?", [workspaceScope, projectId, conversationId, turnId]);
    return row ? { status: row.status, remoteMayContinue: row.remote_may_continue === 1 } : null;
  }

  savePendingAssistantReplacement(input: ToonWorkspacePendingAssistantReplacement, now = Date.now()): ToonWorkspacePendingAssistantReplacement {
    const existing = this.pendingAssistantReplacement(input.workspaceScope, input.projectId, input.conversationId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) throw new ApiError(409, "toon_assistant_replacement_pending", "Another edit-and-resend replacement is already pending");
      return existing;
    }
    this.database.run(`INSERT INTO toon_workspace_pending_assistant_replacements(workspace_scope, project_id, conversation_id, replacement_turn_id, waiting_for_turn_id, branch_id, source_message_id, request_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [input.workspaceScope, input.projectId, input.conversationId, input.replacementTurnId, input.waitingForTurnId, input.branchId, input.sourceMessageId, JSON.stringify(input.request), now, now]);
    return input;
  }

  pendingAssistantReplacement(workspaceScope: string, projectId: string, conversationId: string): ToonWorkspacePendingAssistantReplacement | null {
    const row = this.database.get<{ replacement_turn_id: string; waiting_for_turn_id: string; branch_id: string; source_message_id: string; request_json: string }>(`SELECT replacement_turn_id, waiting_for_turn_id, branch_id, source_message_id, request_json
      FROM toon_workspace_pending_assistant_replacements WHERE workspace_scope=? AND project_id=? AND conversation_id=?`, [workspaceScope, projectId, conversationId]);
    return row ? { workspaceScope, projectId, conversationId, replacementTurnId: row.replacement_turn_id, waitingForTurnId: row.waiting_for_turn_id, branchId: row.branch_id, sourceMessageId: row.source_message_id, request: JSON.parse(row.request_json) as ToonAssistantEditResendRequest } : null;
  }

  listPendingAssistantReplacements(workspaceScope?: string): ToonWorkspacePendingAssistantReplacement[] {
    const rows = workspaceScope
      ? this.database.all<{ workspace_scope: string; project_id: string; conversation_id: string; replacement_turn_id: string; waiting_for_turn_id: string; branch_id: string; source_message_id: string; request_json: string }>("SELECT * FROM toon_workspace_pending_assistant_replacements WHERE workspace_scope=? ORDER BY created_at", [workspaceScope])
      : this.database.all<{ workspace_scope: string; project_id: string; conversation_id: string; replacement_turn_id: string; waiting_for_turn_id: string; branch_id: string; source_message_id: string; request_json: string }>("SELECT * FROM toon_workspace_pending_assistant_replacements ORDER BY created_at");
    return rows.map((row) => ({ workspaceScope: row.workspace_scope, projectId: row.project_id, conversationId: row.conversation_id, replacementTurnId: row.replacement_turn_id, waitingForTurnId: row.waiting_for_turn_id, branchId: row.branch_id, sourceMessageId: row.source_message_id, request: JSON.parse(row.request_json) as ToonAssistantEditResendRequest }));
  }

  deletePendingAssistantReplacement(workspaceScope: string, projectId: string, conversationId: string, replacementTurnId: string): void {
    this.database.run("DELETE FROM toon_workspace_pending_assistant_replacements WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND replacement_turn_id=?", [workspaceScope, projectId, conversationId, replacementTurnId]);
  }

  listActiveTurns(workspaceScope?: string): ToonWorkspaceActiveTurn[] {
    const where = workspaceScope ? "WHERE d.active_turn_id IS NOT NULL AND d.workspace_scope=? AND cleanup.conversation_id IS NULL" : "WHERE d.active_turn_id IS NOT NULL AND cleanup.conversation_id IS NULL";
    const rows = this.database.all<{ workspace_scope: string; project_id: string; conversation_id: string; session_id: string; turn_id: string; branch_id: string }>(`SELECT d.workspace_scope, d.project_id, d.conversation_id, c.session_id, t.turn_id, t.branch_id
      FROM toon_workspace_conversation_details d
      JOIN toon_workspace_conversations c ON c.workspace_scope=d.workspace_scope AND c.project_id=d.project_id AND c.conversation_id=d.conversation_id
      JOIN toon_workspace_assistant_turns t ON t.workspace_scope=d.workspace_scope AND t.project_id=d.project_id AND t.conversation_id=d.conversation_id AND t.turn_id=d.active_turn_id
      LEFT JOIN toon_workspace_conversation_cleanups cleanup ON cleanup.workspace_scope=d.workspace_scope AND cleanup.project_id=d.project_id AND cleanup.conversation_id=d.conversation_id
      ${where}`, workspaceScope ? [workspaceScope] : []);
    return rows.map((row) => ({ workspaceScope: row.workspace_scope, projectId: row.project_id, conversationId: row.conversation_id, sessionId: row.session_id, turnId: row.turn_id, branchId: row.branch_id }));
  }

  finishTurn(workspaceScope: string, projectId: string, conversationId: string, turnId: string, status: "completed" | "failed" | "stopped" | "detached" | "interrupted", remoteMayContinue = false, now = Date.now()): void {
    this.database.transaction(() => {
      this.database.run("UPDATE toon_workspace_assistant_turns SET status=?, remote_may_continue=?, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=?", [status, remoteMayContinue ? 1 : 0, now, workspaceScope, projectId, conversationId, turnId]);
      this.database.run("UPDATE toon_workspace_conversation_details SET active_turn_id=NULL, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND active_turn_id=?", [now, workspaceScope, projectId, conversationId, turnId]);
      this.database.run("UPDATE toon_workspace_turn_sessions SET state=?, updated_at=? WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND turn_id=? AND state='active'", [status === "detached" ? "detached" : "terminal", now, workspaceScope, projectId, conversationId, turnId]);
    });
  }

  appendEvent(input: Omit<ToonAssistantStreamEvent, "version" | "id" | "sequence" | "createdAt"> & { eventId: string }, now = Date.now()): ToonAssistantStreamEvent {
    return this.database.transaction(() => {
      const existing = this.database.get<{ event_json: string }>(`SELECT event_json FROM toon_workspace_assistant_events WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND event_id=?`, [input.workspaceId, input.projectId, input.conversationId, input.eventId]);
      if (existing) return JSON.parse(existing.event_json) as ToonAssistantStreamEvent;
      const sequence = (this.database.get<{ sequence: number }>(`SELECT MAX(sequence) AS sequence FROM toon_workspace_assistant_events WHERE workspace_scope=? AND project_id=? AND conversation_id=?`, [input.workspaceId, input.projectId, input.conversationId])?.sequence ?? 0) + 1;
      const event: ToonAssistantStreamEvent = { version: 1, id: input.eventId, sequence, workspaceId: input.workspaceId, projectId: input.projectId, conversationId: input.conversationId, ...(input.turnId ? { turnId: input.turnId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), type: input.type, data: input.data, createdAt: new Date(now).toISOString() };
      this.database.run(`INSERT INTO toon_workspace_assistant_events(workspace_scope, project_id, conversation_id, sequence, event_id, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [input.workspaceId, input.projectId, input.conversationId, sequence, input.eventId, JSON.stringify(event), now]);
      this.database.run(`INSERT INTO toon_workspace_event_cursors(workspace_scope, project_id, conversation_id, cursor, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_scope, project_id, conversation_id) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`, [input.workspaceId, input.projectId, input.conversationId, String(sequence), now]);
      return event;
    });
  }

  listEvents(workspaceScope: string, projectId: string, conversationId: string, after = 0, limit = 200): { items: ToonAssistantStreamEvent[]; cursor: string | null; hasMore: boolean } {
    this.requireConversation(workspaceScope, projectId, conversationId);
    const rows = this.database.all<{ event_json: string }>(`SELECT event_json FROM toon_workspace_assistant_events WHERE workspace_scope=? AND project_id=? AND conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?`, [workspaceScope, projectId, conversationId, after, limit + 1]);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => JSON.parse(row.event_json) as ToonAssistantStreamEvent);
    return { items, cursor: items.length ? String(items.at(-1)!.sequence) : after > 0 ? String(after) : null, hasMore };
  }

  linkGeneration(input: ToonWorkspaceGenerationLink, now = Date.now()): ToonWorkspaceGenerationLink {
    return this.database.transaction(() => {
      const existing = this.generationLinkByGeneration(input.workspaceScope, input.projectId, input.generationId);
      if (existing && existing.runtimeJobId !== input.runtimeJobId) throw new ApiError(409, "toon_generation_job_conflict", "The portable generation already owns another durable job");
      const runtime = this.generationLinkByJob(input.runtimeJobId);
      if (runtime && (runtime.workspaceScope !== input.workspaceScope || runtime.projectId !== input.projectId || runtime.generationId !== input.generationId)) throw new ApiError(409, "toon_generation_job_conflict", "The durable job is already linked to another portable generation");
      this.database.run(`INSERT INTO toon_workspace_generation_links(workspace_scope, project_id, generation_id, runtime_job_id, canvas_id, node_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_scope, project_id, generation_id) DO NOTHING`,
      [input.workspaceScope, input.projectId, input.generationId, input.runtimeJobId, input.canvasId, input.nodeId, now]);
      return this.generationLinkByGeneration(input.workspaceScope, input.projectId, input.generationId)!;
    });
  }

  issueAuthorization(input: Omit<ToonWorkspaceAuthorization, "issuedAt" | "consumedAt" | "runtimeJobId">, now = Date.now()): ToonWorkspaceAuthorization {
    const existing = this.database.get<{ authorization_id: string; principal_id: string; workspace_scope: string; project_id: string; generation_id: string; request_hash: string; request_json: string | null }>(
      "SELECT authorization_id, principal_id, workspace_scope, project_id, generation_id, request_hash, request_json FROM toon_workspace_authorizations WHERE authorization_id = ?",
      [input.authorizationId],
    );
    if (existing) {
      if (existing.principal_id !== input.principalId || existing.workspace_scope !== input.workspaceScope || existing.project_id !== input.projectId || existing.generation_id !== input.generationId || existing.request_hash !== input.requestHash || existing.request_json !== JSON.stringify(input.requestSnapshot)) {
        throw new ApiError(409, "toon_operation_id_conflict", "The compute authorization operation is already bound to another scope");
      }
      return this.requireAuthorization(input.authorizationId);
    }
    this.database.run(`INSERT INTO toon_workspace_authorizations(
      authorization_id, principal_id, workspace_scope, project_id, generation_id, request_hash,
      request_json, expires_at, consumed_at, runtime_job_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`, [
      input.authorizationId, input.principalId, input.workspaceScope, input.projectId,
      input.generationId, input.requestHash, JSON.stringify(input.requestSnapshot), input.expiresAt, now,
    ]);
    return this.requireAuthorization(input.authorizationId);
  }

  invalidateAuthorization(authorizationId: string, now = Date.now()): void {
    this.database.run("UPDATE toon_workspace_authorizations SET invalidated_at=COALESCE(invalidated_at, ?) WHERE authorization_id=? AND consumed_at IS NULL", [now, authorizationId]);
  }

  invalidateGenerationAuthorizations(workspaceScope: string, projectId: string, authorizationIds: string[], now = Date.now()): void {
    for (const authorizationId of authorizationIds) this.database.run(`UPDATE toon_workspace_authorizations SET invalidated_at=COALESCE(invalidated_at, ?)
      WHERE authorization_id=? AND workspace_scope=? AND project_id=? AND consumed_at IS NULL`, [now, authorizationId, workspaceScope, projectId]);
  }

  requireAuthorization(authorizationId: string): ToonWorkspaceAuthorization {
    const row = this.database.get<{
      authorization_id: string; principal_id: string; workspace_scope: string; project_id: string;
      generation_id: string; request_hash: string; request_json: string | null; invalidated_at: number | null; expires_at: number; consumed_at: number | null; runtime_job_id: string | null; created_at: number;
    }>(`SELECT authorization_id, principal_id, workspace_scope, project_id, generation_id, request_hash,
      request_json, invalidated_at, expires_at, consumed_at, runtime_job_id, created_at FROM toon_workspace_authorizations WHERE authorization_id = ?`, [authorizationId]);
    if (!row) throw new ApiError(404, "toon_compute_authorization_not_found", "Compute authorization not found");
    if (!row.request_json) throw new ApiError(409, "toon_compute_authorization_legacy", "Compute authorization must be issued again");
    return {
      authorizationId: row.authorization_id, principalId: row.principal_id, workspaceScope: row.workspace_scope,
      projectId: row.project_id, generationId: row.generation_id, requestHash: row.request_hash,
      requestSnapshot: JSON.parse(row.request_json) as ToonMediaJobRequestSnapshot,
      issuedAt: row.created_at, expiresAt: row.expires_at, consumedAt: row.consumed_at, runtimeJobId: row.runtime_job_id,
    };
  }

  scopedGenerationAuthorization(input: {
    authorizationId: string;
    principalId: string;
    workspaceScope: string;
    projectId: string;
    generationId: string;
    requestHash: string;
  }, now = Date.now()): ToonGenerationAuthorizationState | null {
    let authorization: ToonWorkspaceAuthorization;
    try { authorization = this.requireAuthorization(input.authorizationId); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
    if (authorization.principalId !== input.principalId
      || authorization.workspaceScope !== input.workspaceScope
      || authorization.projectId !== input.projectId
      || authorization.generationId !== input.generationId
      || authorization.requestHash !== input.requestHash) return null;
    const invalidated = this.database.get<{ invalidated_at: number | null }>("SELECT invalidated_at FROM toon_workspace_authorizations WHERE authorization_id=?", [input.authorizationId]);
    if (invalidated?.invalidated_at !== null) return null;
    return {
      authorizationId: authorization.authorizationId,
      requestId: authorization.requestSnapshot.requestId,
      planFingerprint: authorization.requestHash,
      planSummary: authorization.requestSnapshot.plan,
      expiresAt: new Date(authorization.expiresAt).toISOString(),
      consumedAt: authorization.consumedAt === null ? null : new Date(authorization.consumedAt).toISOString(),
      state: authorization.consumedAt !== null ? "consumed" : authorization.expiresAt <= now ? "expired" : "valid",
    };
  }

  generationLinkByGeneration(workspaceScope: string, projectId: string, generationId: string): ToonWorkspaceGenerationLink | null {
    const row = this.database.get<{ workspace_scope: string; project_id: string; generation_id: string; runtime_job_id: string; canvas_id: string | null; node_id: string | null }>(
      "SELECT workspace_scope, project_id, generation_id, runtime_job_id, canvas_id, node_id FROM toon_workspace_generation_links WHERE workspace_scope=? AND project_id=? AND generation_id=?",
      [workspaceScope, projectId, generationId],
    );
    return row ? { workspaceScope: row.workspace_scope, projectId: row.project_id, generationId: row.generation_id, runtimeJobId: row.runtime_job_id, canvasId: row.canvas_id, nodeId: row.node_id } : null;
  }

  generationLinkByJob(runtimeJobId: string): ToonWorkspaceGenerationLink | null {
    const row = this.database.get<{ workspace_scope: string; project_id: string; generation_id: string; runtime_job_id: string; canvas_id: string | null; node_id: string | null }>(
      "SELECT workspace_scope, project_id, generation_id, runtime_job_id, canvas_id, node_id FROM toon_workspace_generation_links WHERE runtime_job_id=?",
      [runtimeJobId],
    );
    return row ? { workspaceScope: row.workspace_scope, projectId: row.project_id, generationId: row.generation_id, runtimeJobId: row.runtime_job_id, canvasId: row.canvas_id, nodeId: row.node_id } : null;
  }

  mediaJobByRequest(workspaceScope: string, projectId: string, requestId: string): ToonWorkspaceRuntimeMediaJob | null {
    const table = this.database.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'toon_factory_media_jobs'");
    if (!table) return null;
    const row = this.database.get<{ id: string; request_hash: string; job_json: string }>(
      "SELECT id, request_hash, job_json FROM toon_factory_media_jobs WHERE workspace_id = ? AND project_id = ? AND request_id = ?",
      [workspaceScope, projectId, requestId],
    );
    if (!row) return null;
    let job: { canvasId?: unknown; nodeId?: unknown; stepId?: unknown };
    try { job = JSON.parse(row.job_json) as typeof job; } catch { return null; }
    if (typeof job.canvasId !== "string" || typeof job.nodeId !== "string" || typeof job.stepId !== "string") return null;
    return { id: row.id, requestId, requestHash: row.request_hash, canvasId: job.canvasId, nodeId: job.nodeId, workflowRecordId: job.stepId };
  }

  hasActiveTextJobs(workspaceScope: string, projectId: string): boolean {
    const table = this.database.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'toon_factory_text_jobs'");
    if (!table) return false;
    return Boolean(this.database.get(
      "SELECT 1 AS present FROM toon_factory_text_jobs WHERE workspace_id = ? AND project_id = ? AND status IN ('queued','running','cancel_requested') LIMIT 1",
      [workspaceScope, projectId],
    ));
  }

  reconcileProject(workspaceScope: string, projectId: string, normalizedRoot: string, schemaVersion: number, now = Date.now()): void {
    const existing = this.database.get<{ normalized_root: string }>(
      "SELECT normalized_root FROM toon_workspace_projects WHERE workspace_scope = ? AND project_id = ?",
      [workspaceScope, projectId],
    );
    if (existing && existing.normalized_root !== normalizedRoot) {
      throw new ApiError(409, "toon_project_instance_changed", "This portable project ID is already bound to another runtime project instance; explicitly move or adopt the project before reusing its history");
    }
    this.database.run(`INSERT INTO toon_workspace_projects(
      workspace_scope, project_id, normalized_root, schema_version, last_seen_at, unavailable_since, project_instance_id
    ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(workspace_scope, project_id) DO UPDATE SET
      normalized_root = excluded.normalized_root,
      schema_version = excluded.schema_version,
      last_seen_at = excluded.last_seen_at,
      unavailable_since = NULL`, [workspaceScope, projectId, normalizedRoot, schemaVersion, now, `${workspaceScope}:${projectId}:${normalizedRoot}`]);
  }

  adoptProjectRoot(workspaceScope: string, projectId: string, expectedRoot: string, nextRoot: string, now = Date.now()): void {
    const result = this.database.run(`UPDATE toon_workspace_projects SET normalized_root = ?, project_instance_id = ?, last_seen_at = ?, unavailable_since = NULL
      WHERE workspace_scope = ? AND project_id = ? AND normalized_root = ?`,
    [nextRoot, `${workspaceScope}:${projectId}:${nextRoot}`, now, workspaceScope, projectId, expectedRoot]);
    if (result.changes !== 1) throw new ApiError(409, "toon_project_instance_changed", "The runtime project instance changed before adoption");
  }

  markUnavailable(workspaceScope: string, projectId: string, now = Date.now()): void {
    this.database.run(`UPDATE toon_workspace_projects SET unavailable_since = COALESCE(unavailable_since, ?)
      WHERE workspace_scope = ? AND project_id = ?`, [now, workspaceScope, projectId]);
  }

  cleanupOrphanMappings(before: number): number {
    return this.database.transaction(() => {
      const projects = this.database.all<{ workspace_scope: string; project_id: string }>(
        `SELECT projects.workspace_scope, projects.project_id FROM toon_workspace_projects projects
         WHERE projects.unavailable_since IS NOT NULL AND projects.unavailable_since < ?
         AND NOT EXISTS (SELECT 1 FROM toon_workspace_conversation_cleanups cleanup
           WHERE cleanup.workspace_scope=projects.workspace_scope AND cleanup.project_id=projects.project_id)`,
        [before],
      );
      const runtimeTables = [
        "toon_workspace_assistant_events", "toon_workspace_assistant_messages", "toon_workspace_assistant_interactions",
        "toon_workspace_assistant_turns", "toon_workspace_conversation_details", "toon_workspace_event_cursors",
        "toon_workspace_tool_calls", "toon_workspace_generation_links", "toon_workspace_operation_outcomes",
        "toon_workspace_authorizations",
        "toon_workspace_recovery_journals", "toon_workspace_canvas_leases", "toon_workspace_write_leases",
        "toon_workspace_turn_sessions", "toon_workspace_session_lineage", "toon_workspace_conversation_cleanup_sessions", "toon_workspace_conversation_cleanups", "toon_workspace_conversations",
      ];
      for (const project of projects) {
        for (const table of runtimeTables) {
          this.database.run(`DELETE FROM ${table} WHERE workspace_scope = ? AND project_id = ?`, [project.workspace_scope, project.project_id]);
        }
        this.database.run("DELETE FROM toon_workspace_projects WHERE workspace_scope = ? AND project_id = ?", [project.workspace_scope, project.project_id]);
      }
      return projects.length;
    });
  }

  getOutcome(workspaceScope: string, projectId: string, operationId: string, payloadHash: string): ToonWorkspaceOperationOutcome | null {
    const row = this.database.get<{ payload_hash: string; outcome_json: string }>(`SELECT payload_hash, outcome_json
      FROM toon_workspace_operation_outcomes WHERE workspace_scope = ? AND project_id = ? AND operation_id = ?`,
    [workspaceScope, projectId, operationId]);
    if (!row) return null;
    if (row.payload_hash !== payloadHash) {
      throw new ApiError(409, "toon_operation_id_conflict", "The operation ID is already used for a different payload");
    }
    return JSON.parse(row.outcome_json) as ToonWorkspaceOperationOutcome;
  }

  saveOutcome(workspaceScope: string, projectId: string, outcome: ToonWorkspaceOperationOutcome, now = Date.now()): void {
    const existing = this.database.get<{ payload_hash: string; outcome_json: string }>(`SELECT payload_hash, outcome_json FROM toon_workspace_operation_outcomes
      WHERE workspace_scope = ? AND project_id = ? AND operation_id = ?`, [workspaceScope, projectId, outcome.operationId]);
    if (existing) {
      if (existing.payload_hash !== outcome.payloadHash) throw new ApiError(409, "toon_operation_id_conflict", "The operation ID is already used for a different payload");
      const current = JSON.parse(existing.outcome_json) as ToonWorkspaceOperationOutcome;
      if (current.status === "committed" || current.status === "recovered" || outcome.status === "rejected") return;
      this.database.run(`UPDATE toon_workspace_operation_outcomes SET outcome_json = ?, created_at = ?
        WHERE workspace_scope = ? AND project_id = ? AND operation_id = ?`, [JSON.stringify(outcome), now, workspaceScope, projectId, outcome.operationId]);
      return;
    }
    this.database.run(`INSERT INTO toon_workspace_operation_outcomes(
      workspace_scope, project_id, operation_id, payload_hash, outcome_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_scope, project_id, operation_id) DO NOTHING`, [
      workspaceScope, projectId, outcome.operationId, outcome.payloadHash, JSON.stringify(outcome), now,
    ]);
  }

  prepareJournal(record: ToonWorkspaceJournalRecord, now = Date.now()): void {
    this.database.run(`INSERT INTO toon_workspace_recovery_journals(
      workspace_scope, project_id, operation_id, payload_hash, state, terminal_status, journal_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(workspace_scope, project_id, operation_id) DO UPDATE SET
      payload_hash = excluded.payload_hash, state = excluded.state, terminal_status = NULL,
      journal_json = excluded.journal_json, created_at = excluded.created_at, updated_at = excluded.updated_at
    WHERE toon_workspace_recovery_journals.state = 'terminal' AND toon_workspace_recovery_journals.terminal_status = 'rolled_back'`, [
      record.workspaceScope, record.projectId, record.operationId, record.payloadHash, record.state,
      JSON.stringify(record.journal), now, now,
    ]);
  }

  updateJournal(workspaceScope: string, projectId: string, operationId: string, state: ToonWorkspaceJournalRecord["state"], terminalStatus?: string, now = Date.now()): void {
    this.database.run(`UPDATE toon_workspace_recovery_journals SET state = ?, terminal_status = ?, updated_at = ?
      WHERE workspace_scope = ? AND project_id = ? AND operation_id = ?`,
    [state, terminalStatus ?? null, now, workspaceScope, projectId, operationId]);
  }

  listRecoverable(workspaceScope?: string): ToonWorkspaceJournalRecord[] {
    const rows = workspaceScope
      ? this.database.all<JournalRow>(`SELECT workspace_scope, project_id, operation_id, payload_hash, state, terminal_status, journal_json
          FROM toon_workspace_recovery_journals WHERE state <> 'terminal' AND workspace_scope = ? ORDER BY created_at`, [workspaceScope])
      : this.database.all<JournalRow>(`SELECT workspace_scope, project_id, operation_id, payload_hash, state, terminal_status, journal_json
          FROM toon_workspace_recovery_journals WHERE state <> 'terminal' ORDER BY created_at`);
    return rows.map((row) => ({
      workspaceScope: row.workspace_scope,
      projectId: row.project_id,
      operationId: row.operation_id,
      payloadHash: row.payload_hash,
      state: row.state,
      ...(row.terminal_status ? { terminalStatus: row.terminal_status } : {}),
      journal: JSON.parse(row.journal_json) as Record<string, unknown>,
    }));
  }

  hasRecoverable(workspaceScope: string, projectId: string, operationId: string): boolean {
    return Boolean(this.database.get(
      "SELECT 1 AS present FROM toon_workspace_recovery_journals WHERE workspace_scope = ? AND project_id = ? AND operation_id = ? AND state <> 'terminal'",
      [workspaceScope, projectId, operationId],
    ));
  }

  acquireLease(workspaceScope: string, projectId: string, leaseId: string, holder: string, expiresAt: number, now = Date.now()): void {
    this.database.transaction(() => {
      const current = this.database.get<{ lease_id: string; expires_at: number }>(`SELECT lease_id, expires_at FROM toon_workspace_write_leases
        WHERE workspace_scope = ? AND project_id = ?`, [workspaceScope, projectId]);
      if (current && current.lease_id !== leaseId && current.expires_at > now) {
        throw new ApiError(409, "toon_project_locked", "The project is currently locked by another writer");
      }
      this.database.run(`INSERT INTO toon_workspace_write_leases(workspace_scope, project_id, lease_id, holder, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_scope, project_id) DO UPDATE SET
        lease_id = excluded.lease_id, holder = excluded.holder, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      [workspaceScope, projectId, leaseId, holder, expiresAt, now]);
    });
  }

  releaseLease(workspaceScope: string, projectId: string, leaseId: string): void {
    this.database.run("DELETE FROM toon_workspace_write_leases WHERE workspace_scope = ? AND project_id = ? AND lease_id = ?", [workspaceScope, projectId, leaseId]);
  }

  purgeExpiredLeases(now = Date.now()): number {
    return this.database.transaction(() => this.database.run("DELETE FROM toon_workspace_write_leases WHERE expires_at <= ?", [now]).changes
      + this.database.run("DELETE FROM toon_workspace_canvas_leases WHERE expires_at <= ?", [now]).changes);
  }

  cleanup(policy: ToonWorkspaceCleanupPolicy): ToonWorkspaceCleanupResult {
    const now = policy.now ?? Date.now();
    return this.database.transaction(() => {
      const leases = this.database.run("DELETE FROM toon_workspace_write_leases WHERE expires_at <= ?", [now]).changes
        + this.database.run("DELETE FROM toon_workspace_canvas_leases WHERE expires_at <= ?", [now]).changes;
      const journals = this.database.run(
        "DELETE FROM toon_workspace_recovery_journals WHERE state = 'terminal' AND updated_at < ?",
        [now - policy.completedJournalGraceMs],
      ).changes;
      this.database.run("DELETE FROM toon_workspace_authorizations WHERE expires_at < ? AND consumed_at IS NULL", [now]);
      const orphanProjects = this.database.all<{ workspace_scope: string; project_id: string }>(
        `SELECT projects.workspace_scope, projects.project_id FROM toon_workspace_projects projects
         WHERE projects.unavailable_since IS NOT NULL AND projects.unavailable_since < ?
         AND NOT EXISTS (SELECT 1 FROM toon_workspace_conversation_cleanups cleanup
           WHERE cleanup.workspace_scope=projects.workspace_scope AND cleanup.project_id=projects.project_id)`,
        [now - policy.unavailableMappingGraceMs],
      );
      const runtimeTables = [
        "toon_workspace_assistant_events", "toon_workspace_assistant_messages", "toon_workspace_assistant_interactions",
        "toon_workspace_assistant_turns", "toon_workspace_conversation_details", "toon_workspace_event_cursors",
        "toon_workspace_tool_calls", "toon_workspace_generation_links", "toon_workspace_authorizations",
        "toon_workspace_operation_outcomes", "toon_workspace_recovery_journals", "toon_workspace_canvas_leases",
        "toon_workspace_write_leases", "toon_workspace_turn_sessions", "toon_workspace_session_lineage", "toon_workspace_conversation_cleanup_sessions", "toon_workspace_conversation_cleanups", "toon_workspace_conversations",
      ];
      for (const project of orphanProjects) {
        for (const table of runtimeTables) this.database.run(`DELETE FROM ${table} WHERE workspace_scope = ? AND project_id = ?`, [project.workspace_scope, project.project_id]);
        this.database.run("DELETE FROM toon_workspace_projects WHERE workspace_scope = ? AND project_id = ?", [project.workspace_scope, project.project_id]);
      }
      const mappings = orphanProjects.length;
      let events = 0;
      const conversations = this.database.all<{ workspace_scope: string; project_id: string; conversation_id: string }>(
        "SELECT DISTINCT workspace_scope, project_id, conversation_id FROM toon_workspace_assistant_events",
      );
      for (const conversation of conversations) {
        const retained = this.database.all<{ sequence: number; created_at: number }>(
          `SELECT sequence, created_at FROM toon_workspace_assistant_events
           WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ? ORDER BY sequence DESC`,
          [conversation.workspace_scope, conversation.project_id, conversation.conversation_id],
        );
        const removable = retained.slice(Math.max(0, policy.retainedAssistantEvents)).filter((row) => row.created_at < now - policy.assistantEventGraceMs);
        for (const row of removable) {
          events += this.database.run(
            "DELETE FROM toon_workspace_assistant_events WHERE workspace_scope = ? AND project_id = ? AND conversation_id = ? AND sequence = ?",
            [conversation.workspace_scope, conversation.project_id, conversation.conversation_id, row.sequence],
          ).changes;
        }
      }
      return { leases, journals, mappings, events };
    });
  }

  acquireCanvasLease(workspaceScope: string, projectId: string, canvasId: string, leaseId: string, holder: string, expiresAt: number, now = Date.now()): { leaseToken: string; generation: number } {
    return this.database.transaction(() => {
      const current = this.database.get<{ lease_id: string; lease_token: string; generation: number; expires_at: number }>(`SELECT lease_id, lease_token, generation, expires_at FROM toon_workspace_canvas_leases
        WHERE workspace_scope = ? AND project_id = ? AND canvas_id = ?`, [workspaceScope, projectId, canvasId]);
      if (current && current.lease_id !== leaseId && current.expires_at > now) throw new ApiError(409, "toon_canvas_lease_conflict", "The canvas is active in another editor");
      const renewing = current?.lease_id === leaseId && current.expires_at > now && current.lease_token.length > 0 && current.generation > 0;
      const leaseToken = renewing ? current.lease_token : `lease-${randomUUID()}`;
      const generation = renewing ? current.generation : (current?.generation ?? 0) + 1;
      this.database.run(`INSERT INTO toon_workspace_canvas_leases(workspace_scope, project_id, canvas_id, lease_id, holder, lease_token, generation, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_scope, project_id, canvas_id) DO UPDATE SET
        lease_id = excluded.lease_id, holder = excluded.holder, lease_token = excluded.lease_token, generation = excluded.generation, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      [workspaceScope, projectId, canvasId, leaseId, holder, leaseToken, generation, expiresAt, now]);
      const stored = this.database.get<{ lease_token: string; generation: number }>(`SELECT lease_token, generation FROM toon_workspace_canvas_leases
        WHERE workspace_scope = ? AND project_id = ? AND canvas_id = ?`, [workspaceScope, projectId, canvasId]);
      if (!stored) throw new ApiError(500, "toon_canvas_lease_failed", "The canvas editor lease could not be persisted");
      return { leaseToken: stored.lease_token, generation: stored.generation };
    });
  }

  assertCanvasLease(workspaceScope: string, projectId: string, canvasId: string, leaseToken: string | undefined, generation: number | undefined, now = Date.now()): void {
    const current = this.database.get<{ lease_token: string; generation: number; expires_at: number }>(`SELECT lease_token, generation, expires_at FROM toon_workspace_canvas_leases
      WHERE workspace_scope = ? AND project_id = ? AND canvas_id = ?`, [workspaceScope, projectId, canvasId]);
    if (!current || current.expires_at <= now || current.lease_token !== leaseToken || current.generation !== generation) {
      throw new ApiError(409, "toon_canvas_lease_invalid", "The canvas editor lease is missing, expired, or superseded");
    }
  }

  releaseCanvasLease(workspaceScope: string, projectId: string, canvasId: string, leaseId: string): void {
    this.database.run("UPDATE toon_workspace_canvas_leases SET expires_at = 0, updated_at = ? WHERE workspace_scope = ? AND project_id = ? AND canvas_id = ? AND lease_id = ?", [Date.now(), workspaceScope, projectId, canvasId, leaseId]);
  }
}
