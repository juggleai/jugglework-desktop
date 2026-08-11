import assert from "node:assert/strict";
import { test } from "node:test";

import { createRemoteControlMutationRegistrations } from "./remote-control-mutation-adapters.mjs";
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";
import { createRemoteControlOperationRegistry, RemoteControlOperationExecutionError } from "./remote-control-operations.mjs";
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

/** @param {{ postResult?: unknown, getStatus?: number, sessionDirectory?: string, workspaces?: any[] | null }} [options] */
function fakeManagedClient({ postResult, getStatus = 404, sessionDirectory = WORKSPACE_PATH, workspaces = null } = {}) {
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
      if (pathname.endsWith("/start")) {
        return postResult ?? { run: serverRun({ startCommandCorrelationId: body.startCommandCorrelationId }) };
      }
      if (pathname.endsWith("/abort")) {
        return postResult ?? { run: serverRun({ status: "aborting", abortCommandCorrelationId: body.abortCommandCorrelationId, abortRequestedAt: 1002, updatedAt: 1002 }), abortRequested: true };
      }
      if (pathname === `/workspace/${WORKSPACE_ID}/sessions`) {
        return postResult === undefined
          ? { item: { id: "ses_created", directory: WORKSPACE_PATH }, started: false }
          : postResult;
      }
      return postResult;
    },
  };
}

function serverRun(overrides = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    runId: "run_test",
    generation: 1,
    origin: "remote-control",
    startCommandCorrelationId: "cmd-start",
    abortCommandCorrelationId: null,
    status: "running",
    observedActive: false,
    startedAt: 1000,
    updatedAt: 1001,
    activeObservedAt: null,
    abortRequestedAt: null,
    ...overrides,
  };
}

function harness(options = {}) {
  const coordinator = createSessionMutationCoordinator();
  const client = options.client ?? fakeManagedClient({ getStatus: 204, workspaces: [{ id: WORKSPACE_ID, name: "Test", path: WORKSPACE_PATH, workspaceType: "local" }] });
  const registrations = createRemoteControlMutationRegistrations({
    workspaceStore: fakeWorkspaceStore(),
    managedRuntimeClient: client,
    coordinator,
  });
  return { coordinator, client, registrations };
}

function interactionRegistration(registrations, operation) {
  const registration = registrations.find((candidate) => candidate.operation === operation);
  assert.ok(registration);
  return registration;
}

function managedHttpError(status, serverCode, rawBody = null) {
  const error = new ManagedRuntimeClientError("http_error", { serverCode });
  error.status = status;
  /** @type {any} */ (error).rawBody = rawBody;
  return error;
}

test("session.prompt registration validates strict arguments", () => {
  const { registrations } = harness();
  const prompt = registrations.find((r) => r.operation === "session.prompt");
  assert.ok(prompt.validateArguments({ workspaceId: "ws_test", sessionId: "ses_test", prompt: "hello" }));
  assert.throws(() => prompt.validateArguments({ workspaceId: "ws_test", sessionId: "ses_test" }));
  assert.throws(() => prompt.validateArguments({ workspaceId: "ws_test", sessionId: "ses_test", prompt: "" }));
});

test("session.create validates strict Unicode-bounded arguments", () => {
  const { registrations } = harness();
  const create = registrations.find((r) => r.operation === "session.create");
  assert.deepEqual(create.validateArguments({ workspaceId: WORKSPACE_ID, title: "😀".repeat(120) }), {
    workspaceId: WORKSPACE_ID,
    title: "😀".repeat(120),
  });
  assert.deepEqual(create.validateArguments({ workspaceId: WORKSPACE_ID, title: "join\u200dthis" }), {
    workspaceId: WORKSPACE_ID,
    title: "join\u200dthis",
  });
  for (const value of [
    { workspaceId: WORKSPACE_ID, title: "" },
    { workspaceId: WORKSPACE_ID, title: " New " },
    { workspaceId: WORKSPACE_ID, title: "embedded\u0000nul" },
    { workspaceId: WORKSPACE_ID, title: "next\u0085line" },
    { workspaceId: WORKSPACE_ID, title: "high\ud800surrogate" },
    { workspaceId: WORKSPACE_ID, title: "low\udc00surrogate" },
    { workspaceId: WORKSPACE_ID, title: "😀".repeat(121) },
    { workspaceId: WORKSPACE_ID, title: "New", prompt: "Start" },
    { workspaceId: WORKSPACE_ID, title: "New", path: WORKSPACE_PATH },
  ]) assert.throws(() => create.validateArguments(value));
});

test("session.create posts only title and returns only the authoritative session ID", async () => {
  const { registrations, client } = harness();
  const create = registrations.find((r) => r.operation === "session.create");
  const result = await create.execute({
    arguments: { workspaceId: WORKSPACE_ID, title: "New session" },
    context: {},
    correlationId: "cmd-create",
  });
  assert.deepEqual(result, { sessionId: "ses_created" });
  assert.deepEqual(client.calls.find((call) => call.method === "POST"), {
    method: "POST",
    pathname: "/workspace/ws_test/sessions",
    body: { title: "New session" },
  });
});

test("session.create rejects remote or server-only workspaces before creation", async () => {
  for (const workspaceId of ["ws_remote", "ws_server_only"]) {
    const client = fakeManagedClient({
      getStatus: 204,
      workspaces: [{ id: workspaceId, path: "/server/path", workspaceType: "local" }],
    });
    const create = harness({ client }).registrations.find((r) => r.operation === "session.create");
    await assert.rejects(
      create.execute({ arguments: { workspaceId, title: "New" }, context: {} }),
      (error) => error instanceof RemoteControlOperationExecutionError && error.code === "workspace_not_found",
    );
    assert.equal(client.calls.some((call) => call.method === "POST"), false);
  }
});

for (const response of [
  null,
  { item: { id: "ses_created", directory: WORKSPACE_PATH }, started: true },
  { item: { id: "", directory: WORKSPACE_PATH }, started: false },
  { item: { id: "ses_created", directory: "/different/path" }, started: false },
  { item: { id: "ses_created", directory: WORKSPACE_PATH, workspaceId: "ws_other" }, started: false },
  { item: { id: "ses_created", directory: WORKSPACE_PATH }, started: false, extra: true },
]) {
  test(`session.create rejects malformed or mismatched success: ${JSON.stringify(response)}`, async () => {
    const client = fakeManagedClient({
      getStatus: 204,
      postResult: response,
      workspaces: [{ id: WORKSPACE_ID, path: WORKSPACE_PATH, workspaceType: "local" }],
    });
    const create = harness({ client }).registrations.find((r) => r.operation === "session.create");
    await assert.rejects(
      create.execute({ arguments: { workspaceId: WORKSPACE_ID, title: "New" }, context: {} }),
      (error) => error instanceof RemoteControlOperationExecutionError && error.code === "internal_error",
    );
  });
}

test("session.prompt uses the semantic start API and forwards command correlation", async () => {
  const { registrations, client } = harness();
  const prompt = registrations.find((r) => r.operation === "session.prompt");
  const result = await prompt.execute({
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "do something", whenBusy: "reject" },
    context: { featureGates: { sessionMutation: true } },
    correlationId: "cmd-prompt",
  });
  assert.deepEqual(result, { disposition: "started", runId: "run_test", generation: 1 });
  const postCall = client.calls.find((c) => c.method === "POST");
  assert.equal(postCall.pathname, "/workspace/ws_test/sessions/ses_test/runs/start");
  assert.deepEqual(postCall.body, { origin: "remote-control", startCommandCorrelationId: "cmd-prompt", whenBusy: "reject", prompt: { parts: [{ type: "text", text: "do something" }] } });
});

for (const [name, postResult, expected] of [
  ["enqueued", { disposition: "enqueued", pendingOperationId: "pending_queue", position: 2 }, { disposition: "enqueued", pendingOperationId: "pending_queue", position: 2 }],
  ["steered", { disposition: "steered", pendingOperationId: "pending_steer", admittedId: "pending_steer" }, { disposition: "steered", pendingOperationId: "pending_steer", admittedId: "pending_steer" }],
]) {
  test(`session.prompt accepts ${name} disposition`, async () => {
    const client = fakeManagedClient({ postResult, getStatus: 204, workspaces: [{ id: WORKSPACE_ID, name: "Test", path: WORKSPACE_PATH, workspaceType: "local" }] });
    const prompt = harness({ client }).registrations.find((r) => r.operation === "session.prompt");
    assert.deepEqual(await prompt.execute({
      arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "busy", whenBusy: name === "steered" ? "steer" : "enqueue" },
      context: {}, correlationId: `cmd-${name}`,
    }), expected);
  });
}

for (const status of ["cancelled", "already_cancelled", "not_cancellable"]) {
  test(`session.pending.cancel accepts ${status}`, async () => {
    const client = fakeManagedClient({ postResult: { pendingOperationId: "pending_cancel", status }, getStatus: 204, workspaces: [{ id: WORKSPACE_ID, name: "Test", path: WORKSPACE_PATH, workspaceType: "local" }] });
    const cancel = harness({ client }).registrations.find((r) => r.operation === "session.pending.cancel");
    assert.deepEqual(await cancel.execute({
      arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, pendingOperationId: "pending_cancel" },
      context: {}, correlationId: `cmd-${status}`,
    }), { pendingOperationId: "pending_cancel", status });
  });
}

test("session.prompt and agent validation bound prompts by UTF-8 bytes", async () => {
  const prompt = harness().registrations.find((r) => r.operation === "session.prompt");
  assert.throws(() => prompt.validateArguments({
    workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "界".repeat(66_667), whenBusy: "reject",
  }), /invalid/i);
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
  const client = fakeManagedClient({ getStatus: 204, workspaces: [{ id: WORKSPACE_ID, path: WORKSPACE_PATH }] });
  client.postJson = async () => {
    const error = new ManagedRuntimeClientError("http_error", { serverCode: "run_mismatch", currentRunId: "run_current" });
    throw error;
  };
  const { registrations } = harness({ client });
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
    correlationId: "cmd-start",
  });
  const abortResult = await abort.execute({
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, expectedRunId: promptResult.runId },
    context: { featureGates: { sessionMutation: true } },
    correlationId: "cmd-abort",
  });
  assert.deepEqual(abortResult, { runId: "run_test", abortRequested: true });
  const abortCall = client.calls.find((c) => c.method === "POST" && c.pathname.includes("abort"));
  assert.ok(abortCall);
  assert.equal(abortCall.pathname, "/workspace/ws_test/sessions/ses_test/runs/run_test/abort");
  assert.equal(coordinator.getActiveRunId({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }), "run_test");
  assert.equal(coordinator.activeRuns()[0].status, "aborting");
  assert.deepEqual(abortCall.body, { abortCommandCorrelationId: "cmd-abort" });
});

test("session.prompt rejects session_busy on double begin", async () => {
  const { registrations, coordinator } = harness();
  const prompt = registrations.find((r) => r.operation === "session.prompt");
  await prompt.execute({
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "first" },
    context: { featureGates: { sessionMutation: true } },
    correlationId: "cmd-first",
  });
  const busyClient = fakeManagedClient({ getStatus: 204, workspaces: [{ id: WORKSPACE_ID, path: WORKSPACE_PATH }] });
  busyClient.postJson = async () => {
    const error = new ManagedRuntimeClientError("http_error", { serverCode: "session_busy", currentRunId: "run_test" });
    throw error;
  };
  const busyPrompt = harness({ client: busyClient }).registrations.find((r) => r.operation === "session.prompt");
  await assert.rejects(
    busyPrompt.execute({
      arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, prompt: "second" },
      context: { featureGates: { sessionMutation: true } },
      correlationId: "cmd-second",
    }),
    (error) => error instanceof RemoteControlOperationExecutionError && /** @type {any} */ (error.code) === "session_busy",
  );
});

test("permission reply uses the authoritative endpoint and forwards response and command correlation", async () => {
  const client = fakeManagedClient({
    getStatus: 200,
    postResult: { interactionId: "perm_1", status: "resolved" },
    workspaces: [{ id: WORKSPACE_ID, path: WORKSPACE_PATH }],
  });
  const permission = interactionRegistration(harness({ client }).registrations, "interaction.permission.reply");
  const result = await permission.execute({
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, interactionId: "perm_1", response: "allow_once" },
    context: {},
    correlationId: "cmd-permission",
  });

  assert.deepEqual(result, { interactionId: "perm_1", status: "resolved" });
  assert.deepEqual(client.calls.find((call) => call.method === "POST"), {
    method: "POST",
    pathname: "/workspace/ws_test/sessions/ses_test/interactions/perm_1/permission/reply",
    body: { origin: "remote-control", commandCorrelationId: "cmd-permission", response: "allow_once" },
  });
  assert.equal(client.calls.some((call) => call.pathname.includes("/opencode/")), false);
});

test("question reply preserves answer IDs and values on the authoritative endpoint", async () => {
  const client = fakeManagedClient({
    getStatus: 200,
    postResult: { interactionId: "question_1", status: "resolved" },
    workspaces: [{ id: WORKSPACE_ID, path: WORKSPACE_PATH }],
  });
  const question = interactionRegistration(harness({ client }).registrations, "interaction.question.reply");
  const answers = [
    { questionId: "single", values: ["Yes"] },
    { questionId: "many", values: ["A", "B"] },
  ];
  const result = await question.execute({
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, interactionId: "question_1", answers },
    context: {},
    correlationId: "cmd-question",
  });

  assert.deepEqual(result, { interactionId: "question_1", status: "resolved" });
  assert.deepEqual(client.calls.find((call) => call.method === "POST"), {
    method: "POST",
    pathname: "/workspace/ws_test/sessions/ses_test/interactions/question_1/question/reply",
    body: { origin: "remote-control", commandCorrelationId: "cmd-question", answers },
  });
  assert.equal(client.calls.some((call) => call.pathname.includes("/opencode/")), false);
});

for (const [serverCode, status] of [
  ["already_resolved", 409],
  ["interaction_expired", 410],
  ["interaction_not_found", 404],
]) {
  test(`interaction reply maps ${serverCode} from the managed server`, async () => {
    const client = fakeManagedClient({ getStatus: 200, workspaces: [{ id: WORKSPACE_ID, path: WORKSPACE_PATH }] });
    client.postJson = async () => { throw managedHttpError(status, serverCode); };
    const permission = interactionRegistration(harness({ client }).registrations, "interaction.permission.reply");

    await assert.rejects(
      permission.execute({
        arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, interactionId: "perm_error", response: "reject" },
        context: {},
        correlationId: "cmd-error",
      }),
      (error) => error instanceof RemoteControlOperationExecutionError && error.code === serverCode,
    );
  });
}

test("invalid question answers reported as server 400 map to invalid_request without exposing the body", async () => {
  const client = fakeManagedClient({ getStatus: 200, workspaces: [{ id: WORKSPACE_ID, path: WORKSPACE_PATH }] });
  client.postJson = async () => {
    throw managedHttpError(400, "invalid_question_answers", "secret upstream validation body");
  };
  const question = interactionRegistration(harness({ client }).registrations, "interaction.question.reply");

  await assert.rejects(
    question.execute({
      arguments: {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        interactionId: "question_invalid",
        answers: [{ questionId: "unknown", values: ["secret"] }],
      },
      context: {},
      correlationId: "cmd-invalid",
    }),
    (error) => error instanceof RemoteControlOperationExecutionError && error.code === "invalid_request" &&
      error.message === "The remote operation failed." && !JSON.stringify(error).includes("secret upstream"),
  );
});

for (const response of [
  null,
  { interactionId: "wrong", status: "resolved" },
  { interactionId: "perm_schema", status: "already_resolved" },
  { interactionId: "perm_schema", status: "resolved", extra: true },
]) {
  test(`interaction reply rejects invalid success schema: ${JSON.stringify(response)}`, async () => {
    const client = fakeManagedClient({
      getStatus: 200,
      postResult: response,
      workspaces: [{ id: WORKSPACE_ID, path: WORKSPACE_PATH }],
    });
    const permission = interactionRegistration(harness({ client }).registrations, "interaction.permission.reply");

    await assert.rejects(
      permission.execute({
        arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, interactionId: "perm_schema", response: "reject" },
        context: {},
        correlationId: "cmd-schema",
      }),
      (error) => error instanceof RemoteControlOperationExecutionError && error.code === "internal_error",
    );
  });
}

test("persistent remote permission responses are rejected before managed-server dispatch", async () => {
  const { client, registrations } = harness();
  const registry = createRemoteControlOperationRegistry({
    registrations,
    getFeatureGates: () => ({ enrollment: true, readOnlyControl: true, sessionMutation: true, interactions: true }),
    isOperationAllowed: () => true,
  });
  const advertisedCapabilities = await registry.advertise();
  const result = await registry.dispatch({
    operation: "interaction.permission.reply",
    payloadVersion: 1,
    arguments: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, interactionId: "perm_persistent", response: "allow_persistent" },
  }, { advertisedCapabilities, correlationId: "cmd-persistent" });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_request");
  assert.equal(client.calls.some((call) => call.method === "POST"), false);
});
