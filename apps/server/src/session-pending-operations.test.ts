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
    expect(() => store.cancel(item.id, "cancel-2")).toThrow("not_cancellable");
    store.close();
  });

  test("restart fails ambiguous dispatch closed instead of duplicating", async () => {
    const { path, store } = await fixture();
    const item = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "queued", commandCorrelationId: "cmd-1" });
    store.claimNext("ws", "ses");
    store.close();
    const reopened = await createSessionPendingOperationStore({ path, now: () => 5_000, randomUUID: () => "unused" });
    expect(reopened.get(item.id)?.state).toBe("failed");
    expect(reopened.get(item.id)?.errorCode).toBe("restart_outcome_unknown");
    expect(reopened.claimNext("ws", "ses")).toBeNull();
    reopened.close();
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

  test("bounds identifiers and locally stored prompt content", async () => {
    const { path, store } = await fixture();
    expect(() => store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "", commandCorrelationId: "cmd" })).toThrow("invalid_request");
    expect(() => store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "x".repeat(200_001), commandCorrelationId: "cmd" })).toThrow("invalid_request");
    store.close();
    expect((await readFile(path)).length).toBeGreaterThan(0);
  });
});
