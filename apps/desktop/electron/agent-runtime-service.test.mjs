import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentRuntimeServiceError, createAgentRuntimeService } from "./agent-runtime-service.mjs";

function adapter(kind = "codex") {
  const listeners = new Set();
  const calls = [];
  return {
    kind, calls,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of listeners) listener(event); },
    async startWorkspace(input) { calls.push(["startWorkspace", input]); return { id: input.workspaceId, orgId: input.orgId, runtimeKind: kind, cwd: input.cwd, capabilities: { images: true, mcp: true, skills: true, approvals: true, steering: true, reasoningStream: true, planMode: false, reviewMode: false, sessionFork: false } }; },
    async stopWorkspace(input) { calls.push(["stopWorkspace", input]); },
    async createThread(input) { calls.push(["createThread", input]); return { id: "thr_1", backendThreadId: "backend_1", orgId: input.orgId, workspaceId: input.workspaceId, sessionId: input.sessionId, runtimeKind: kind, modelProviderId: input.modelProviderId, modelId: input.modelId, createdAt: 1 }; },
    async resumeThread(input) { calls.push(["resumeThread", input]); return { id: "thr_2", backendThreadId: input.backendThreadId, orgId: input.orgId, workspaceId: input.workspaceId, sessionId: input.sessionId, runtimeKind: kind, modelProviderId: input.modelProviderId, modelId: input.modelId, createdAt: 1 }; },
    async archiveThread(input) { calls.push(["archiveThread", input]); },
    async sendTurn(input) { calls.push(["sendTurn", input]); },
    async steerTurn(input) { calls.push(["steerTurn", input]); },
    async interruptTurn(input) { calls.push(["interruptTurn", input]); },
    async respondToApproval(input) { calls.push(["respondToApproval", input]); },
  };
}

const workspace = { orgId: "org_1", workspaceId: "ws_1", cwd: "/workspace" };
const thread = { orgId: "org_1", workspaceId: "ws_1", sessionId: "ses_1", threadId: "thr_1" };

describe("agent runtime service", () => {
  it("routes a bound workspace/thread and rejects cross-scope or unknown runtime calls", async () => {
    const codex = adapter();
    const service = createAgentRuntimeService({ adapters: [codex] });
    await service.startWorkspace("codex", workspace);
    await service.createThread("codex", { ...workspace, sessionId: "ses_1", modelProviderId: "lpr_gateway", modelId: "model" });
    await service.sendTurn("codex", { ...thread, content: [{ type: "text", text: "hello" }] });
    await assert.rejects(service.sendTurn("codex", { ...thread, orgId: "org_2", content: [] }), (error) => error instanceof AgentRuntimeServiceError && error.code === "thread_scope_mismatch");
    await assert.rejects(service.sendTurn("opencode", { ...thread, content: [] }), (error) => error instanceof AgentRuntimeServiceError && error.code === "thread_scope_mismatch");
    await assert.rejects(service.startWorkspace("future", workspace), (error) => error instanceof AgentRuntimeServiceError && error.code === "unknown_runtime");
    await assert.rejects(service.sendTurn("codex", { ...thread, content: [], rawBackend: "forbidden" }), (error) => error instanceof AgentRuntimeServiceError && error.code === "invalid_request");
    assert.equal(codex.calls.at(-1)[0], "sendTurn");
  });

  it("filters spoofed adapter events and removes bindings on archive and workspace stop", async () => {
    const codex = adapter();
    const service = createAgentRuntimeService({ adapters: [codex] });
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.startWorkspace("codex", workspace);
    await service.createThread("codex", { ...workspace, sessionId: "ses_1", modelProviderId: "provider", modelId: "model" });
    codex.emit({ ...thread, eventId: "evt_1", occurredAt: 2, runtimeKind: "codex", type: "turn.started" });
    codex.emit({ ...thread, eventId: "evt_spoof", occurredAt: 3, orgId: "org_2", runtimeKind: "codex", type: "turn.started" });
    assert.equal(events.length, 1);
    await service.archiveThread("codex", thread);
    await assert.rejects(service.sendTurn("codex", { ...thread, content: [] }), (error) => error instanceof AgentRuntimeServiceError && error.code === "thread_scope_mismatch");
    await service.stopWorkspace("codex", { orgId: workspace.orgId, workspaceId: workspace.workspaceId });
    await assert.rejects(service.createThread("codex", { ...workspace, sessionId: "ses_2" }), (error) => error instanceof AgentRuntimeServiceError && error.code === "workspace_scope_mismatch");
  });

  it("deduplicates event IDs and drops events that regress a thread stream", async () => {
    const codex = adapter();
    const service = createAgentRuntimeService({ adapters: [codex] });
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.startWorkspace("codex", workspace);
    await service.createThread("codex", { ...workspace, sessionId: "ses_1", modelProviderId: "provider", modelId: "model" });
    const base = { ...thread, runtimeKind: "codex", turnId: "turn_1", type: "assistant.delta" };
    codex.emit({ ...base, eventId: "evt_new", occurredAt: 5, text: "new" });
    codex.emit({ ...base, eventId: "evt_new", occurredAt: 6, text: "duplicate" });
    codex.emit({ ...base, eventId: "evt_old", occurredAt: 4, text: "old" });
    assert.deepEqual(events.map((event) => event.text), ["new"]);
  });
});
