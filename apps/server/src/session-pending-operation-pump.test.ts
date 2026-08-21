import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionMutationCoordinator } from "./session-mutation-coordinator.js";
import { createSessionPendingOperationPump } from "./session-pending-operation-pump.js";
import { createSessionPendingOperationStore } from "./session-pending-operations.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "jugglework-pending-pump-"));
  directories.push(directory);
  const path = join(directory, "runtime.sqlite");
  let id = 0;
  const store = await createSessionPendingOperationStore({ path, randomUUID: () => `pending-${++id}` });
  store.enableRemoteAcceptance();
  return { path, store };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("session pending operation reconciliation pump", () => {
  test("serializes wakeups and admits only the FIFO head", async () => {
    const { store } = await storeFixture();
    const first = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "first", commandCorrelationId: "cmd-1" });
    store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "second", commandCorrelationId: "cmd-2" });
    let concurrent = 0;
    let maximumConcurrent = 0;
    const admitted: string[] = [];
    const pump = createSessionPendingOperationPump({
      store,
      sessionMutations: createSessionMutationCoordinator(),
      intervalMs: 60_000,
      idleConfirmMs: 0,
      getSessionStatus: async () => "idle",
      admit: async (operation) => {
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        admitted.push(operation.id);
        concurrent -= 1;
      },
    });
    await Promise.all([pump.wake(), pump.wake(), pump.wake()]);
    expect(maximumConcurrent).toBe(1);
    expect(admitted).toEqual([first.id]);
    expect(store.list().map((item) => item.state)).toEqual(["admitted", "pending"]);
    await pump.close();
    store.close();
  });

  test("recovers a crash-time claim and retries the same durable ID without duplicate admission", async () => {
    const { path, store } = await storeFixture();
    const operation = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "retry", commandCorrelationId: "cmd" });
    store.claimNext("ws", "ses");
    store.close();

    const reopened = await createSessionPendingOperationStore({ path });
    reopened.enableRemoteAcceptance();
    // Model a crash after OpenCode durably admitted the ID but before Desktop
    // committed markAdmitted. Re-sending the same ID must not execute twice.
    const upstreamAdmissions = new Set<string>([operation.id]);
    let upstreamExecutions = 1;
    let status: "idle" | "busy" = "idle";
    const pump = createSessionPendingOperationPump({
      store: reopened,
      sessionMutations: createSessionMutationCoordinator(),
      intervalMs: 60_000,
      idleConfirmMs: 0,
      getSessionStatus: async () => status,
      admit: async (candidate) => {
        if (!upstreamAdmissions.has(candidate.id)) upstreamExecutions += 1;
        upstreamAdmissions.add(candidate.id);
      },
    });
    await waitUntil(() => reopened.get(operation.id)?.state === "admitted");
    status = "busy";
    await pump.wake();
    status = "idle";
    await pump.wake();
    await pump.wake();
    expect(upstreamAdmissions).toEqual(new Set([operation.id]));
    expect(upstreamExecutions).toBe(1);
    expect(reopened.get(operation.id)).toMatchObject({ state: "completed", prompt: "" });
    await pump.close();
    reopened.close();
  });

  test("authoritative idle completes admitted rows and releases the local run", async () => {
    const { store } = await storeFixture();
    const operation = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "run", commandCorrelationId: "cmd" });
    store.claimNext("ws", "ses");
    const mutations = createSessionMutationCoordinator({ randomUUID: () => "run-1" });
    const run = mutations.reserveStart({ workspaceId: "ws", sessionId: "ses", origin: "remote-control", startCommandCorrelationId: "cmd" });
    mutations.acceptStart({ workspaceId: "ws", sessionId: "ses", runId: run.runId });
    store.markAdmitted(operation.id, run.runId);

    let status: "idle" | "busy" = "idle";
    const pump = createSessionPendingOperationPump({
      store,
      sessionMutations: mutations,
      intervalMs: 60_000,
      idleConfirmMs: 0,
      getSessionStatus: async () => status,
      admit: async () => { throw new Error("must not admit"); },
    });
    await pump.wake();
    expect(["admitted", "completed", undefined]).toContain(store.get(operation.id)?.state);
    status = "busy";
    await pump.wake();
    status = "idle";
    await pump.wake();
    await pump.wake();
    await waitUntil(() => store.get(operation.id)?.state === "completed");
    expect(mutations.getActive("ws", "ses")).toBeNull();
    expect(store.get(operation.id)?.prompt).toBe("");
    await pump.close();
    store.close();
  });

  test("authoritative idle releases an ordinary stale run before admitting queued work", async () => {
    const { store } = await storeFixture();
    const queued = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "next", commandCorrelationId: "cmd-next" });
    const mutations = createSessionMutationCoordinator({ randomUUID: (() => {
      let id = 0;
      return () => `run-${++id}`;
    })() });
    const stale = mutations.reserveStart({ workspaceId: "ws", sessionId: "ses", origin: "local-renderer", startCommandCorrelationId: "cmd-old" });
    mutations.acceptStart({ workspaceId: "ws", sessionId: "ses", runId: stale.runId });
    const admitted: string[] = [];
    const pump = createSessionPendingOperationPump({
      store,
      sessionMutations: mutations,
      intervalMs: 60_000,
      idleConfirmMs: 0,
      getSessionStatus: async () => "idle",
      admit: async (operation) => { admitted.push(operation.id); },
    });

    await pump.wake();
    await pump.wake();
    await waitUntil(() => store.get(queued.id)?.state === "admitted");
    expect(admitted).toEqual([queued.id]);
    expect(mutations.getActive("ws", "ses")).toMatchObject({ startCommandCorrelationId: "cmd-next" });
    await pump.close();
    store.close();
  });

  test("close stops and awaits lifecycle reconciliation", async () => {
    const { store } = await storeFixture();
    store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "queued", commandCorrelationId: "cmd" });
    let checks = 0;
    const pump = createSessionPendingOperationPump({
      store,
      sessionMutations: createSessionMutationCoordinator(),
      intervalMs: 5,
      getSessionStatus: async () => { checks += 1; return "busy"; },
      admit: async () => {},
    });
    await waitUntil(() => checks > 0);
    await pump.close();
    const closedAt = checks;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(checks).toBe(closedAt);
    store.close();
  });

  test("close preserves an interrupted admission as ambiguous dispatching", async () => {
    const { store } = await storeFixture();
    const operation = store.create({ workspaceId: "ws", sessionId: "ses", mode: "enqueue", prompt: "queued", commandCorrelationId: "cmd" });
    let started = false;
    const pump = createSessionPendingOperationPump({
      store,
      sessionMutations: createSessionMutationCoordinator(),
      intervalMs: 60_000,
      getSessionStatus: async () => "idle",
      admit: async (_operation, signal) => {
        started = true;
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    await waitUntil(() => started);
    await pump.close();
    expect(store.get(operation.id)).toMatchObject({ state: "dispatching", errorCode: null, prompt: "queued" });
    store.close();
  });

  test("bounded passes rotate across live sessions", async () => {
    const { store } = await storeFixture();
    for (let index = 0; index < 3; index++) {
      store.create({ workspaceId: "ws", sessionId: `ses-${index}`, mode: "enqueue", prompt: "queued", commandCorrelationId: `cmd-${index}` });
    }
    const checked: string[] = [];
    const pump = createSessionPendingOperationPump({
      store,
      sessionMutations: createSessionMutationCoordinator(),
      intervalMs: 60_000,
      maxSessionsPerPass: 2,
      getSessionStatus: async (_workspaceId, sessionId) => { checked.push(sessionId); return "busy"; },
      admit: async () => {},
    });
    await waitUntil(() => checked.length === 2);
    await pump.wake();
    expect(new Set(checked)).toEqual(new Set(["ses-0", "ses-1", "ses-2"]));
    await pump.close();
    store.close();
  });

  test("mode disable cancels persisted rows and re-enable cannot admit them", async () => {
    const { store } = await storeFixture();
    const steer = store.create({ workspaceId: "ws", sessionId: "steer-session", mode: "steer", prompt: "steer", commandCorrelationId: "cmd-steer" });
    const enqueue = store.create({ workspaceId: "ws", sessionId: "enqueue-session", mode: "enqueue", prompt: "enqueue", commandCorrelationId: "cmd-enqueue" });
    const admitted: string[] = [];
    const pump = createSessionPendingOperationPump({
      store,
      sessionMutations: createSessionMutationCoordinator(),
      intervalMs: 60_000,
      isModeEnabled: async () => false,
      getSessionStatus: async () => "idle",
      admit: async (operation) => { admitted.push(operation.id); },
    });
    await pump.drained();

    expect(pump.enable({ steer: true, enqueue: false })).toMatchObject({ cancelled: 1 });
    expect(store.get(enqueue.id)).toMatchObject({ state: "cancelled", prompt: "" });
    expect(store.get(steer.id)?.state).toBe("pending");
    pump.enable({ steer: true, enqueue: true });
    await pump.wake();
    expect(admitted).toEqual([]);
    expect(store.get(enqueue.id)?.state).toBe("cancelled");
    await pump.close();
    store.close();
  });
});
