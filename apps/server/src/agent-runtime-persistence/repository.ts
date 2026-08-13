import { createHash } from "node:crypto";
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  canonicalAgentEventSchema,
  canonicalAgentMessageSchema,
  canonicalAgentPartSchema,
  canonicalAgentSessionSchema,
  canonicalAgentTodoSchema,
  canonicalAgentUsageSchema,
  canonicalInteractionSchema,
  canonicalSessionLinkSchema,
  canonicalSessionSnapshotSchema,
  type CanonicalAgentEvent,
  type CanonicalAgentEventData,
  type CanonicalAgentMessage,
  type CanonicalAgentPart,
  type CanonicalAgentSession,
  type CanonicalAgentTodo,
  type CanonicalAgentUsage,
  type CanonicalInteraction,
  type CanonicalSessionLink,
  type CanonicalSessionSnapshot,
  type CanonicalSessionStatus,
  type AgentContinuationContext,
} from "@jugglework/types/agent-runtime";
import { openRuntimeSqliteDatabase, runtimeDbPath, runtimeSqliteAdapter, type RuntimeSqlite } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { migrateAgentRuntimeDatabase } from "./migrations.js";

export const AGENT_RUNTIME_MAX_CONFIG_BYTES = 256 * 1024;
export const AGENT_RUNTIME_MAX_METADATA_BYTES = 128 * 1024;
export const AGENT_RUNTIME_MAX_PART_BYTES = 4 * 1024 * 1024;
export const AGENT_RUNTIME_MAX_EVENT_BYTES = 6 * 1024 * 1024;
export const AGENT_RUNTIME_MAX_USAGE_BYTES = 512 * 1024;
export const AGENT_RUNTIME_DEFAULT_EVENT_LIMIT = 500;
export const AGENT_RUNTIME_MAX_EVENT_LIMIT = 2_000;
export const AGENT_RUNTIME_DEFAULT_RETAINED_EVENTS = 10_000;
export const AGENT_RUNTIME_MAX_CONTINUATION_BYTES = 160 * 1024;

export type AgentRuntimePersistenceErrorCode =
  | "invalid_record"
  | "payload_too_large"
  | "binding_conflict"
  | "not_found"
  | "corrupt_record";

export class AgentRuntimePersistenceError extends Error {
  constructor(public readonly code: AgentRuntimePersistenceErrorCode, message: string) {
    super(message);
    this.name = "AgentRuntimePersistenceError";
  }
}

export type AppendCanonicalEventInput = Omit<CanonicalAgentEvent, "sequence">;

export type AppendCanonicalEventResult = {
  event: CanonicalAgentEvent;
  inserted: boolean;
};

export type CanonicalEventWindow = {
  earliestSequence: number | null;
  latestSequence: number;
  retainedCount: number;
};

export type LegacyOpenCodeSession = {
  backendSessionId: string;
  workspaceId: string;
  title?: string | null;
  canonicalCwd: string;
  status?: CanonicalSessionStatus;
  configuration?: CanonicalAgentSession["configuration"];
  createdAt: number;
  updatedAt: number;
};

export type AgentSessionInspection = {
  sessionId: string;
  workspaceId: string;
  runtimeId: string;
  backendSessionBound: boolean;
  statusType: CanonicalSessionStatus["type"];
  createdAt: number;
  updatedAt: number;
  counts: { messages: number; parts: number; events: number; runs: number };
  payloadBytes: { configuration: number; messages: number; parts: number; events: number; usage: number };
  partTypes: Record<string, number>;
  eventTypes: Record<string, number>;
};

type SessionRow = {
  id: string;
  workspace_id: string;
  runtime_id: string;
  backend_session_id: string | null;
  title: string;
  canonical_cwd: string;
  status_json: string;
  config_snapshot_json: string;
  created_at: number;
  updated_at: number;
  last_error_json: string | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: CanonicalAgentMessage["role"];
  parent_id: string | null;
  created_at: number;
  completed_at: number | null;
  metadata_json: string;
};

type PartRow = { message_id: string; payload_json: string };

type EventRow = {
  session_id: string;
  sequence: number;
  event_id: string;
  workspace_id: string;
  runtime_id: string;
  payload_json: string;
  created_at: number;
};

type SessionLinkRow = {
  source_session_id: string;
  target_session_id: string;
  link_type: CanonicalSessionLink["type"];
  context_digest: string;
  created_at: number;
};

type EventReceiptRow = {
  session_id: string;
  sequence: number;
  fingerprint: string;
};

type EventSnapshotStateRow = {
  todos_json: string;
  interactions_json: string;
  latest_sequence: number;
};

export type AgentRuntimeRepositoryOptions = {
  maxRetainedEventsPerSession?: number;
  maxEventReceiptsPerSession?: number;
};

export class AgentRuntimeRepository {
  readonly #maxRetainedEventsPerSession: number;
  readonly #maxEventReceiptsPerSession: number;

  private constructor(private readonly database: RuntimeSqlite, options: AgentRuntimeRepositoryOptions = {}) {
    this.#maxRetainedEventsPerSession = positiveBound(
      options.maxRetainedEventsPerSession ?? AGENT_RUNTIME_DEFAULT_RETAINED_EVENTS,
      "maxRetainedEventsPerSession",
    );
    this.#maxEventReceiptsPerSession = positiveBound(
      options.maxEventReceiptsPerSession ?? this.#maxRetainedEventsPerSession * 2,
      "maxEventReceiptsPerSession",
    );
    this.backfillEventReceipts();
  }

  static async open(config: ServerConfig): Promise<AgentRuntimeRepository> {
    const runtime = await openRuntimeSqliteDatabase(runtimeDbPath(config));
    return AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(runtime));
  }

  static fromDatabase(database: RuntimeSqlite, options: AgentRuntimeRepositoryOptions = {}): AgentRuntimeRepository {
    migrateAgentRuntimeDatabase(database);
    return new AgentRuntimeRepository(database, options);
  }

  close(): void {
    this.database.close();
  }

  createSession(input: CanonicalAgentSession): CanonicalAgentSession {
    const session = parseSession(input);
    return this.database.transaction(() => this.createSessionStatements(session));
  }

  getSession(id: string): CanonicalAgentSession | null {
    const row = this.database.get<SessionRow>("SELECT * FROM agent_sessions WHERE id = ?", [requiredId(id)]);
    return row ? sessionFromRow(row) : null;
  }

  getSessionByBackend(runtimeId: string, backendSessionId: string): CanonicalAgentSession | null {
    const row = this.database.get<SessionRow>(
      "SELECT * FROM agent_sessions WHERE runtime_id = ? AND backend_session_id = ?",
      [requiredId(runtimeId), requiredId(backendSessionId)],
    );
    return row ? sessionFromRow(row) : null;
  }

  listSessions(workspaceId: string): CanonicalAgentSession[] {
    return this.database.all<SessionRow>(
      "SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC",
      [requiredId(workspaceId)],
    ).map(sessionFromRow);
  }

  updateSession(input: CanonicalAgentSession): CanonicalAgentSession {
    const session = parseSession(input);
    return this.database.transaction(() => this.updateSessionStatements(session));
  }

  deleteSession(id: string): boolean {
    return this.database.run("DELETE FROM agent_sessions WHERE id = ?", [requiredId(id)]).changes > 0;
  }

  bindBackendSession(sessionId: string, backendSessionId: string): CanonicalAgentSession {
    return this.database.transaction(() => this.bindBackendSessionStatements(sessionId, backendSessionId));
  }

  addSessionLink(input: CanonicalSessionLink): CanonicalSessionLink {
    const link = canonicalSessionLinkSchema.parse(input);
    this.database.run(
      `INSERT INTO agent_session_links(source_session_id, target_session_id, link_type, context_digest, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_session_id, target_session_id, link_type) DO NOTHING`,
      [link.sourceSessionId, link.targetSessionId, link.type, link.contextDigest, link.createdAt],
    );
    return link;
  }

  createContinuation(input: {
    session: CanonicalAgentSession;
    link: CanonicalSessionLink;
    context: AgentContinuationContext;
  }): { session: CanonicalAgentSession; link: CanonicalSessionLink } {
    const session = parseSession(input.session);
    const link = canonicalSessionLinkSchema.parse(input.link);
    if (link.targetSessionId !== session.id || link.type !== "migration") {
      bindingConflict("continuation link does not target the created session");
    }
    requiredSession(this.getSession(link.sourceSessionId));
    boundedJson("continuation context", input.context, AGENT_RUNTIME_MAX_CONTINUATION_BYTES);
    const contextText = [
      `Migration summary\n${input.context.summary}`,
      ...input.context.transcript.map((entry) => `${entry.role === "user" ? "User" : "Assistant"}\n${entry.text}`),
    ].join("\n\n");
    return this.database.transaction(() => {
      const created = this.createSessionStatements(session);
      const messageId = `migration-context:${created.id}`;
      const timestamp = link.createdAt;
      this.putMessageStatements({
        id: messageId,
        sessionId: created.id,
        role: "user",
        parentId: null,
        createdAt: timestamp,
        completedAt: timestamp,
        metadata: {
          kind: "cross-runtime-migration",
          sourceSessionId: link.sourceSessionId,
          contextDigest: link.contextDigest,
        },
        parts: [{
          id: `${messageId}:text`,
          messageId,
          sessionId: created.id,
          ordinal: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          type: "text",
          text: contextText,
          state: "complete",
        }],
      });
      this.database.run(
        `INSERT INTO agent_session_links(source_session_id, target_session_id, link_type, context_digest, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [link.sourceSessionId, link.targetSessionId, link.type, link.contextDigest, link.createdAt],
      );
      return { session: created, link };
    });
  }

  listSessionLinks(sessionId: string): CanonicalSessionLink[] {
    return this.database.all<SessionLinkRow>(
      `SELECT source_session_id, target_session_id, link_type, context_digest, created_at
       FROM agent_session_links WHERE source_session_id = ? OR target_session_id = ?
       ORDER BY created_at, source_session_id, target_session_id`,
      [requiredId(sessionId), sessionId],
    ).map((row) => canonicalSessionLinkSchema.parse({
      sourceSessionId: row.source_session_id,
      targetSessionId: row.target_session_id,
      type: row.link_type,
      contextDigest: row.context_digest,
      createdAt: Number(row.created_at),
    }));
  }

  mapLegacyOpenCodeSession(input: LegacyOpenCodeSession): CanonicalAgentSession {
    const backendSessionId = requiredId(input.backendSessionId);
    const existing = this.getSessionByBackend("jugglework", backendSessionId) ?? this.getSession(backendSessionId);
    if (existing) {
      if (existing.runtimeId !== "jugglework" || existing.backendSessionId !== backendSessionId) {
        bindingConflict("legacy OpenCode identifier is already bound differently");
      }
      return existing;
    }
    return this.createSession({
      id: backendSessionId,
      workspaceId: input.workspaceId,
      runtimeId: "jugglework",
      backendSessionId,
      title: input.title?.trim() || "Untitled session",
      canonicalCwd: input.canonicalCwd,
      status: input.status ?? { type: "idle" },
      configuration: input.configuration ?? {},
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      lastError: null,
    });
  }

  async resolveLegacyOpenCodeSession(
    backendSessionId: string,
    load: () => Promise<Omit<LegacyOpenCodeSession, "backendSessionId"> | null>,
  ): Promise<CanonicalAgentSession | null> {
    const id = requiredId(backendSessionId);
    const existing = this.getSessionByBackend("jugglework", id) ?? this.getSession(id);
    if (existing) return existing;
    const legacy = await load();
    return legacy ? this.mapLegacyOpenCodeSession({ ...legacy, backendSessionId: id }) : null;
  }

  putMessage(input: CanonicalAgentMessage, backendMessageId?: string | null): CanonicalAgentMessage {
    const message = canonicalAgentMessageSchema.parse(input);
    return this.database.transaction(() => {
      this.putMessageStatements(message, backendMessageId);
      return requiredMessage(this.getMessage(message.id));
    });
  }

  getMessage(id: string): CanonicalAgentMessage | null {
    const row = this.database.get<MessageRow>("SELECT * FROM agent_messages WHERE id = ?", [requiredId(id)]);
    if (!row) return null;
    const parts = this.database.all<PartRow>(
      "SELECT message_id, payload_json FROM agent_parts WHERE message_id = ? ORDER BY ordinal, id",
      [row.id],
    ).map(partFromRow);
    return messageFromRow(row, parts);
  }

  putPart(input: CanonicalAgentPart, backendPartId?: string | null): CanonicalAgentPart {
    const part = canonicalAgentPartSchema.parse(input);
    return this.database.transaction(() => {
      this.putPartStatements(part, backendPartId);
      return requiredPart(this.getPart(part.id));
    });
  }

  getPart(id: string): CanonicalAgentPart | null {
    const row = this.database.get<PartRow>("SELECT message_id, payload_json FROM agent_parts WHERE id = ?", [requiredId(id)]);
    return row ? partFromRow(row) : null;
  }

  putRunUsage(runId: string, sessionId: string, usageInput: CanonicalAgentUsage, occurredAt: number): CanonicalAgentUsage {
    const usage = canonicalAgentUsageSchema.parse(usageInput);
    const payload = boundedJson("run usage", usage, AGENT_RUNTIME_MAX_USAGE_BYTES);
    const canonicalSessionId = requiredId(sessionId);
    const canonicalRunId = requiredId(runId);
    requiredSession(this.getSession(canonicalSessionId));
    const existing = this.database.get<{ session_id: string }>(
      "SELECT session_id FROM agent_run_usage WHERE run_id = ?",
      [canonicalRunId],
    );
    if (existing && existing.session_id !== canonicalSessionId) bindingConflict("run usage belongs to another session");
    this.database.run(
      `INSERT INTO agent_run_usage(run_id, session_id, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
       WHERE agent_run_usage.session_id = excluded.session_id`,
      [canonicalRunId, canonicalSessionId, payload, occurredAt, occurredAt],
    );
    return usage;
  }

  getRunUsage(runId: string): CanonicalAgentUsage | null {
    const row = this.database.get<{ payload_json: string }>(
      "SELECT payload_json FROM agent_run_usage WHERE run_id = ?",
      [requiredId(runId)],
    );
    return row ? parseJson("run usage", row.payload_json, canonicalAgentUsageSchema.parse) : null;
  }

  appendEvent(input: AppendCanonicalEventInput): CanonicalAgentEvent {
    return this.appendEventWithResult(input).event;
  }

  appendEventWithResult(input: AppendCanonicalEventInput): AppendCanonicalEventResult {
    return this.database.transaction(() => {
      const duplicate = this.getEventById(input.id);
      if (duplicate) {
        if (!sameEventInput(duplicate, input)) bindingConflict("event identifier was reused with different content");
        return { event: duplicate, inserted: false };
      }
      const receipt = this.database.get<EventReceiptRow>(
        "SELECT session_id, sequence, fingerprint FROM agent_event_receipts WHERE event_id = ?",
        [requiredId(input.id)],
      );
      if (receipt) {
        if (receipt.session_id !== input.sessionId || receipt.fingerprint !== eventFingerprint(input)) {
          bindingConflict("event identifier was reused with different content");
        }
        return {
          event: canonicalAgentEventSchema.parse({ ...input, sequence: Number(receipt.sequence) }),
          inserted: false,
        };
      }
      const session = requiredSession(this.getSession(input.sessionId));
      if (session.workspaceId !== input.workspaceId || session.runtimeId !== input.runtimeId) {
        bindingConflict("event ownership does not match its session binding");
      }
      const sequence = Number(this.database.get<{ sequence: number }>(
        `INSERT INTO agent_event_sequences(session_id, next_sequence) VALUES (?, 1)
         ON CONFLICT(session_id) DO UPDATE SET next_sequence = agent_event_sequences.next_sequence + 1
         RETURNING next_sequence AS sequence`,
        [input.sessionId],
      )?.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new AgentRuntimePersistenceError("corrupt_record", "event sequence allocation failed");
      const event = canonicalAgentEventSchema.parse({ ...input, sequence });
      const payload = boundedJson("event payload", event.data, AGENT_RUNTIME_MAX_EVENT_BYTES);
      this.prepareEventProjectionStatements(event);
      this.applyEventProjectionStatements(event);
      this.database.run(
        `INSERT INTO agent_events(session_id, sequence, event_id, workspace_id, runtime_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [event.sessionId, event.sequence, event.id, event.workspaceId, event.runtimeId, event.data.type, payload, event.occurredAt],
      );
      this.database.run(
        `INSERT INTO agent_event_receipts(event_id, session_id, sequence, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [event.id, event.sessionId, event.sequence, eventFingerprint(input), event.occurredAt],
      );
      this.updateEventSnapshotStateStatements(event);
      this.pruneEventRetentionStatements(event.sessionId);
      return { event, inserted: true };
    });
  }

  getEventById(eventId: string): CanonicalAgentEvent | null {
    const row = this.database.get<EventRow>("SELECT * FROM agent_events WHERE event_id = ?", [requiredId(eventId)]);
    return row ? eventFromRow(row) : null;
  }

  listEvents(sessionId: string, afterSequence = 0, limit = AGENT_RUNTIME_DEFAULT_EVENT_LIMIT): CanonicalAgentEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) invalid("afterSequence must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_RUNTIME_MAX_EVENT_LIMIT) invalid("invalid event limit");
    return this.database.all<EventRow>(
      "SELECT * FROM agent_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      [requiredId(sessionId), afterSequence, limit],
    ).map(eventFromRow);
  }

  eventWindow(sessionId: string): CanonicalEventWindow {
    const id = requiredId(sessionId);
    requiredSession(this.getSession(id));
    const retained = this.database.get<{ earliest: number | null; latest: number | null; count: number }>(
      `SELECT MIN(sequence) AS earliest, MAX(sequence) AS latest, COUNT(*) AS count
       FROM agent_events WHERE session_id = ?`,
      [id],
    );
    const state = this.eventSnapshotState(id);
    return {
      earliestSequence: retained?.earliest == null ? null : Number(retained.earliest),
      latestSequence: Math.max(state.latestSequence, Number(retained?.latest ?? 0)),
      retainedCount: Number(retained?.count ?? 0),
    };
  }

  buildSnapshot(sessionId: string): CanonicalSessionSnapshot {
    const session = requiredSession(this.getSession(sessionId));
    const rows = this.database.all<MessageRow>(
      "SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at, id",
      [session.id],
    );
    const partRows = this.database.all<PartRow>(
      "SELECT message_id, payload_json FROM agent_parts WHERE session_id = ? ORDER BY message_id, ordinal, id",
      [session.id],
    );
    const partsByMessage = new Map<string, CanonicalAgentPart[]>();
    for (const row of partRows) {
      const parts = partsByMessage.get(row.message_id) ?? [];
      parts.push(partFromRow(row));
      partsByMessage.set(row.message_id, parts);
    }
    const messages = rows.map((row) => messageFromRow(row, partsByMessage.get(row.id) ?? []));
    const state = this.eventSnapshotState(session.id);
    return canonicalSessionSnapshotSchema.parse({
      schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
      session,
      messages,
      todos: state.todos,
      interactions: state.interactions,
      latestSequence: state.latestSequence,
    });
  }

  inspectSession(sessionId: string): AgentSessionInspection | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const totals = this.database.get<{
      messages: number; parts: number; events: number; runs: number;
      message_bytes: number; part_bytes: number; event_bytes: number; usage_bytes: number; config_bytes: number;
    }>(`SELECT
      (SELECT COUNT(*) FROM agent_messages WHERE session_id = ?) AS messages,
      (SELECT COUNT(*) FROM agent_parts WHERE session_id = ?) AS parts,
      (SELECT COUNT(*) FROM agent_events WHERE session_id = ?) AS events,
      (SELECT COUNT(*) FROM agent_run_usage WHERE session_id = ?) AS runs,
      (SELECT COALESCE(SUM(length(CAST(metadata_json AS BLOB))), 0) FROM agent_messages WHERE session_id = ?) AS message_bytes,
      (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) FROM agent_parts WHERE session_id = ?) AS part_bytes,
      (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) FROM agent_events WHERE session_id = ?) AS event_bytes,
      (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) FROM agent_run_usage WHERE session_id = ?) AS usage_bytes,
      (SELECT length(CAST(config_snapshot_json AS BLOB)) FROM agent_sessions WHERE id = ?) AS config_bytes`,
      [session.id, session.id, session.id, session.id, session.id, session.id, session.id, session.id, session.id],
    );
    const partTypes = countsByType(this.database.all<{ type: string; count: number }>(
      "SELECT type, COUNT(*) AS count FROM agent_parts WHERE session_id = ? GROUP BY type",
      [session.id],
    ));
    const eventTypes = countsByType(this.database.all<{ type: string; count: number }>(
      "SELECT type, COUNT(*) AS count FROM agent_events WHERE session_id = ? GROUP BY type",
      [session.id],
    ));
    return {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      runtimeId: session.runtimeId,
      backendSessionBound: session.backendSessionId !== null,
      statusType: session.status.type,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      counts: {
        messages: Number(totals?.messages ?? 0),
        parts: Number(totals?.parts ?? 0),
        events: Number(totals?.events ?? 0),
        runs: Number(totals?.runs ?? 0),
      },
      payloadBytes: {
        configuration: Number(totals?.config_bytes ?? 0),
        messages: Number(totals?.message_bytes ?? 0),
        parts: Number(totals?.part_bytes ?? 0),
        events: Number(totals?.event_bytes ?? 0),
        usage: Number(totals?.usage_bytes ?? 0),
      },
      partTypes,
      eventTypes,
    };
  }

  private createSessionStatements(session: CanonicalAgentSession): CanonicalAgentSession {
    const existing = this.getSession(session.id);
    if (existing) {
      assertSameBinding(existing, session);
      return existing;
    }
    const configuration = boundedJson("session configuration", session.configuration, AGENT_RUNTIME_MAX_CONFIG_BYTES);
    const status = boundedJson("session status", session.status, AGENT_RUNTIME_MAX_METADATA_BYTES);
    const lastError = session.lastError === null ? null : boundedJson("session error", session.lastError, AGENT_RUNTIME_MAX_METADATA_BYTES);
    try {
      this.database.run(
        `INSERT INTO agent_sessions(
          id, workspace_id, runtime_id, backend_session_id, title, canonical_cwd, status_json,
          config_snapshot_json, created_at, updated_at, last_error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [session.id, session.workspaceId, session.runtimeId, session.backendSessionId, session.title, session.canonicalCwd,
          status, configuration, session.createdAt, session.updatedAt, lastError],
      );
      this.database.run(
        `INSERT INTO agent_event_snapshot_state(session_id, todos_json, interactions_json, latest_sequence)
         VALUES (?, '[]', '[]', 0) ON CONFLICT(session_id) DO NOTHING`,
        [session.id],
      );
    } catch (error) {
      if (isConstraintError(error)) bindingConflict("session binding conflicts with an existing record");
      throw error;
    }
    return requiredSession(this.getSession(session.id));
  }

  private updateSessionStatements(session: CanonicalAgentSession): CanonicalAgentSession {
    let current = requiredSession(this.getSession(session.id));
    assertSameImmutableSession(current, session);
    if (current.backendSessionId === null && session.backendSessionId !== null) {
      current = this.bindBackendSessionStatements(session.id, session.backendSessionId);
    } else if (current.backendSessionId !== session.backendSessionId) {
      bindingConflict("backend session binding cannot change");
    }
    if (session.updatedAt < current.updatedAt) return current;
    this.database.run(
      "UPDATE agent_sessions SET title = ?, status_json = ?, updated_at = ?, last_error_json = ? WHERE id = ?",
      [session.title, boundedJson("session status", session.status, AGENT_RUNTIME_MAX_METADATA_BYTES), session.updatedAt,
        session.lastError === null ? null : boundedJson("session error", session.lastError, AGENT_RUNTIME_MAX_METADATA_BYTES), session.id],
    );
    return requiredSession(this.getSession(session.id));
  }

  private bindBackendSessionStatements(sessionId: string, backendSessionId: string): CanonicalAgentSession {
    const current = requiredSession(this.getSession(sessionId));
    const backendId = requiredId(backendSessionId);
    if (current.backendSessionId === backendId) return current;
    if (current.backendSessionId !== null) bindingConflict("backend session is already bound");
    const existing = this.getSessionByBackend(current.runtimeId, backendId);
    if (existing && existing.id !== current.id) bindingConflict("backend session belongs to another canonical session");
    const result = this.database.run(
      "UPDATE agent_sessions SET backend_session_id = ? WHERE id = ? AND backend_session_id IS NULL",
      [backendId, current.id],
    );
    if (result.changes !== 1) bindingConflict("backend session binding lost an atomic race");
    return requiredSession(this.getSession(current.id));
  }

  private putMessageStatements(message: CanonicalAgentMessage, backendMessageId?: string | null): void {
    requiredSession(this.getSession(message.sessionId));
    const backendId = backendMessageId == null ? null : requiredId(backendMessageId);
    const existing = this.database.get<{ session_id: string; backend_message_id: string | null }>(
      "SELECT session_id, backend_message_id FROM agent_messages WHERE id = ?",
      [message.id],
    );
    if (existing && (existing.session_id !== message.sessionId
      || (existing.backend_message_id !== null && backendId !== null && existing.backend_message_id !== backendId))) {
      bindingConflict("message binding cannot change");
    }
    const metadata = boundedJson("message metadata", message.metadata ?? {}, AGENT_RUNTIME_MAX_METADATA_BYTES);
    try {
      this.database.run(
        `INSERT INTO agent_messages(id, session_id, backend_message_id, role, parent_id, created_at, completed_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           backend_message_id = COALESCE(agent_messages.backend_message_id, excluded.backend_message_id),
           role = excluded.role, parent_id = excluded.parent_id, completed_at = excluded.completed_at,
           metadata_json = excluded.metadata_json`,
        [message.id, message.sessionId, backendId, message.role, message.parentId, message.createdAt, message.completedAt, metadata],
      );
      for (const part of message.parts) this.putPartStatements(part);
    } catch (error) {
      if (isConstraintError(error)) bindingConflict("message or part identity conflicts with an existing record");
      throw error;
    }
  }

  private putPartStatements(part: CanonicalAgentPart, backendPartId?: string | null): void {
    const message = this.database.get<{ session_id: string }>("SELECT session_id FROM agent_messages WHERE id = ?", [part.messageId]);
    if (!message) notFound("part message does not exist");
    if (message.session_id !== part.sessionId) bindingConflict("part ownership does not match its message");
    const backendId = backendPartId == null ? null : requiredId(backendPartId);
    const existing = this.database.get<{ session_id: string; message_id: string; backend_part_id: string | null }>(
      "SELECT session_id, message_id, backend_part_id FROM agent_parts WHERE id = ?",
      [part.id],
    );
    if (existing && (existing.session_id !== part.sessionId || existing.message_id !== part.messageId
      || (existing.backend_part_id !== null && backendId !== null && existing.backend_part_id !== backendId))) {
      bindingConflict("part binding cannot change");
    }
    const payload = boundedJson("canonical part", part, AGENT_RUNTIME_MAX_PART_BYTES);
    const state = "state" in part && typeof part.state === "string" ? part.state : null;
    try {
      this.database.run(
        `INSERT INTO agent_parts(id, session_id, message_id, backend_part_id, ordinal, type, state, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           backend_part_id = COALESCE(agent_parts.backend_part_id, excluded.backend_part_id),
           ordinal = excluded.ordinal, type = excluded.type, state = excluded.state,
           payload_json = excluded.payload_json, updated_at = excluded.updated_at
         WHERE excluded.updated_at >= agent_parts.updated_at`,
        [part.id, part.sessionId, part.messageId, backendId, part.ordinal, part.type, state, payload, part.updatedAt],
      );
    } catch (error) {
      if (isConstraintError(error)) bindingConflict("part identity or ordinal conflicts with an existing record");
      throw error;
    }
  }

  private applyEventProjectionStatements(event: CanonicalAgentEvent): void {
    switch (event.data.type) {
      case "session.created":
        this.createSessionStatements(event.data.session);
        break;
      case "session.updated":
        this.updateSessionStatements(event.data.session);
        break;
      case "session.status": {
        const current = requiredSession(this.getSession(event.sessionId));
        this.updateSessionStatements({ ...current, status: event.data.status, updatedAt: Math.max(current.updatedAt, event.occurredAt) });
        break;
      }
      case "message.updated":
        this.putMessageStatements(event.data.message);
        break;
      case "message.part.updated":
        this.putPartStatements(event.data.part);
        break;
      case "message.part.delta": {
        const current = requiredPart(this.getPart(event.data.partId));
        if (current.messageId !== event.data.messageId) bindingConflict("delta message does not own its part");
        let updated: CanonicalAgentPart;
        if (event.data.field === "text" && current.type === "text") {
          updated = { ...current, text: current.text + event.data.delta, updatedAt: event.occurredAt };
        } else if (event.data.field === "reasoning" && current.type === "reasoning") {
          updated = { ...current, text: current.text + event.data.delta, updatedAt: event.occurredAt };
        } else {
          invalid("delta field does not match the canonical part type");
        }
        this.putPartStatements(canonicalAgentPartSchema.parse(updated));
        break;
      }
      case "run.usage":
        this.putRunUsage(event.data.runId, event.sessionId, event.data.usage, event.occurredAt);
        break;
      case "run.completed":
        if (event.data.usage) this.putRunUsage(event.data.runId, event.sessionId, event.data.usage, event.occurredAt);
        break;
      case "interaction.requested":
      case "interaction.resolved":
      case "todo.updated":
      case "run.failed":
      case "run.aborted":
      case "run.configuration":
        break;
    }
  }

  private prepareEventProjectionStatements(event: CanonicalAgentEvent): void {
    if (event.data.type !== "message.part.updated" && event.data.type !== "message.part.delta") return;
    const messageId = event.data.messageId;
    let message = this.getMessage(messageId);
    if (!message) {
      message = {
        id: messageId,
        sessionId: event.sessionId,
        role: "assistant",
        parentId: null,
        createdAt: event.occurredAt,
        completedAt: null,
        parts: [],
      };
      this.putMessageStatements(message);
    }
    if (event.data.type !== "message.part.delta" || this.getPart(event.data.partId)) return;
    const base = {
      id: event.data.partId,
      messageId,
      sessionId: event.sessionId,
      ordinal: message.parts.length,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      text: "",
      state: "streaming" as const,
    };
    this.putPartStatements(event.data.field === "reasoning"
      ? { ...base, type: "reasoning", visibility: "visible" }
      : { ...base, type: "text" });
  }

  private updateEventSnapshotStateStatements(event: CanonicalAgentEvent): void {
    const current = this.eventSnapshotState(event.sessionId);
    let todos = current.todos;
    let interactions = current.interactions;
    if (event.data.type === "todo.updated") todos = event.data.todos;
    if (event.data.type === "interaction.requested" || event.data.type === "interaction.resolved") {
      const byId = new Map(interactions.map((interaction) => [interaction.id, interaction]));
      byId.set(event.data.interaction.id, event.data.interaction);
      interactions = [...byId.values()];
    }
    this.database.run(
      `INSERT INTO agent_event_snapshot_state(session_id, todos_json, interactions_json, latest_sequence)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         todos_json = excluded.todos_json,
         interactions_json = excluded.interactions_json,
         latest_sequence = MAX(agent_event_snapshot_state.latest_sequence, excluded.latest_sequence)`,
      [event.sessionId, boundedJson("snapshot todos", todos, AGENT_RUNTIME_MAX_EVENT_BYTES),
        boundedJson("snapshot interactions", interactions, AGENT_RUNTIME_MAX_EVENT_BYTES), event.sequence],
    );
  }

  private pruneEventRetentionStatements(sessionId: string): void {
    this.database.run(
      `DELETE FROM agent_events WHERE session_id = ? AND sequence IN (
         SELECT sequence FROM agent_events WHERE session_id = ?
         ORDER BY sequence DESC LIMIT -1 OFFSET ?
       )`,
      [sessionId, sessionId, this.#maxRetainedEventsPerSession],
    );
    this.database.run(
      `DELETE FROM agent_event_receipts WHERE event_id IN (
         SELECT event_id FROM agent_event_receipts WHERE session_id = ?
         ORDER BY sequence DESC LIMIT -1 OFFSET ?
       )`,
      [sessionId, this.#maxEventReceiptsPerSession],
    );
  }

  private eventSnapshotState(sessionId: string): {
    todos: CanonicalAgentTodo[];
    interactions: CanonicalInteraction[];
    latestSequence: number;
  } {
    const row = this.database.get<EventSnapshotStateRow>(
      "SELECT todos_json, interactions_json, latest_sequence FROM agent_event_snapshot_state WHERE session_id = ?",
      [sessionId],
    );
    if (row) {
      return parseCorrupt("event snapshot state", () => ({
        todos: canonicalAgentTodoSchema.array().max(10_000).parse(JSON.parse(row.todos_json)),
        interactions: canonicalInteractionSchema.array().max(10_000).parse(JSON.parse(row.interactions_json)),
        latestSequence: nonNegativeSequence(row.latest_sequence),
      }));
    }
    const rebuilt = this.rebuildEventOnlySnapshotState(sessionId);
    this.database.run(
      `INSERT INTO agent_event_snapshot_state(session_id, todos_json, interactions_json, latest_sequence)
       VALUES (?, ?, ?, ?)`,
      [sessionId, boundedJson("snapshot todos", rebuilt.todos, AGENT_RUNTIME_MAX_EVENT_BYTES),
        boundedJson("snapshot interactions", rebuilt.interactions, AGENT_RUNTIME_MAX_EVENT_BYTES), rebuilt.latestSequence],
    );
    return rebuilt;
  }

  private rebuildEventOnlySnapshotState(sessionId: string): {
    todos: CanonicalAgentTodo[];
    interactions: CanonicalInteraction[];
    latestSequence: number;
  } {
    const eventRows = this.database.all<EventRow>(
      `SELECT * FROM agent_events WHERE session_id = ?
       AND type IN ('todo.updated', 'interaction.requested', 'interaction.resolved')
       ORDER BY sequence`,
      [sessionId],
    );
    const events = eventRows.map(eventFromRow);
    const interactions = new Map<string, CanonicalInteraction>();
    let todos: CanonicalAgentTodo[] = [];
    let latestSequence = 0;
    for (const event of events) {
      latestSequence = event.sequence;
      if (event.data.type === "todo.updated") todos = event.data.todos;
      if (event.data.type === "interaction.requested" || event.data.type === "interaction.resolved") {
        interactions.set(event.data.interaction.id, event.data.interaction);
      }
    }
    const actualLatest = this.database.get<{ sequence: number }>(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_events WHERE session_id = ?",
      [sessionId],
    );
    return { todos, interactions: [...interactions.values()], latestSequence: Number(actualLatest?.sequence ?? latestSequence) };
  }

  private backfillEventReceipts(): void {
    this.database.transaction(() => {
      for (const row of this.database.all<EventRow>("SELECT * FROM agent_events ORDER BY session_id, sequence")) {
        const event = eventFromRow(row);
        const { sequence: _sequence, ...input } = event;
        this.database.run(
          `INSERT INTO agent_event_receipts(event_id, session_id, sequence, fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`,
          [event.id, event.sessionId, event.sequence, eventFingerprint(input), event.occurredAt],
        );
      }
    });
  }
}

function parseSession(input: CanonicalAgentSession): CanonicalAgentSession {
  try {
    return canonicalAgentSessionSchema.parse(input);
  } catch (error) {
    throw new AgentRuntimePersistenceError("invalid_record", error instanceof Error ? error.message : "invalid session");
  }
}

function sessionFromRow(row: SessionRow): CanonicalAgentSession {
  return parseCorrupt("session", () => canonicalAgentSessionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    runtimeId: row.runtime_id,
    backendSessionId: row.backend_session_id,
    title: row.title,
    canonicalCwd: row.canonical_cwd,
    status: JSON.parse(row.status_json),
    configuration: JSON.parse(row.config_snapshot_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastError: row.last_error_json === null ? null : JSON.parse(row.last_error_json),
  }));
}

function messageFromRow(row: MessageRow, parts: CanonicalAgentPart[]): CanonicalAgentMessage {
  return parseCorrupt("message", () => {
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    return canonicalAgentMessageSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      parentId: row.parent_id,
      createdAt: Number(row.created_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      parts,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  });
}

function partFromRow(row: PartRow): CanonicalAgentPart {
  return parseJson("part", row.payload_json, canonicalAgentPartSchema.parse);
}

function eventFromRow(row: EventRow): CanonicalAgentEvent {
  return parseCorrupt("event", () => canonicalAgentEventSchema.parse({
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    id: row.event_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    runtimeId: row.runtime_id,
    sequence: Number(row.sequence),
    occurredAt: Number(row.created_at),
    data: JSON.parse(row.payload_json) as CanonicalAgentEventData,
  }));
}

function boundedJson(label: string, value: unknown, maxBytes: number): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    invalid(`${label} is not JSON serializable`);
  }
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new AgentRuntimePersistenceError("payload_too_large", `${label} exceeds ${maxBytes} bytes`);
  }
  return json;
}

function parseJson<T>(label: string, json: string, parse: (value: unknown) => T): T {
  return parseCorrupt(label, () => parse(JSON.parse(json)));
}

function parseCorrupt<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new AgentRuntimePersistenceError("corrupt_record", `persisted ${label} is invalid`);
  }
}

function requiredId(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) invalid("invalid identifier");
  return value;
}

function assertSameBinding(existing: CanonicalAgentSession, input: CanonicalAgentSession): void {
  assertSameImmutableSession(existing, input);
  if (existing.backendSessionId !== input.backendSessionId) bindingConflict("backend session binding differs");
}

function assertSameImmutableSession(existing: CanonicalAgentSession, input: CanonicalAgentSession): void {
  if (existing.workspaceId !== input.workspaceId || existing.runtimeId !== input.runtimeId
    || existing.canonicalCwd !== input.canonicalCwd || existing.createdAt !== input.createdAt
    || JSON.stringify(existing.configuration) !== JSON.stringify(input.configuration)) {
    bindingConflict("immutable session binding differs");
  }
}

function sameEventInput(existing: CanonicalAgentEvent, input: AppendCanonicalEventInput): boolean {
  return existing.workspaceId === input.workspaceId
    && existing.sessionId === input.sessionId
    && existing.runtimeId === input.runtimeId
    && existing.occurredAt === input.occurredAt
    && JSON.stringify(existing.data) === JSON.stringify(input.data);
}

function eventFingerprint(input: AppendCanonicalEventInput): string {
  return createHash("sha256").update(JSON.stringify({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    runtimeId: input.runtimeId,
    occurredAt: input.occurredAt,
    data: input.data,
  })).digest("hex");
}

function positiveBound(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) invalid(`${field} is invalid`);
  return value;
}

function nonNegativeSequence(value: number): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid event sequence");
  return sequence;
}

function countsByType(rows: Array<{ type: string; count: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.type, Number(row.count)]));
}

function requiredSession(value: CanonicalAgentSession | null): CanonicalAgentSession {
  if (!value) notFound("agent session does not exist");
  return value;
}

function requiredMessage(value: CanonicalAgentMessage | null): CanonicalAgentMessage {
  if (!value) notFound("agent message does not exist");
  return value;
}

function requiredPart(value: CanonicalAgentPart | null): CanonicalAgentPart {
  if (!value) notFound("agent part does not exist");
  return value;
}

function invalid(message: string): never {
  throw new AgentRuntimePersistenceError("invalid_record", message);
}

function notFound(message: string): never {
  throw new AgentRuntimePersistenceError("not_found", message);
}

function bindingConflict(message: string): never {
  throw new AgentRuntimePersistenceError("binding_conflict", message);
}

function isConstraintError(error: unknown): boolean {
  return /constraint|unique|immutable/i.test(error instanceof Error ? error.message : String(error));
}
