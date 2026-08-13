import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanonicalAgentEvent,
  CanonicalAgentMessage,
  CanonicalAgentSession,
  CanonicalSessionSnapshot,
} from "@jugglework/types/agent-runtime";
import { openRuntimeSqliteDatabase, runtimeSqliteAdapter } from "../runtime-db.js";
import { AGENT_RUNTIME_DATABASE_VERSION, agentRuntimeDatabaseVersion, migrateAgentRuntimeDatabase } from "./migrations.js";
import {
  AGENT_RUNTIME_MAX_CONFIG_BYTES,
  AgentRuntimePersistenceError,
  AgentRuntimeRepository,
  type AppendCanonicalEventInput,
} from "./repository.js";
import { replayCanonicalEvents } from "./replay.js";

const NOW = Date.parse("2026-08-13T00:00:00Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent runtime persistence", () => {
  test("migrates an existing runtime database idempotently", async () => {
    const fixture = await database("migration");
    fixture.database.exec("CREATE TABLE existing_runtime_records(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    fixture.database.run("INSERT INTO existing_runtime_records(id, value) VALUES (?, ?)", ["old", "preserved"]);
    migrateAgentRuntimeDatabase(fixture.database, NOW);
    migrateAgentRuntimeDatabase(fixture.database, NOW + 1);
    expect(agentRuntimeDatabaseVersion(fixture.database)).toBe(AGENT_RUNTIME_DATABASE_VERSION);
    expect(fixture.database.get<{ id: string; value: string }>("SELECT * FROM existing_runtime_records WHERE id = ?", ["old"])).toEqual({ id: "old", value: "preserved" });
    for (const table of ["agent_sessions", "agent_session_links", "agent_messages", "agent_parts", "agent_events", "agent_event_sequences", "agent_event_snapshot_state", "agent_event_receipts", "agent_run_usage", "agent_policy_audits"]) {
      expect(fixture.database.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])?.name).toBe(table);
    }
    fixture.database.close();
  });

  test("bounds payloads, binds backend sessions once, sequences events idempotently, and redacts inspection", async () => {
    const fixture = await repositoryFixture("repository");
    const repository = fixture.repository;
    repository.createSession(session());
    repository.createSession(session({ id: "session-2", runtimeId: "claude-agent", backendSessionId: "claude-backend" }));
    const link = {
      sourceSessionId: "session-1",
      targetSessionId: "session-2",
      type: "migration" as const,
      contextDigest: "a".repeat(64),
      createdAt: NOW,
    };
    repository.addSessionLink(link);
    expect(repository.listSessionLinks("session-1")).toEqual([link]);
    expect(repository.bindBackendSession("session-1", "backend-secret").backendSessionId).toBe("backend-secret");
    expect(repository.bindBackendSession("session-1", "backend-secret").backendSessionId).toBe("backend-secret");
    expect(() => repository.bindBackendSession("session-1", "other-backend")).toThrow(AgentRuntimePersistenceError);

    const first = repository.appendEvent(messageEvent("event-1", message("private transcript"), NOW + 1));
    const duplicate = repository.appendEvent(messageEvent("event-1", message("private transcript"), NOW + 1));
    const second = repository.appendEvent(statusEvent("event-2", NOW + 2));
    expect([first.sequence, duplicate.sequence, second.sequence]).toEqual([1, 1, 2]);
    expect(repository.listEvents("session-1").map((event) => event.id)).toEqual(["event-1", "event-2"]);
    expect(() => repository.appendEvent(statusEvent("event-1", NOW + 3))).toThrow(AgentRuntimePersistenceError);

    repository.putRunUsage("run-1", "session-1", { inputTokens: 2, outputTokens: 3, estimateOnly: true }, NOW + 2);
    expect(() => repository.putRunUsage("run-1", "session-2", { estimateOnly: true }, NOW + 3)).toThrow(AgentRuntimePersistenceError);
    const inspection = repository.inspectSession("session-1");
    expect(inspection?.counts).toEqual({ messages: 1, parts: 1, events: 2, runs: 1 });
    expect(inspection?.partTypes).toEqual({ text: 1 });
    expect(JSON.stringify(inspection)).not.toContain("private transcript");
    expect(JSON.stringify(inspection)).not.toContain("backend-secret");
    expect(JSON.stringify(inspection)).not.toContain("/private/workspace");

    expect(() => repository.createSession(session({
      id: "oversized",
      configuration: { value: "x".repeat(AGENT_RUNTIME_MAX_CONFIG_BYTES) },
    }))).toThrow(new AgentRuntimePersistenceError("payload_too_large", `session configuration exceeds ${AGENT_RUNTIME_MAX_CONFIG_BYTES} bytes`));
    repository.close();
  });

  test("lazily maps a legacy OpenCode session without changing its backend identifier", async () => {
    const fixture = await repositoryFixture("legacy");
    let loads = 0;
    const load = async () => {
      loads += 1;
      return {
        workspaceId: "workspace-1",
        title: "Legacy",
        canonicalCwd: "/legacy/workspace",
        createdAt: NOW,
        updatedAt: NOW,
      };
    };
    const mapped = await fixture.repository.resolveLegacyOpenCodeSession("ses_legacy", load);
    const reopened = await fixture.repository.resolveLegacyOpenCodeSession("ses_legacy", load);
    expect(mapped).toMatchObject({ id: "ses_legacy", runtimeId: "jugglework", backendSessionId: "ses_legacy" });
    expect(reopened).toEqual(mapped);
    expect(loads).toBe(1);
    fixture.repository.close();
  });

  test("atomically creates continuation history with a source link and digest while preview cancellation creates nothing", async () => {
    const fixture = await repositoryFixture("continuation");
    fixture.repository.createSession(session());
    expect(fixture.repository.listSessions("workspace-1")).toHaveLength(1);
    expect(fixture.repository.listSessionLinks("session-1")).toEqual([]);

    const target = session({
      id: "session-claude",
      runtimeId: "claude-agent",
      title: "Continue: Session",
      configuration: {},
      createdAt: NOW + 10,
      updatedAt: NOW + 10,
    });
    const link = {
      sourceSessionId: "session-1",
      targetSessionId: target.id,
      type: "migration" as const,
      contextDigest: "b".repeat(64),
      createdAt: NOW + 10,
    };
    fixture.repository.createContinuation({
      session: target,
      link,
      context: {
        summary: "Reviewed summary",
        transcript: [
          { sourceMessageId: "source-user", role: "user", text: "Original request" },
          { sourceMessageId: "source-assistant", role: "assistant", text: "Completed work" },
        ],
      },
    });

    expect(fixture.repository.listSessions("workspace-1").map(({ id }) => id).sort()).toEqual(["session-1", "session-claude"]);
    expect(fixture.repository.listSessionLinks("session-1")).toEqual([link]);
    expect(fixture.repository.listSessionLinks("session-claude")).toEqual([link]);
    expect(fixture.repository.buildSnapshot("session-1").messages).toEqual([]);
    expect(fixture.repository.buildSnapshot("session-claude").messages).toEqual([
      expect.objectContaining({
        role: "user",
        metadata: expect.objectContaining({ kind: "cross-runtime-migration", sourceSessionId: "session-1", contextDigest: "b".repeat(64) }),
        parts: [expect.objectContaining({ type: "text", text: expect.stringContaining("User\nOriginal request") })],
      }),
    ]);
    fixture.repository.close();
  });

  test("rebuilds snapshots, detects replay gaps, suppresses duplicates, and recovers after restart", async () => {
    const fixture = await repositoryFixture("snapshot");
    fixture.repository.createSession(session());
    const event1 = fixture.repository.appendEvent(messageEvent("event-1", message("hello"), NOW + 1));
    const event2 = fixture.repository.appendEvent(statusEvent("event-2", NOW + 2));
    const snapshot = fixture.repository.buildSnapshot("session-1");
    expect(snapshot.messages[0]?.parts[0]).toMatchObject({ type: "text", text: "hello" });
    expect(snapshot.latestSequence).toBe(2);
    fixture.repository.close();

    const reopenedRuntime = await openRuntimeSqliteDatabase(fixture.path);
    const reopened = AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(reopenedRuntime));
    expect(reopened.buildSnapshot("session-1")).toEqual(snapshot);

    const base = emptySnapshot(session());
    const replayed = replayCanonicalEvents(base, [event1, event1, event2]);
    expect(replayed.requiresSnapshot).toBe(false);
    expect(replayed.applied).toBe(2);
    expect(replayed.duplicateEventIds).toEqual(["event-1"]);
    expect(replayed.snapshot).toEqual(snapshot);

    const missed = replayCanonicalEvents(base, [{ ...event2, sequence: 2 }]);
    expect(missed).toMatchObject({ requiresSnapshot: true, applied: 0, gap: { expectedSequence: 1, receivedSequence: 2 } });
    reopened.close();
  });

  test("retains a bounded replay window without losing snapshot state or duplicate receipts", async () => {
    const fixture = await database("retention");
    const repository = AgentRuntimeRepository.fromDatabase(fixture.database, {
      maxRetainedEventsPerSession: 3,
      maxEventReceiptsPerSession: 6,
    });
    repository.createSession(session());
    const todo: AppendCanonicalEventInput = {
      schemaVersion: 1,
      id: "event-todo",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      runtimeId: "jugglework",
      occurredAt: NOW + 1,
      data: {
        type: "todo.updated",
        todos: [{ id: "todo-1", content: "Retain me", status: "pending", priority: "medium" }],
      },
    };
    const first = repository.appendEventWithResult(todo);
    for (let index = 2; index <= 6; index += 1) repository.appendEvent(statusEvent(`event-${index}`, NOW + index));

    expect(repository.eventWindow("session-1")).toEqual({ earliestSequence: 4, latestSequence: 6, retainedCount: 3 });
    expect(repository.listEvents("session-1").map((event) => event.sequence)).toEqual([4, 5, 6]);
    expect(repository.buildSnapshot("session-1")).toMatchObject({
      latestSequence: 6,
      todos: [{ id: "todo-1", content: "Retain me" }],
    });
    expect(repository.appendEventWithResult(todo)).toEqual({ event: first.event, inserted: false });
    repository.close();
  });

  test("rolls back projection changes when event persistence fails", async () => {
    const fixture = await repositoryFixture("atomic-publication");
    fixture.repository.createSession(session());
    const invalid: AppendCanonicalEventInput = {
      ...messageEvent("event-invalid", message("not persisted"), NOW + 1),
      data: {
        type: "message.updated",
        message: { ...message("not persisted"), id: "message-invalid", sessionId: "other-session" },
      },
    };

    expect(() => fixture.repository.appendEvent(invalid)).toThrow();
    expect(fixture.repository.getMessage("message-invalid")).toBeNull();
    expect(fixture.repository.eventWindow("session-1")).toEqual({ earliestSequence: null, latestSequence: 0, retainedCount: 0 });
    fixture.repository.close();
  });

  test("fails closed on transcript corruption without rewriting the damaged record", async () => {
    const fixture = await repositoryFixture("transcript-corruption");
    fixture.repository.createSession(session());
    fixture.repository.appendEvent(messageEvent("event-corrupt", message("preserve before corruption"), NOW + 1));
    fixture.database.run("UPDATE agent_parts SET payload_json = ? WHERE id = ?", ["{not-json", "part-1"]);

    expect(() => fixture.repository.buildSnapshot("session-1"))
      .toThrow(new AgentRuntimePersistenceError("corrupt_record", "persisted part is invalid"));
    expect(fixture.repository.getSession("session-1")?.title).toBe("Session");
    expect(fixture.database.get<{ payload_json: string }>("SELECT payload_json FROM agent_parts WHERE id = ?", ["part-1"])?.payload_json)
      .toBe("{not-json");
    expect(fixture.repository.listEvents("session-1").map(({ id }) => id)).toEqual(["event-corrupt"]);
    fixture.repository.close();
  });
});

async function database(name: string) {
  const root = await mkdtemp(join(tmpdir(), `jugglework-agent-runtime-${name}-`));
  roots.push(root);
  const path = join(root, "runtime.sqlite");
  const runtime = await openRuntimeSqliteDatabase(path);
  return { path, database: runtimeSqliteAdapter(runtime) };
}

async function repositoryFixture(name: string) {
  const fixture = await database(name);
  return { ...fixture, repository: AgentRuntimeRepository.fromDatabase(fixture.database) };
}

function session(overrides: Partial<CanonicalAgentSession> = {}): CanonicalAgentSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    runtimeId: "jugglework",
    backendSessionId: null,
    title: "Session",
    canonicalCwd: "/private/workspace",
    status: { type: "idle" },
    configuration: { provider: "private-provider" },
    createdAt: NOW,
    updatedAt: NOW,
    lastError: null,
    ...overrides,
  };
}

function message(text: string): CanonicalAgentMessage {
  return {
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    parentId: null,
    createdAt: NOW + 1,
    completedAt: NOW + 1,
    parts: [{
      id: "part-1",
      messageId: "message-1",
      sessionId: "session-1",
      ordinal: 0,
      createdAt: NOW + 1,
      updatedAt: NOW + 1,
      type: "text",
      text,
      state: "complete",
    }],
  };
}

function messageEvent(id: string, value: CanonicalAgentMessage, occurredAt: number): AppendCanonicalEventInput {
  return {
    schemaVersion: 1,
    id,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    runtimeId: "jugglework",
    occurredAt,
    data: { type: "message.updated", message: value },
  };
}

function statusEvent(id: string, occurredAt: number): AppendCanonicalEventInput {
  return {
    schemaVersion: 1,
    id,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    runtimeId: "jugglework",
    occurredAt,
    data: { type: "session.status", status: { type: "running" } },
  };
}

function emptySnapshot(value: CanonicalAgentSession): CanonicalSessionSnapshot {
  return { schemaVersion: 1, session: value, messages: [], todos: [], interactions: [], latestSequence: 0 };
}
