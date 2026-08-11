import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionPendingOperationStore, SessionPendingOperationError } from "./session-pending-operations.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "jugglework-pending-"));
  directories.push(directory);
  let time = 1_000;
  let id = 0;
  const path = join(directory, "runtime.sqlite");
  const store = await createSessionPendingOperationStore({ path, now: () => ++time, randomUUID: () => `pending-${++id}` });
  store.enableRemoteAcceptance();
  return { path, store };
}

describe("session pending operation store", () => {
  test("persists FIFO queue state and content-free audits across restart", async () => {
    const { path, store } = await fixture();
    const first = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "secret prompt one", commandCorrelationId: "cmd-1" });
    const second = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "secret prompt two", commandCorrelationId: "cmd-2" });
    expect(store.claimNext("ws", "ses")?.id).toBe(first.id);
    store.markAdmitted(first.id, "admission-1");
    store.close();

    const reopened = await createSessionPendingOperationStore({ path, now: () => 2_000, randomUUID: () => "unused" });
    reopened.enableRemoteAcceptance();
    expect(reopened.get(first.id)?.state).toBe("admitted");
    expect(reopened.claimNext("ws", "ses")?.id).toBe(second.id);
    const audits = reopened.listAudits();
    expect(JSON.stringify(audits)).not.toContain("secret prompt");
    expect(audits.map((item) => item.action)).toEqual(["created", "created", "claimed", "admitted", "claimed"]);
    reopened.close();
  });

  test("cancellation is exact, idempotent, and wins before claim", async () => {
    const { store } = await fixture();
    const item = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "queued", commandCorrelationId: "cmd-1" });
    expect(store.cancel(item.id, "cancel-1").cancelled).toBe(true);
    expect(store.cancel(item.id, "cancel-1").cancelled).toBe(false);
    expect(store.claimNext("ws", "ses")).toBeNull();
    store.close();
  });

  test("claimed and admitted work is not cancellable", async () => {
    const { store } = await fixture();
    const item = store.create({ workspaceId: "ws", sessionId: "ses", mode: "steer", prompt: "steer", commandCorrelationId: "cmd-1" });
    store.claimNext("ws", "ses", "steer");
    expect(() => store.cancel(item.id, "cancel-1")).toThrow(SessionPendingOperationError);
    store.markAdmitted(item.id, "admission-1");
    expect(store.get(item.id)?.prompt).toBe("");
    expect(() => store.cancel(item.id, "cancel-2")).toThrow("not_cancellable");
    store.markCompleted(item.id);
    expect(store.get(item.id)).toMatchObject({ state: "completed", prompt: "" });
    store.close();
  });

  test("restart safely retries an unfinished deterministic admission identity", async () => {
    const { path, store } = await fixture();
    const item = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "queued", commandCorrelationId: "cmd-1" });
    store.claimNext("ws", "ses");
    store.close();
    const reopened = await createSessionPendingOperationStore({ path, now: () => 5_000, randomUUID: () => "unused" });
    reopened.enableRemoteAcceptance();
    expect(reopened.get(item.id)?.state).toBe("dispatching");
    expect(reopened.get(item.id)?.errorCode).toBe("admission_outcome_unknown");
    expect(reopened.claimNext("ws", "ses")).toBeNull();
    reopened.close();
  });

  test("stop all atomically cancels every pending row without nested transactions", async () => {
    const { store } = await fixture();
    store.create({ workspaceId: "ws", sessionId: "one", mode: "enqueue", prompt: "secret one", commandCorrelationId: "cmd-1" });
    store.create({ workspaceId: "ws", sessionId: "two", mode: "enqueue", prompt: "secret two", commandCorrelationId: "cmd-2" });
    expect(store.cancelAllPendingRemote("stop-all-1").cancelled).toBe(2);
    expect(store.list().every((item) => item.state === "cancelled" && item.prompt === "")).toBe(true);
    expect(JSON.stringify(store.listAudits())).not.toContain("secret");
    store.close();
  });

  test("disabling one mode atomically cancels and redacts only pending rows of that mode", async () => {
    const { store } = await fixture();
    const steer = store.create({ workspaceId: "ws", sessionId: "ses", mode: "steer", prompt: "steer secret", commandCorrelationId: "cmd-steer" });
    const enqueue = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "enqueue secret", commandCorrelationId: "cmd-enqueue" });

    expect(store.enableRemoteAcceptance({ steer: true, enqueue: false }, "policy-change-1")).toMatchObject({ cancelled: 1 });
    expect(store.get(steer.id)).toMatchObject({ state: "pending", prompt: "steer secret" });
    expect(store.get(enqueue.id)).toMatchObject({ state: "cancelled", prompt: "", errorCode: "policy_mode_disabled" });
    expect(store.listAudits(enqueue.id).at(-1)).toMatchObject({
      action: "cancelled",
      commandCorrelationId: "policy-change-1",
      outcome: "policy_mode_disabled",
    });
    expect(JSON.stringify(store.listAudits(enqueue.id))).not.toContain("enqueue secret");

    store.enableRemoteAcceptance({ steer: true, enqueue: true }, "policy-change-2");
    expect(store.claimNext("ws", "ses", "enqueue")).toBeNull();
    store.close();
  });

  test("future schema fails closed", async () => {
    const { path, store } = await fixture();
    store.close();
    const { Database } = await import("bun:sqlite");
    const db = new Database(path);
    db.run("UPDATE session_pending_operation_meta SET schema_version = 99 WHERE singleton = 1");
    db.close();
    await expect(createSessionPendingOperationStore({ path })).rejects.toThrow("store_unavailable");
  });

  test("upgrades a partial v1 schema column-by-column and starts fenced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jugglework-pending-v1-"));
    directories.push(directory);
    const path = join(directory, "runtime.sqlite");
    const { Database } = await import("bun:sqlite");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE session_pending_operation_meta (singleton INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, remote_accepting INTEGER NOT NULL DEFAULT 1);
      INSERT INTO session_pending_operation_meta(singleton, schema_version, remote_accepting) VALUES (1, 1, 1);
      CREATE TABLE session_pending_operations (
        id TEXT PRIMARY KEY, workspace_id TEXT, session_id TEXT, mode TEXT, prompt TEXT, origin TEXT,
        command_correlation_id TEXT, state TEXT, queue_sequence INTEGER, admitted_id TEXT, error_code TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE session_pending_operation_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, pending_operation_id TEXT, workspace_id TEXT, session_id TEXT,
        mode TEXT, action TEXT, command_correlation_id TEXT, outcome TEXT, occurred_at INTEGER
      );
    `);
    db.close();
    const store = await createSessionPendingOperationStore({ path });
    expect(store.acceptance()).toMatchObject({ enabled: false, steer: false, enqueue: false });
    store.close();
  });

  test("bounds identifiers and locally stored prompt content", async () => {
    const { path, store } = await fixture();
    expect(() => store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "", commandCorrelationId: "cmd" })).toThrow("invalid_request");
    expect(() => store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "x".repeat(200_001), commandCorrelationId: "cmd" })).toThrow("invalid_request");
    expect(() => store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "界".repeat(66_667), commandCorrelationId: "cmd-bytes" })).toThrow("invalid_request");
    store.close();
    expect((await readFile(path)).length).toBeGreaterThan(0);
  });
});
