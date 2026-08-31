import assert from "node:assert/strict";
import { test } from "node:test";

import { createRemoteControlInteractionStore } from "./remote-control-interaction-store.mjs";
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";

function fakeClient({ permissions = [], questions = [], snapshot = null, sessions = [{ id: "ses_1" }] } = {}) {
  const calls = [];
  return {
    calls,
    async getJson(pathname) {
      calls.push(pathname);
      if (pathname.includes("/interactions/snapshot")) {
        if (snapshot === null) {
          const error = new ManagedRuntimeClientError("http_error", { serverCode: "not_found" });
          error.status = 404;
          throw error;
        }
        return snapshot;
      }
      if (pathname.includes("/sessions?")) return { items: sessions };
      const exactSession = pathname.match(/\/opencode\/session\/([^/]+)\/(?:permission|question)$/)?.[1];
      if (pathname.includes("/permission")) return { data: permissions.filter((item) => !exactSession || item.sessionID === decodeURIComponent(exactSession)) };
      if (pathname.includes("/question")) return { data: questions.filter((item) => !exactSession || item.sessionID === decodeURIComponent(exactSession)) };
      return {};
    },
  };
}

test("listPending returns empty for invalid arguments", async () => {
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: fakeClient() });
  assert.deepEqual(await store.listPending({ workspaceId: "", sessionId: "" }), []);
});

test("listPending returns normalized permission interaction", async () => {
  const client = fakeClient({
    permissions: [{
      id: "perm_1",
      sessionID: "ses_1",
      action: "bash",
      resources: ["/tmp/test"],
    }],
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });
  const result = await store.listPending({ workspaceId: "ws_1", sessionId: "ses_1" });
  const first = /** @type {any} */ (result[0]);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "permission");
  assert.equal(result[0].id, "perm_1");
  assert.equal(first.rootSessionId, undefined);
  assert.equal(first.targetSessionId, undefined);
  assert.equal(first.parentSessionId, undefined);
  assert.equal(result[0].sessionId, "ses_1");
  assert.deepEqual(result[0].permittedResponses, ["allow_once", "reject"]);
  assert.ok(result[0].description.includes("bash"));
  assert.ok(result[0].description.includes("/tmp/test"));
});

test("listPending returns normalized question interaction", async () => {
  const client = fakeClient({
    questions: [{
      id: "q_1",
      sessionID: "ses_1",
      questions: [{
        question: "Which option?",
        options: [
          { label: "Option A" },
          { label: "Option B" },
        ],
        multiple: false,
      }],
    }],
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });
  const result = await store.listPending({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "question");
  assert.equal(result[0].questions.length, 1);
  assert.deepEqual(result[0].questions[0].options, ["Option A", "Option B"]);
});

test("listPending filters out interactions from other sessions", async () => {
  const client = fakeClient({
    permissions: [
      { id: "perm_1", sessionID: "ses_1", action: "bash" },
      { id: "perm_2", sessionID: "ses_other", action: "bash" },
    ],
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });
  const result = await store.listPending({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "perm_1");
});

test("listPending reports snapshot_required on client error", async () => {
  const client = { async getJson() { throw new Error("timeout"); } };
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });
  await assert.rejects(
    store.listPending({ workspaceId: "ws_1", sessionId: "ses_1" }),
    (error) => /** @type {any} */ (error)?.code === "snapshot_required",
  );
});

test("authoritative root snapshot retains exact descendant ownership and filters unrelated roots", async () => {
  const client = fakeClient({
    snapshot: {
      item: {
        permissions: [{
          type: "permission",
          id: "perm_child",
          sessionID: "ses_child",
          rootSessionId: "ses_root",
          targetSessionId: "ses_child",
          parentSessionId: "ses_root",
          permission: "external_directory",
          patterns: ["/outside"],
        }, {
          type: "permission",
          id: "perm_unrelated",
          sessionID: "ses_other_child",
          rootSessionId: "ses_other_root",
          targetSessionId: "ses_other_child",
          parentSessionId: "ses_other_root",
          permission: "bash",
        }],
        questions: [],
      },
    },
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client, now: () => 1_000 });

  const result = await store.listPending({ workspaceId: "ws_1", sessionId: "ses_root", payloadVersion: 2 });
  const first = /** @type {any} */ (result[0]);

  assert.equal(result.length, 1);
  assert.deepEqual({
    rootSessionId: first.rootSessionId,
    targetSessionId: first.targetSessionId,
    parentSessionId: first.parentSessionId,
    sessionId: first.sessionId,
  }, {
    rootSessionId: "ses_root",
    targetSessionId: "ses_child",
    parentSessionId: "ses_root",
    sessionId: "ses_child",
  });
  assert.equal(client.calls.some((pathname) => pathname.includes("/sessions?")), false);
  assert.equal(client.calls[0], "/workspace/ws_1/sessions/ses_root/interactions/snapshot?includeDescendants=true");
});

test("v1 authoritative snapshot filters valid descendants without requiring a snapshot", async () => {
  const client = fakeClient({
    snapshot: {
      item: {
        permissions: [{
          type: "permission", id: "perm_root", sessionID: "ses_root", rootSessionId: "ses_root",
          targetSessionId: "ses_root", parentSessionId: null, permission: "bash",
        }, {
          type: "permission", id: "perm_child", sessionID: "ses_child", rootSessionId: "ses_root",
          targetSessionId: "ses_child", parentSessionId: "ses_root", permission: "bash",
        }],
        questions: [],
      },
    },
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });
  const result = await store.listPending({ workspaceId: "ws_1", sessionId: "ses_root", payloadVersion: 1 });
  assert.deepEqual(result.map((interaction) => interaction.id), ["perm_root"]);
});

test("any invalid question component requires a fresh snapshot instead of returning a partial question", async () => {
  const client = fakeClient({
    snapshot: {
      item: {
        permissions: [],
        questions: [{
          type: "question", id: "question_bad", sessionID: "ses_root", rootSessionId: "ses_root",
          targetSessionId: "ses_root", parentSessionId: null,
          questions: [
            { id: "valid", question: "Continue?", options: [{ label: "Yes" }] },
            { id: "invalid", question: "Broken?", options: [{ description: "missing label" }] },
          ],
        }],
      },
    },
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });
  await assert.rejects(
    store.listPending({ workspaceId: "ws_1", sessionId: "ses_root", payloadVersion: 1 }),
    (error) => /** @type {any} */ (error)?.code === "snapshot_required",
  );
});

test("fallback walks nested ancestry and does not leak an unrelated child", async () => {
  const permissions = [
    { id: "perm_nested", sessionID: "ses_grandchild", permission: "bash" },
    { id: "perm_unrelated", sessionID: "ses_other_child", permission: "bash" },
  ];
  const client = fakeClient({
    permissions,
    sessions: [
      { id: "ses_root" },
      { id: "ses_child", parentID: "ses_root" },
      { id: "ses_grandchild", parentID: "ses_child" },
      { id: "ses_other_root" },
      { id: "ses_other_child", parentID: "ses_other_root" },
    ],
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client, now: () => 1_000 });

  const result = await store.listPending({ workspaceId: "ws_1", sessionId: "ses_root", payloadVersion: 2 });
  const first = /** @type {any} */ (result[0]);

  assert.deepEqual(result.map((interaction) => interaction.id), ["perm_nested"]);
  assert.deepEqual({
    rootSessionId: first.rootSessionId,
    targetSessionId: first.targetSessionId,
    parentSessionId: first.parentSessionId,
    sessionId: first.sessionId,
  }, {
    rootSessionId: "ses_root",
    targetSessionId: "ses_grandchild",
    parentSessionId: "ses_child",
    sessionId: "ses_grandchild",
  });
  assert.equal(client.calls.some((pathname) => pathname.includes("/ses_other_child/permission")), false);
});

test("fallback excludes cyclic ancestry instead of assigning it to a bound root", async () => {
  const client = fakeClient({
    permissions: [{ id: "perm_cycle", sessionID: "ses_cycle_a", permission: "bash" }],
    sessions: [
      { id: "ses_root" },
      { id: "ses_cycle_a", parentID: "ses_cycle_b" },
      { id: "ses_cycle_b", parentID: "ses_cycle_a" },
    ],
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });

  assert.deepEqual(await store.listPending({ workspaceId: "ws_1", sessionId: "ses_root", payloadVersion: 2 }), []);
  assert.equal(client.calls.some((pathname) => pathname.includes("/ses_cycle_a/permission")), false);
});
