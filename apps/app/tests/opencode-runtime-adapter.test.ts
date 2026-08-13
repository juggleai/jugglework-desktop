import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createOpenCodeRuntimeAdapter } from "../src/react-app/domains/session/sync/opencode-runtime-adapter.ts";

describe("OpenCode runtime adapter", () => {
  test("maps create, send, interrupt and approval to the existing SDK", async () => {
    const calls: unknown[][] = [];
    const client = {
      session: {
        async create(input: unknown) { calls.push(["create", input]); return { data: { id: "backend_1", time: { created: 4 } } }; },
        async promptAsync(input: unknown) { calls.push(["prompt", input]); return {}; },
        async abort(input: unknown) { calls.push(["abort", input]); return {}; },
      },
      v2: { session: { permission: { async reply(input: unknown) { calls.push(["approval", input]); return {}; } } } },
    };
    const adapter = createOpenCodeRuntimeAdapter({ createClient: () => client, now: () => 10 });
    await adapter.startWorkspace({ orgId: "org_1", workspaceId: "ws_1", cwd: "/workspace" });
    const thread = await adapter.createThread({ orgId: "org_1", workspaceId: "ws_1", sessionId: "ses_1", cwd: "/workspace", modelProviderId: "provider", modelId: "model" });
    const scope = { orgId: "org_1", workspaceId: "ws_1", sessionId: "ses_1", threadId: thread.id };
    await adapter.sendTurn({ ...scope, content: [{ type: "text", text: "hello" }] });
    await adapter.interruptTurn({ ...scope, turnId: "turn_1" });
    await adapter.respondToApproval({ ...scope, requestId: "req_1", decision: "allow_session" });
    assert.deepEqual(calls, [
      ["create", { directory: "/workspace" }],
      ["prompt", { sessionID: "backend_1", parts: [{ type: "text", text: "hello" }] }],
      ["abort", { sessionID: "backend_1" }],
      ["approval", { sessionID: "backend_1", requestID: "req_1", response: "always" }],
    ]);
  });

  test("normalizes streamed deltas, approvals, terminal, errors and unknown events", async () => {
    let receive: ((event: unknown) => void) | undefined;
    const client = {
      session: {
        async create() { return { data: { id: "backend_1" } }; },
        async promptAsync() {},
        async abort() {},
      },
    };
    const adapter = createOpenCodeRuntimeAdapter({
      createClient: () => client,
      subscribeEvents: ({ listener }) => { receive = listener; return () => {}; },
      now: () => 10,
    });
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.startWorkspace({ orgId: "org_1", workspaceId: "ws_1", cwd: "/workspace" });
    await adapter.createThread({ orgId: "org_1", workspaceId: "ws_1", sessionId: "ses_1", cwd: "/workspace", modelProviderId: "provider", modelId: "model" });
    receive?.({ type: "message.updated", properties: { info: { id: "turn_1", role: "assistant", sessionID: "backend_1" }, sessionID: "backend_1" } });
    receive?.({ type: "message.part.delta", properties: { sessionID: "backend_1", messageID: "turn_1", partID: "part_1", delta: "hello" } });
    receive?.({ type: "permission.asked", properties: { sessionID: "backend_1", id: "approval_1" } });
    receive?.({ type: "vendor.private", properties: { sessionID: "backend_1", secret: "must-not-cross" } });
    receive?.({ type: "session.idle", properties: { sessionID: "backend_1" } });
    receive?.({ type: "session.error", properties: { sessionID: "backend_1", error: "backend-stack-detail" } });
    assert.deepEqual(events.map((event) => event.type), [
      "thread.created", "turn.started", "assistant.delta", "approval.requested", "unknown", "turn.completed", "turn.failed",
    ]);
    assert.equal(JSON.stringify(events).includes("must-not-cross"), false);
    assert.equal(JSON.stringify(events).includes("backend-stack-detail"), false);
  });
});
