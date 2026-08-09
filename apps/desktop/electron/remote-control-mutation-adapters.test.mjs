import assert from "node:assert/strict";
import { test } from "node:test";

import { createRemoteControlMutationRegistrations } from "./remote-control-mutation-adapters.mjs";
import { RemoteControlOperationExecutionError } from "./remote-control-operations.mjs";
import { createSessionMutationCoordinator } from "./session-mutation-coordinator.mjs";

const WORKSPACE_ID = "ws_test";
const WORKSPACE_PATH = "/home/user/ws_test";
const SESSION_ID = "ses_test";

function fakeWorkspaceStore() {
  return {
    async readWorkspaceState() {
      return {
        workspaces: [
          { id: WORKSPACE_ID, name: "Test", path: WORKSPACE_PATH },
          { id: "ws_remote", name: "Remote", path: "/remote", workspaceType: "remote" },
        ],
      };
    },
  };
}

function fakeManagedClient({ postResult = null, getStatus = 404, sessionDirectory = WORKSPACE_PATH, workspaces = null } = {}) {
  const calls = [];
  return {
    calls,
    async getJson(pathname) {
      calls.push({ method: "GET", pathname });
      if (pathname === "/workspaces" && workspaces) {
        return { items: workspaces };
      }
      if (pathname.includes(`/sessions/${SESSION_ID}`)) {
        return { item: { id: SESSION_ID, directory: sessionDirectory, title: "Test Session" } };
      }
      return {};
    },
    async postJson(pathname, body) {
      calls.push({ method: "POST", pathname, body });
      if (getStatus !== 200 && getStatus !== 204) {
        const error = new Error("http error");
        error.name = "ManagedRuntimeClientError";
        /** @type {any} */ (error).code = "http_error";
        /** @type {any} */ (error).status = getStatus;
        throw error;
      }
      return postResult;
    },
  };
}

function harness(options = {}) {
  const coordinator = createSessionMutationCoordinator({ randomUUID: () => "run_test", now: () => 1000 });
  const client = options.client ?? fakeManagedClient({ postResult: null, getStatus: 204, workspaces: [{ id: WORKSPACE_ID, name: "Test", path: WORKSPACE_PATH, workspaceType: "local" }] });
  const registrations = createRemoteControlMutationRegistrations({
    workspaceStore: fakeWorkspaceStore(),
    managedRuntimeClient: client,
    coordinator,
  });
  return { coordinator, client, registrations };
}

test("session.prompt registration validates strict arguments", () => {
  const { registrations } = harness();
  const prompt = registrations.find((r) => r.operation === "session.prompt");
  assert.ok(prompt.validateArguments({ workspaceId: "ws_test", sessionId: "ses_test", prompt: "hello" }));
  assert.throws(() => prompt.validateArguments({ workspaceId: "ws_test", sessionId: "ses_test" }));
  assert.throws(() => prompt.validateArguments({ workspaceId: "ws_test", sessionId: "ses_test", prompt: "" }));
});

test("session.prompt sends prompt_async and returns runId and generation", async () => {
  const { registrations, client } = harness();
  const prompt = registrations.find((r) => r.operation === "session.prompt");
  const result = await prompt.execute({
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "do something" },
    context: { featureGates: { sessionMutation: true } },
  });
  assert.deepEqual(result, { runId: "run_test", generation: 1 });
  const postCall = client.calls.find((c) => c.method === "POST");
  assert.ok(postCall.pathname.includes("prompt_async"));
  assert.deepEqual(postCall.body, { parts: [{ type: "text", text: "do something" }] });
});

test("session.prompt rejects a remote workspace", async () => {
  const { registrations } = harness();
  const prompt = registrations.find((r) => r.operation === "session.prompt");
  await assert.rejects(
    prompt.execute({ arguments: { workspaceId: "ws_remote", sessionId: SESSION_ID, prompt: "x" }, context: {} }),
    (error) => error instanceof RemoteControlOperationExecutionError && error.code === "workspace_not_found",
  );
});

test("session.prompt rejects cross-workspace session", async () => {
  const client = fakeManagedClient({ sessionDirectory: "/different/path" });
  const { registrations } = harness({ client });
  const prompt = registrations.find((r) => r.operation === "session.prompt");
  await assert.rejects(
    prompt.execute({ arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "x" }, context: {} }),
    (error) => error instanceof RemoteControlOperationExecutionError && error.code === "session_not_found",
  );
});

test("session.abort rejects with run_mismatch for wrong expectedRunId", async () => {
  const { registrations, coordinator } = harness();
  coordinator.beginRun({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  const abort = registrations.find((r) => r.operation === "session.abort");
  await assert.rejects(
    abort.execute({ arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, expectedRunId: "wrong" }, context: {} }),
    (error) => error instanceof RemoteControlOperationExecutionError && /** @type {any} */ (error.code) === "run_mismatch",
  );
});

test("session.abort succeeds after prompt and sends abort request", async () => {
  const { registrations, coordinator, client } = harness();
  const prompt = registrations.find((r) => r.operation === "session.prompt");
  const abort = registrations.find((r) => r.operation === "session.abort");
  const promptResult = await prompt.execute({
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "work" },
    context: { featureGates: { sessionMutation: true } },
  });
  const abortResult = await abort.execute({
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, expectedRunId: promptResult.runId },
    context: { featureGates: { sessionMutation: true } },
  });
  assert.deepEqual(abortResult, { runId: "run_test", abortRequested: true });
  const abortCall = client.calls.find((c) => c.method === "POST" && c.pathname.includes("abort"));
  assert.ok(abortCall);
  assert.equal(coordinator.getActiveRunId({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }), null);
});

test("session.prompt rejects session_busy on double begin", async () => {
  const { registrations, coordinator } = harness();
  const prompt = registrations.find((r) => r.operation === "session.prompt");
  await prompt.execute({
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "first" },
    context: { featureGates: { sessionMutation: true } },
  });
  await assert.rejects(
    prompt.execute({
      arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "second" },
      context: { featureGates: { sessionMutation: true } },
    }),
    (error) => error instanceof RemoteControlOperationExecutionError && /** @type {any} */ (error.code) === "session_busy",
  );
});
