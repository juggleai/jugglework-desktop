import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { desktopRemoteOperationResultSchema } from "../dist/runtime/desktop-remote-control.js";

import {
  createRemoteControlReadRegistrations,
  createRemoteSessionRootVerifier,
  normalizeRemoteMessagePart,
  SNAPSHOT_IMAGE_THUMBNAIL_THRESHOLD_BYTES,
  thumbnailSnapshotImages,
} from "./remote-control-read-adapters.mjs";
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
      modelPreference: { revision: 0, mode: "auto", model: null, updatedAt: 0 },
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
    "/workspace/ws_local/session-runs": { items: [] },
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
    interactions: overrides.interactions,
    logger: overrides.logger,
    imageThumbnailer: overrides.imageThumbnailer ?? null,
  });
  const registry = createRemoteControlOperationRegistry({
    registrations,
    getFeatureGates: () => overrides.gates ?? enabledGates,
    isOperationAllowed: () => true,
  });
  return { calls, registrations, registry };
}

function advertisement(operations = ["workspace.list", "session.list", "session.snapshot"]) {
  return { schemaVersion: 1, operations: operations.map((operation) => ({
    operation,
    payloadVersions: operation === "session.snapshot" ? [1, 2] : [1],
  })), features: [] };
}

async function dispatch(registry, operation, argumentsValue, correlationId = "corr-1", payloadVersion = 1, featureGates = enabledGates) {
  const sessionId = argumentsValue.rootSessionId ?? argumentsValue.sessionId;
  return registry.dispatch(
    { operation, payloadVersion, arguments: argumentsValue },
    {
      advertisedCapabilities: advertisement(),
      correlationId,
      context: sessionId ? { remoteSessionBinding: { rootSessionId: sessionId }, featureGates } : undefined,
    },
  );
}

describe("remote-control read adapters", () => {
  it("reads authoritative run identity for lists and snapshots without an SSE binding", async () => {
    const { registry } = harness({ responses: {
      "/workspace/ws_local/session-runs": { items: [{ workspaceId: "ws_local", sessionId: "ses_1", runId: "run_A", status: "running" }] },
    } });
    const listed = await dispatch(registry, "session.list", { workspaceId: "ws_local" });
    assert.equal(listed.value.sessions[0].activeRunId, "run_A");
    const snapshot = await dispatch(registry, "session.snapshot", { workspaceId: "ws_local", sessionId: "ses_1" });
    assert.equal(snapshot.value.session.activeRunId, "run_A");
    assert.equal(snapshot.value.session.status, "running");
  });

  it("rejects a hidden child as a remote root binding", async () => {
    const responses = {
      "/workspaces": { items: [{ id: "ws_local", name: "Local", path: WORKSPACE_PATH, workspaceType: "local" }] },
      "/workspace/ws_local/sessions?limit=10000": {
        items: [session("root"), { ...session("child"), parentID: "root" }],
      },
    };
    const verifier = createRemoteSessionRootVerifier({
      workspaceStore: { readWorkspaceState: async () => workspaceState() },
      managedRuntimeClient: {
        async getJson(pathname) {
          const value = responses[pathname];
          if (value === undefined) throw new Error("unexpected path");
          return value;
        },
      },
    });

    assert.equal(await verifier({ workspaceId: "ws_local", rootSessionId: "root" }), true);
    assert.equal(await verifier({ workspaceId: "ws_local", rootSessionId: "child" }), false);
  });

  it("rejects an archived session as a remote root binding", async () => {
    const responses = {
      "/workspaces": { items: [{ id: "ws_local", name: "Local", path: WORKSPACE_PATH, workspaceType: "local" }] },
      "/workspace/ws_local/sessions?limit=10000": {
        items: [
          session("active_root"),
          { ...session("archived_root"), time: { created: 1_000, updated: 2_000, archived: 1_500 } },
          { ...session("unarchived_root"), time: { created: 1_000, updated: 2_000, archived: 0 } },
        ],
      },
    };
    const verifier = createRemoteSessionRootVerifier({
      workspaceStore: { readWorkspaceState: async () => workspaceState() },
      managedRuntimeClient: {
        async getJson(pathname) {
          const value = responses[pathname];
          if (value === undefined) throw new Error("unexpected path");
          return value;
        },
      },
    });

    assert.equal(await verifier({ workspaceId: "ws_local", rootSessionId: "active_root" }), true);
    assert.equal(await verifier({ workspaceId: "ws_local", rootSessionId: "archived_root" }), false);
    assert.equal(await verifier({ workspaceId: "ws_local", rootSessionId: "unarchived_root" }), true);
  });

  it("excludes archived sessions from the remote session list", async () => {
    const { registry } = harness({
      responses: {
        "/workspace/ws_local/sessions?limit=10000": {
          items: [
            session("ses_active"),
            { ...session("ses_archived"), time: { created: 1_000, updated: 2_000, archived: 1_500 } },
            { ...session("ses_unarchived"), time: { created: 1_000, updated: 2_000, archived: 0 } },
            { ...session("ses_child"), parentID: "ses_active" },
          ],
        },
        "/workspace/ws_local/opencode/session/status": { ses_active: { type: "busy" } },
      },
    });
    const dispatched = await dispatch(registry, "session.list", { workspaceId: "ws_local" });

    assert.equal(dispatched.ok, true);
    assert.deepEqual(dispatched.value.sessions.map((session) => session.id), ["ses_active", "ses_unarchived"]);
    desktopRemoteOperationResultSchema.parse({ operation: "session.list", payloadVersion: 1, result: dispatched.value });
  });

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
      "/workspace/ws_local/session-runs",
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
    assert.deepEqual(snapshotHarness.calls, [
      "/workspaces",
      "/workspace/ws_local/sessions?limit=10000",
      "/workspace/ws_local/sessions/ses_1",
    ]);
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
    assert.doesNotMatch(serialized, /file:\/\/|secret\.txt|hidden|ignored|\/Users\/|Bearer abc|token=secret|collaborator/);
    desktopRemoteOperationResultSchema.parse({ operation: "session.snapshot", payloadVersion: 1, result: firstResult.value });
  });

  it("sends thumbnails instead of full-size images in a snapshot", async () => {
    const original = `data:image/png;base64,${"A".repeat(SNAPSHOT_IMAGE_THUMBNAIL_THRESHOLD_BYTES + 4)}`;
    const body = snapshotBody();
    body.item.messages[0].info.role = "user";
    body.item.messages[0].parts = /** @type {any[]} */ ([
      { id: "prt_text", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "look" },
      { id: "prt_img", messageID: "msg_1", sessionID: "ses_1", type: "file", mime: "image/png", filename: "photo.png", url: original },
    ]);
    const testHarness = harness({
      responses: { "/workspace/ws_local/sessions/ses_1/snapshot?limit=200": body },
      imageThumbnailer: () => ({ mime: "image/jpeg", url: "data:image/jpeg;base64,/9j/4AAQ" }),
    });
    const result = await dispatch(testHarness.registry, "session.snapshot", { workspaceId: "ws_local", sessionId: "ses_1" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.messages[0].parts[1], {
      type: "file", id: "prt_img", mime: "image/jpeg", filename: "photo.png", url: "data:image/jpeg;base64,/9j/4AAQ",
    });
    desktopRemoteOperationResultSchema.parse({ operation: "session.snapshot", payloadVersion: 1, result: result.value });
  });

  it("accepts persisted model preference identity fields without leaking them", async () => {
    const testHarness = harness({
      responses: {
        "/workspace/ws_local/sessions/ses_1/snapshot?limit=200": {
          ...snapshotBody(),
          item: {
            ...snapshotBody().item,
            modelPreference: {
              workspaceId: "ws_local",
              sessionId: "ses_1",
              revision: 0,
              mode: "auto",
              model: null,
              updatedAt: 0,
            },
          },
        },
      },
    });

    const result = await dispatch(testHarness.registry, "session.snapshot", { workspaceId: "ws_local", sessionId: "ses_1" });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.modelPreference, { revision: 0, mode: "auto", model: null, updatedAt: 0 });
  });

  it("keeps sanitized tool titles within the protocol limit when redaction expands", () => {
    const normalized = normalizeRemoteMessagePart({
      id: "prt_expanding_title",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        title: `${"x".repeat(480)} token=a ${"y".repeat(40)}`,
      },
    });

    assert.equal(normalized.type, "tool");
    assert.equal(normalized.title.length, 500);
    assert.match(normalized.title, /token=\[REDACTED\]/);
    assert.doesNotMatch(normalized.title, /token=a/);
    desktopRemoteOperationResultSchema.parse({
      operation: "session.snapshot",
      payloadVersion: 1,
      result: {
        schemaVersion: 1,
        workspace: { id: "ws_local", name: "Local" },
        session: {
          id: "ses_1",
          workspaceId: "ws_local",
          title: "Session",
          status: "idle",
          createdAt: "1970-01-01T00:00:01.000Z",
          updatedAt: "1970-01-01T00:00:02.000Z",
          activeRunId: null,
        },
        messages: [{
          id: "msg_1",
          role: "assistant",
          createdAt: "1970-01-01T00:00:03.000Z",
          completedAt: null,
          parts: [normalized],
        }],
        todos: [],
        interactions: [],
        pendingOperations: [],
        modelPreference: { revision: 0, mode: "auto", model: null, updatedAt: 0 },
        capturedAt: "2026-08-09T00:00:00.000Z",
      },
    });
  });

  it("preserves only bounded safe data URL file parts", () => {
    const safe = normalizeRemoteMessagePart({
      id: "prt_file", messageID: "msg_1", sessionID: "ses_1", type: "file",
      mediaType: "image/webp", filename: "photo.webp", url: "data:image/webp;base64,UklGRg==",
    });
    assert.deepEqual(safe, {
      type: "file", id: "prt_file", mime: "image/webp", filename: "photo.webp", url: "data:image/webp;base64,UklGRg==",
    });
    for (const url of ["file:///Users/alice/photo.webp", "https://example.com/photo.webp", "data:image/png;base64,UklGRg=="]) {
      assert.equal(normalizeRemoteMessagePart({
        id: "prt_file", messageID: "msg_1", sessionID: "ses_1", type: "file",
        mediaType: "image/webp", filename: "photo.webp", url,
      }), null);
    }
  });

  it("replaces only large non-GIF snapshot images with smaller thumbnails", () => {
    const big = (mime) => `data:${mime};base64,${"A".repeat(SNAPSHOT_IMAGE_THUMBNAIL_THRESHOLD_BYTES + 4)}`;
    const thumbnail = "data:image/jpeg;base64,/9j/4AAQ";
    const calls = [];
    const thumbnailer = (input) => { calls.push(input.mime); return { mime: "image/jpeg", url: thumbnail }; };
    const message = {
      id: "msg_1", role: "user", createdAt: "2026-08-09T00:00:00.000Z", completedAt: null,
      parts: [
        { type: "text", id: "prt_text", text: "look" },
        { type: "file", id: "prt_big", mime: "image/png", filename: "photo.png", url: big("image/png") },
        { type: "file", id: "prt_small", mime: "image/png", filename: "small.png", url: "data:image/png;base64,iVBORw0K" },
        { type: "file", id: "prt_gif", mime: "image/gif", filename: "anim.gif", url: big("image/gif") },
      ],
    };
    const result = thumbnailSnapshotImages(message, thumbnailer);
    assert.deepEqual(calls, ["image/png"]);
    // 文件名不变，手机端按文件名把回显和本地消息对上。
    assert.deepEqual(result.parts[1], { type: "file", id: "prt_big", mime: "image/jpeg", filename: "photo.png", url: thumbnail });
    assert.equal(result.parts[2], message.parts[2]);
    assert.equal(result.parts[3], message.parts[3]);
    assert.equal(result.parts[0], message.parts[0]);
  });

  it("keeps the original image when the thumbnail fails, grows, or is unsafe", () => {
    const original = `data:image/png;base64,${"A".repeat(SNAPSHOT_IMAGE_THUMBNAIL_THRESHOLD_BYTES + 4)}`;
    const message = {
      id: "msg_1", role: "user", createdAt: null, completedAt: null,
      parts: [{ type: "file", id: "prt_big", mime: "image/png", filename: "photo.png", url: original }],
    };
    for (const thumbnailer of [
      () => { throw new Error("decode failed"); },
      () => null,
      () => ({ mime: "image/jpeg", url: `data:image/jpeg;base64,${"A".repeat(original.length)}` }),
      () => ({ mime: "image/jpeg", url: "https://example.com/x.jpg" }),
    ]) {
      assert.equal(thumbnailSnapshotImages(message, thumbnailer), message);
    }
    assert.equal(thumbnailSnapshotImages(message, null), message);
  });

  it("redacts a complete quoted credential before truncating its tool title", () => {
    const secretTail = "alpha beta gamma delta";
    const normalized = normalizeRemoteMessagePart({
      id: "prt_quoted_secret",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        title: `${"x".repeat(480)} token: \"${secretTail}\"`,
      },
    });

    assert.equal(normalized.type, "tool");
    assert.ok(normalized.title.length <= 500);
    assert.match(normalized.title, /token: \[REDACTED\]/);
    assert.doesNotMatch(normalized.title, /alpha|beta|gamma|delta/);
  });

  it("does not leak quoted credential or spaced local-path suffixes", () => {
    /** @type {[string, RegExp][]} */
    const cases = [
      [`password: "abc'def sensitive-tail"`, /abc|def|sensitive-tail/],
      [`token: "alpha beta secret-tail\\\" delta"`, /alpha|beta|secret-tail|delta/],
      [`cat /Users/alice/My Documents/private.txt`, /alice|Documents|private\.txt/],
    ];
    for (const [title, forbidden] of cases) {
      const normalized = normalizeRemoteMessagePart({
        id: `prt_${title.length}`,
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "tool",
        tool: "bash",
        state: { status: "completed", title },
      });
      assert.doesNotMatch(normalized.title, forbidden);
      assert.match(normalized.title, /\[REDACTED\]|\[LOCAL_PATH\]/);
    }
  });

  it("logs only safe issue paths and codes when snapshot result validation fails", async () => {
    const entries = [];
    const secret = "secret-invalid-pending-status";
    const { registry } = harness({
      responses: {
        "/workspace/ws_local/sessions/ses_1/pending": {
          items: [{
            id: "pending_1",
            mode: "enqueue",
            status: secret,
            position: 1,
            createdAt: "2026-08-09T00:00:00.000Z",
          }],
        },
      },
      logger: { warn: (message, metadata) => entries.push({ message, metadata }) },
    });
    const dispatched = await dispatch(registry, "session.snapshot", { workspaceId: "ws_local", sessionId: "ses_1" });

    assert.equal(dispatched.error.code, "internal_error");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, "Remote operation result validation failed.");
    assert.equal(entries[0].metadata.operation, "session.snapshot");
    assert.equal(entries[0].metadata.stage, "result_schema_validation");
    assert.deepEqual(Object.keys(entries[0].metadata).sort(), ["issues", "operation", "stage"]);
    assert.deepEqual(entries[0].metadata.issues[0], {
      path: ["pendingOperations", 0, "status"],
      code: "invalid_value",
    });
    for (const issue of entries[0].metadata.issues) {
      assert.deepEqual(Object.keys(issue).sort(), ["code", "path"]);
    }
    const serialized = JSON.stringify(entries);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, /"input"|"expected"|"values"|"stack"|"arguments"/i);
  });

  it("uses the exact payload-v2 snapshot schema", async () => {
    const entries = [];
    const { registry } = harness({
      gates: { ...enabledGates, interactions: true },
      interactions: {
        listPending: async () => [{
          id: "permission_1",
          sessionId: "ses_1",
          runId: null,
          status: "pending",
          title: "Approve access",
          createdAt: "2026-08-09T00:00:00.000Z",
          expiresAt: null,
          type: "permission",
          description: "Access is required",
          permittedResponses: ["allow_once", "reject"],
          resolution: null,
          rootSessionId: "ses_1",
          targetSessionId: "ses_1",
          parentSessionId: null,
        }],
      },
      logger: { warn: (message, metadata) => entries.push({ message, metadata }) },
    });
    const dispatched = await dispatch(
      registry,
      "session.snapshot",
      { workspaceId: "ws_local", rootSessionId: "ses_1" },
      "corr-v2",
      2,
      { ...enabledGates, interactions: true },
    );

    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.value.interactions[0].rootSessionId, "ses_1");
    assert.equal(dispatched.value.interactions[0].targetSessionId, "ses_1");
    assert.deepEqual(entries, []);
  });

  it("keeps snapshot failures sanitized when the diagnostics logger throws", async () => {
    const { registry } = harness({
      responses: {
        "/workspace/ws_local/sessions/ses_1/pending": { items: [{ status: "invalid" }] },
      },
      logger: { warn: () => { throw new Error("logger secret"); } },
    });
    const dispatched = await dispatch(registry, "session.snapshot", { workspaceId: "ws_local", sessionId: "ses_1" });
    assert.equal(dispatched.error.code, "internal_error");
    assert.doesNotMatch(JSON.stringify(dispatched), /logger secret/);
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
