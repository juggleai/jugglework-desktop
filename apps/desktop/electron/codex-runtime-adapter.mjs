import { randomUUID } from "node:crypto";
import { validateCodexImageInputs } from "./codex-image-input.mjs";

const CAPABILITIES = Object.freeze({
  images: true, mcp: true, skills: true, approvals: true, steering: true,
  reasoningStream: true, planMode: false, reviewMode: false, sessionFork: false,
});

function text(value) { return typeof value === "string" ? value : ""; }
function positive(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function usage(value) {
  const raw = value?.last ?? value?.total ?? value ?? {};
  return { inputTokens: positive(raw.inputTokens), outputTokens: positive(raw.outputTokens), cachedInputTokens: positive(raw.cachedInputTokens), reasoningTokens: positive(raw.reasoningOutputTokens) };
}

async function userInput(parts, workspaceRoot) {
  const images = await validateCodexImageInputs(parts, workspaceRoot);
  return (Array.isArray(parts) ? parts : []).map((part) => {
    if (part?.type === "text") return { type: "text", text: text(part.text) };
    if (part?.type === "attachment" && part.attachment?.kind === "image") return { type: "localImage", path: images.get(part.attachment.attachmentId) };
    throw new Error("Unsupported Codex input part.");
  });
}

/**
 * Version-pinned Codex App Server adapter (schema rust-v0.147.0).
 * @param {{ processManager: any, resolveLaunch(input: any): Promise<any> | any, now?: () => number, randomId?: () => string }} options
 */
export function createCodexRuntimeAdapter({ processManager, resolveLaunch, now = Date.now, randomId = randomUUID }) {
  if (!processManager || typeof resolveLaunch !== "function") throw new TypeError("Codex runtime adapter options are invalid.");
  const listeners = new Set();
  const workspaces = new Map();
  const threads = new Map();
  const approvals = new Map();

  function emit(binding, type, payload = {}, ids = {}) {
    const event = { schemaVersion: 1, eventId: `evt_${randomId()}`, occurredAt: now(), workspaceId: binding.workspaceId, orgId: binding.orgId, runtimeKind: "codex", ...(ids.sessionId ? { sessionId: ids.sessionId, threadId: ids.threadId } : {}), ...(ids.turnId ? { turnId: ids.turnId } : {}), type, ...payload };
    for (const listener of listeners) listener(event);
  }

  function unknown(binding, method) { emit(binding, "unknown", { originalType: text(method).slice(0, 256) || "invalid", diagnostic: { reason: "unsupported_type" } }); }

  function bindClient(workspace, client) {
    client.onNotification(({ method, params }) => {
      const thread = threads.get(params?.threadId);
      if (!thread) { unknown(workspace, method); return; }
      const ids = { sessionId: thread.sessionId, threadId: thread.id, turnId: text(params?.turnId || params?.turn?.id) };
      if (method === "turn/started" && ids.turnId) emit(workspace, "turn.started", {}, ids);
      else if (method === "item/agentMessage/delta" && ids.turnId) emit(workspace, "assistant.delta", { text: text(params?.delta) }, ids);
      else if ((method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") && ids.turnId) emit(workspace, "reasoning.delta", { text: text(params?.delta) }, ids);
      else if (method === "item/commandExecution/outputDelta" && ids.turnId) emit(workspace, "command.output", { commandId: text(params?.itemId), chunk: text(params?.delta) }, ids);
      else if (method === "thread/tokenUsage/updated" && ids.turnId) emit(workspace, "usage.updated", { usage: usage(params?.tokenUsage) }, ids);
      else if (method === "turn/completed" && ids.turnId) {
        const status = params?.turn?.status;
        if (status === "interrupted") emit(workspace, "turn.interrupted", {}, ids);
        else if (status === "failed") emit(workspace, "turn.failed", { error: { code: "internal", message: "The Codex turn failed.", retryable: false, status: null, metadata: {} } }, ids);
        else emit(workspace, "turn.completed", {}, ids);
      } else if (method === "error" && ids.turnId) {
        emit(workspace, "turn.failed", { error: { code: "gateway_unavailable", message: text(params?.error?.message) || "The Codex gateway request failed.", retryable: params?.willRetry === true, status: null, metadata: {} } }, ids);
      } else if (method === "thread/status/changed") {
        // Turn lifecycle notifications carry the durable state. Thread status
        // is transient UI metadata and must not create an unknown ledger event.
        return;
      } else if (method === "item/started" && ids.turnId && params?.item?.type === "commandExecution") {
        emit(workspace, "command.started", { commandId: text(params.item.id), command: text(params.item.command), cwd: text(params.item.cwd) || workspace.cwd }, ids);
      } else if (method === "item/completed" && ids.turnId && params?.item?.type === "commandExecution") {
        emit(workspace, "command.completed", { commandId: text(params.item.id), exitCode: Number.isInteger(params.item.exitCode) ? params.item.exitCode : null, durationMs: positive(params.item.durationMs) }, ids);
      } else if ((method === "item/started" || method === "item/completed") && !ids.turnId) {
        // Informational items without a turn have no JuggleWork read-model equivalent.
        return;
      } else unknown(workspace, method);
    });
    for (const [method, kind] of [["item/commandExecution/requestApproval", "command"], ["item/fileChange/requestApproval", "file"]]) {
      client.onRequest(method, (params) => new Promise((resolve) => {
        const thread = threads.get(params?.threadId);
        if (!thread) { resolve({ decision: "decline" }); return; }
        const requestId = text(params?.approvalId || params?.itemId);
        approvals.set(requestId, { resolve, threadId: thread.id });
        emit(workspace, "approval.requested", { request: { id: requestId, kind, title: kind === "command" ? "Run command" : "Change files", description: text(params?.reason), choices: ["allow_once", "allow_session", "deny"], metadata: {} } }, { sessionId: thread.sessionId, threadId: thread.id, turnId: text(params?.turnId) });
      }));
    }
  }

  async function startWorkspace(input) {
    const workspace = { id: input.workspaceId, orgId: input.orgId, runtimeKind: "codex", cwd: input.cwd, capabilities: CAPABILITIES, client: null };
    workspaces.set(input.workspaceId, workspace);
    return { id: workspace.id, orgId: workspace.orgId, runtimeKind: workspace.runtimeKind, cwd: workspace.cwd, capabilities: workspace.capabilities };
  }

  async function stopWorkspace(input) { await processManager.stopWorkspace(input.workspaceId); workspaces.delete(input.workspaceId); for (const [id, thread] of threads) if (thread.workspaceId === input.workspaceId) threads.delete(id); }

  function workspace(input) { const value = workspaces.get(input.workspaceId); if (!value || value.orgId !== input.orgId) throw new Error("Codex workspace is not started."); return value; }
  function thread(input) { const value = threads.get(input.threadId); if (!value || value.orgId !== input.orgId || value.workspaceId !== input.workspaceId || value.sessionId !== input.sessionId) throw new Error("Codex thread scope mismatch."); return value; }
  function threadResult(input, raw, workspaceValue) {
    const backendThreadId = text(raw?.thread?.id);
    if (!backendThreadId) throw new Error("Codex returned an invalid thread.");
    const result = { id: backendThreadId, orgId: input.orgId, sessionId: input.sessionId, workspaceId: input.workspaceId, backendThreadId, runtimeKind: "codex", modelProviderId: text(raw?.modelProvider) || input.modelProviderId, modelId: text(raw?.model) || input.modelId, createdAt: positive(raw?.thread?.createdAt) * 1000 || now() };
    threads.set(result.id, result);
    emit(workspaceValue, "thread.created", { thread: result });
    return result;
  }

  async function ensureClient(ws, input) {
    if (ws.client) return ws.client;
    const launch = await resolveLaunch(input);
    const handle = await processManager.startWorkspace({ ...launch, organizationId: input.orgId, workspaceId: input.workspaceId, cwd: ws.cwd, workspaceType: "local" });
    ws.client = handle.appServer;
    bindClient(ws, ws.client);
    return ws.client;
  }
  async function createThread(input) { const ws = workspace(input); const client = await ensureClient(ws, input); return threadResult(input, await client.request("thread/start", { cwd: input.cwd, model: input.modelId, modelProvider: "jugglework_gateway", approvalPolicy: "on-request", sandbox: "workspace-write", ephemeral: false }), ws); }
  async function resumeThread(input) { const ws = workspace(input); const client = await ensureClient(ws, input); return threadResult(input, await client.request("thread/resume", { threadId: input.backendThreadId, model: input.modelId, modelProvider: "jugglework_gateway" }), ws); }
  async function archiveThread(input) { const value = thread(input); await workspace(input).client.request("thread/archive", { threadId: value.backendThreadId }); threads.delete(value.id); }
  async function sendTurn(input) {
    const value = thread(input);
    const ws = workspace(input);
    const result = await ws.client.request("turn/start", { threadId: value.backendThreadId, input: await userInput(input.content, ws.cwd) });
    const turnId = text(result?.turn?.id) || `turn_${randomId()}`;
    emit(ws, "user.message", { content: input.content }, { sessionId: value.sessionId, threadId: value.id, turnId });
  }
  async function steerTurn(input) {
    const value = thread(input);
    const ws = workspace(input);
    await ws.client.request("turn/steer", { threadId: value.backendThreadId, expectedTurnId: input.turnId, input: await userInput(input.content, ws.cwd) });
    emit(ws, "user.message", { content: input.content }, { sessionId: value.sessionId, threadId: value.id, turnId: input.turnId });
  }
  async function interruptTurn(input) { const value = thread(input); await workspace(input).client.request("turn/interrupt", { threadId: value.backendThreadId, turnId: input.turnId }); }
  async function respondToApproval(input) { thread(input); const pending = approvals.get(input.requestId); if (!pending || pending.threadId !== input.threadId) throw new Error("Codex approval is no longer pending."); approvals.delete(input.requestId); pending.resolve({ decision: input.decision === "allow_once" ? "accept" : input.decision === "allow_session" ? "acceptForSession" : "decline" }); }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }

  return Object.freeze({ kind: "codex", startWorkspace, stopWorkspace, createThread, resumeThread, archiveThread, sendTurn, steerTurn, interruptTurn, respondToApproval, subscribe });
}
