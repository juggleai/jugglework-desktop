import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { desktopRemoteOperationResultSchema } from "../dist/runtime/desktop-remote-control.js";

import { createRemoteControlReadRegistrations } from "./remote-control-read-adapters.mjs";
import {
  createRemoteControlOperationRegistry,
} from "./remote-control-operations.mjs";

const WORKSPACE_PATH = "/private/authorized/project";
const NOW = Date.parse("2026-08-09T00:00:00.000Z");
const enabledGates = {
  enrollment: true,
  readOnlyControl: true,
  sessionMutation: false,
  interactions: false,
};

function workspaceState() {
  return {
    workspaces: [
      { id: "ws_local", name: "Internal Name", displayName: "Project", path: WORKSPACE_PATH, workspaceType: "local", baseUrl: "http://secret" },
      { id: "ws_remote", name: "Remote", path: "/remote/path", workspaceType: "remote", juggleworkToken: "remote-token" },
    ],
  };
}

function session(id = "ses_1", directory = WORKSPACE_PATH) {
  return { id, title: "Session", directory, time: { created: 1_000, updated: 2_000 } };
}

function snapshotBody(directory = WORKSPACE_PATH) {
  return {
    item: {
      session: session("ses_1", directory),
      status: { type: "retry", attempt: 2 },
      messages: [
        {
          info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 3_000, completed: 4_000 } },
          parts: [
            { id: "prt_text", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "visible /Users/alice/private Bearer abc.def token=secret" },
            { id: "prt_reason", messageID: "msg_1", sessionID: "ses_1", type: "reasoning", text: "thinking" },
            { id: "prt_hidden", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hidden", synthetic: true },
            { id: "prt_ignored", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "ignored", ignored: true },
            { id: "prt_file", messageID: "msg_1", sessionID: "ses_1", type: "file", url: "file:///private/secret.txt" },
            {
              id: "prt_tool",
              messageID: "msg_1",
              sessionID: "ses_1",
              type: "tool",
              tool: "bash",
              state: { status: "completed", input: { command: "cat /Users/alice/.env", authorization: "Bearer abc" }, output: { token: "secret" }, metadata: { title: "Shell" } },
            },
          ],
        },
      ],
      todos: [{ content: "Ship it", status: "completed", priority: "high" }],
    },
  };
}

function harness(overrides = {}) {
  const calls = [];
  const responses = {
    "/workspaces": { items: [{ id: "ws_local", name: "Local", path: WORKSPACE_PATH, workspaceType: "local" }] },
    "/workspace/ws_local/sessions?limit=10000": { items: [session()] },
    "/workspace/ws_local/opencode/session/status": { ses_1: { type: "busy" } },
    "/workspace/ws_local/sessions/ses_1": { item: session() },
    "/workspace/ws_local/sessions/ses_1/snapshot?limit=200": snapshotBody(),
    "/workspace/ws_local/sessions/ses_1/pending": { items: [] },
    ...(overrides.responses ?? {}),
  };
  const registrations = createRemoteControlReadRegistrations({
    workspaceStore: { readWorkspaceState: async () => overrides.state ?? workspaceState() },
    managedRuntimeClient: {
      async getJson(pathname) {
        calls.push(pathname);
        const value = responses[pathname];
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error("unexpected path");
        return value;
      },
    },
    now: () => NOW,
  });
  const registry = createRemoteControlOperationRegistry({
    registrations,
    getFeatureGates: () => enabledGates,
    isOperationAllowed: () => true,
  });
  return { calls, registrations, registry };
}

function advertisement(operations = ["workspace.list", "session.list", "session.snapshot"]) {
  return { schemaVersion: 1, operations: operations.map((operation) => ({ operation, payloadVersions: [1] })), features: [] };
}

async function dispatch(registry, operation, argumentsValue, correlationId = "corr-1") {
  return registry.dispatch(
    { operation, payloadVersion: 1, arguments: argumentsValue },
    { advertisedCapabilities: advertisement(), correlationId },
  );
}

describe("remote-control read adapters", () => {
  it("advertises exactly concrete read handlers when gates allow", async () => {
    const { registry } = harness();
    assert.deepEqual(await registry.advertise(), advertisement());
    const disabled = createRemoteControlOperationRegistry({
      registrations: harness().registrations,
      getFeatureGates: () => ({ ...enabledGates, readOnlyControl: false }),
      isOperationAllowed: () => true,
    });
    assert.deepEqual((await disabled.advertise()).operations, []);
  });

  it("lists only id/name for managed local workspaces without paths, URLs, or tokens", async () => {
    const { registry, calls } = harness();
    const dispatched = await dispatch(registry, "workspace.list", {});
    assert.equal(dispatched.ok, true);
    assert.deepEqual(dispatched.value.workspaces, [{ id: "ws_local", name: "Local" }]);
    assert.deepEqual(calls, ["/workspaces"]);
    assert.doesNotMatch(JSON.stringify(dispatched), /private|authorized|http|token|remote/i);
    desktopRemoteOperationResultSchema.parse({ operation: "workspace.list", payloadVersion: 1, result: dispatched.value });
  });

  it("enforces strict operation arguments before any local or network read", async () => {
    let localReads = 0;
    let networkReads = 0;
    const registrations = createRemoteControlReadRegistrations({
      workspaceStore: { readWorkspaceState: async () => { localReads += 1; return workspaceState(); } },
      managedRuntimeClient: { getJson: async () => { networkReads += 1; return {}; } },
    });
    const registry = createRemoteControlOperationRegistry({ registrations, getFeatureGates: () => enabledGates, isOperationAllowed: () => true });
    for (const [operation, args] of [
      ["workspace.list", { extra: true }],
      ["session.list", {}],
      ["session.list", { workspaceId: "ws_local", extra: true }],
      ["session.snapshot", { workspaceId: "ws_local", sessionId: "bad\nvalue" }],
    ]) {
      assert.equal((await dispatch(registry, operation, args)).error.code, "invalid_request");
    }
    assert.equal(localReads, 0);
    assert.equal(networkReads, 0);
  });

  it("rejects an absent or remote workspace before network access", async () => {
    const { registry, calls } = harness();
    assert.equal((await dispatch(registry, "session.list", { workspaceId: "missing" })).error.code, "workspace_not_found");
    assert.equal((await dispatch(registry, "session.snapshot", { workspaceId: "ws_remote", sessionId: "ses_1" })).error.code, "workspace_not_found");
    assert.deepEqual(calls, ["/workspaces", "/workspaces"]);
  });

  it("maps session summaries, statuses, and timestamps without leaking directories", async () => {
    const { registry, calls } = harness();
    const dispatched = await dispatch(registry, "session.list", { workspaceId: "ws_local" });
    assert.deepEqual(dispatched.value, {
      sessions: [{
        id: "ses_1",
        workspaceId: "ws_local",
        title: "Session",
        status: "running",
        createdAt: "1970-01-01T00:00:01.000Z",
        updatedAt: "1970-01-01T00:00:02.000Z",
        activeRunId: null,
      }],
    });
    assert.deepEqual(calls, [
      "/workspaces",
      "/workspace/ws_local/sessions?limit=10000",
      "/workspace/ws_local/opencode/session/status",
    ]);
    assert.doesNotMatch(JSON.stringify(dispatched), /private|authorized|http|token/);
    desktopRemoteOperationResultSchema.parse({ operation: "session.list", payloadVersion: 1, result: dispatched.value });
  });

  it("rejects cross-workspace list entries and snapshot preflight before content", async () => {
    const listHarness = harness({
      responses: {
        "/workspace/ws_local/sessions?limit=10000": { items: [session("ses_1", "/other/workspace")] },
        "/workspace/ws_local/opencode/session/status": {},
      },
    });
    assert.equal((await dispatch(listHarness.registry, "session.list", { workspaceId: "ws_local" })).error.code, "session_not_found");

    const snapshotHarness = harness({
      responses: {
        "/workspace/ws_local/sessions/ses_1": { item: session("ses_1", "/other/workspace") },
      },
    });
    assert.equal((await dispatch(snapshotHarness.registry, "session.snapshot", { workspaceId: "ws_local", sessionId: "ses_1" })).error.code, "session_not_found");
    assert.deepEqual(snapshotHarness.calls, ["/workspaces", "/workspace/ws_local/sessions/ses_1"]);
    assert.equal(snapshotHarness.calls.some((value) => value.includes("snapshot")), false);
  });

  it("normalizes a bounded safe snapshot and deterministic todos", async () => {
    const first = harness();
    const firstResult = await dispatch(first.registry, "session.snapshot", { workspaceId: "ws_local", sessionId: "ses_1" });
    const secondResult = await dispatch(harness().registry, "session.snapshot", { workspaceId: "ws_local", sessionId: "ses_1" });
    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.value.session.status, "retrying");
    assert.equal(firstResult.value.messages.length, 1);
    assert.deepEqual(firstResult.value.messages[0].parts.map((part) => part.type), ["text", "reasoning", "tool"]);
    assert.deepEqual(firstResult.value.messages[0].parts[2], {
      type: "tool",
      id: "prt_tool",
      name: "bash",
      title: "Shell",
      status: "completed",
      input: null,
      output: null,
    });
    assert.equal(firstResult.value.todos[0].id, secondResult.value.todos[0].id);
    assert.equal(firstResult.value.capturedAt, "2026-08-09T00:00:00.000Z");
    assert.deepEqual(firstResult.value.interactions, []);
    const serialized = JSON.stringify(firstResult);
    assert.match(serialized, /\[LOCAL_PATH\]/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.doesNotMatch(serialized, /file:\/\/|secret\.txt|hidden|ignored|\/Users\/|Bearer abc|token=secret|collaborator/);
    desktopRemoteOperationResultSchema.parse({ operation: "session.snapshot", payloadVersion: 1, result: firstResult.value });
  });

  it("maps malformed responses and raw failures to sanitized internal errors", async () => {
    for (const response of [{ items: [{ id: "bad" }] }, new Error("token at http://127.0.0.1/private")]) {
      const { registry } = harness({
        responses: {
          "/workspace/ws_local/sessions?limit=10000": response,
          "/workspace/ws_local/opencode/session/status": {},
        },
      });
      const dispatched = await dispatch(registry, "session.list", { workspaceId: "ws_local" });
      assert.equal(dispatched.error.code, "internal_error");
      assert.equal(dispatched.error.retryable, false);
      assert.doesNotMatch(JSON.stringify(dispatched), /token|127\.0\.0\.1|private/);
    }
  });
});
