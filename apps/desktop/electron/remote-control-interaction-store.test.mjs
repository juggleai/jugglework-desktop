import assert from "node:assert/strict";
import { test } from "node:test";

import { createRemoteControlInteractionStore } from "./remote-control-interaction-store.mjs";

function fakeClient({ interactions = [] } = {}) {
  return {
    async getJson() { return { snapshot: { interactions } }; },
  };
}

test("listPending returns empty for invalid arguments", async () => {
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: fakeClient() });
  assert.deepEqual(await store.listPending({ workspaceId: "", sessionId: "" }), []);
});

test("listPending returns normalized permission interaction", async () => {
  const client = fakeClient({
    interactions: [{
      id: "perm_1",
      sessionId: "ses_1",
      kind: "permission",
      state: "pending",
      title: "bash",
      requestedAt: 1,
    }],
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });
  const result = await store.listPending({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "permission");
  assert.equal(result[0].id, "perm_1");
  assert.deepEqual(result[0].permittedResponses, ["allow_once", "reject"]);
  assert.ok(result[0].description.includes("bash"));
  assert.ok(result[0].description.includes("bash"));
});

test("listPending returns normalized question interaction", async () => {
  const client = fakeClient({
    interactions: [{
      id: "q_1",
      sessionId: "ses_1",
      kind: "question",
      state: "pending",
      requestedAt: 1,
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
    interactions: [
      { id: "perm_1", sessionId: "ses_1", kind: "permission", state: "pending", title: "bash", requestedAt: 1 },
      { id: "perm_2", sessionId: "ses_other", kind: "permission", state: "pending", title: "bash", requestedAt: 1 },
    ],
  });
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });
  const result = await store.listPending({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "perm_1");
});

test("listPending returns empty on client error", async () => {
  const client = { async getJson() { throw new Error("timeout"); } };
  const store = createRemoteControlInteractionStore({ managedRuntimeClient: client });
  const result = await store.listPending({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.deepEqual(result, []);
});
