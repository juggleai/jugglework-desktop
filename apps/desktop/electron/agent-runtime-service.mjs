const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RUNTIME_KINDS = new Set(["opencode", "codex"]);
const METHOD_SCHEMAS = Object.freeze({
  startWorkspace: ["orgId", "workspaceId", "cwd"],
  stopWorkspace: ["orgId", "workspaceId"],
  createThread: ["orgId", "sessionId", "workspaceId", "cwd", "modelProviderId", "modelId", "reasoningEffort"],
  resumeThread: ["orgId", "sessionId", "workspaceId", "backendThreadId", "modelProviderId", "modelId", "reasoningEffort"],
  archiveThread: ["orgId", "workspaceId", "sessionId", "threadId"],
  sendTurn: ["orgId", "workspaceId", "sessionId", "threadId", "content"],
  steerTurn: ["orgId", "workspaceId", "sessionId", "threadId", "turnId", "content"],
  interruptTurn: ["orgId", "workspaceId", "sessionId", "threadId", "turnId"],
  respondToApproval: ["orgId", "workspaceId", "sessionId", "threadId", "requestId", "decision"],
});

export class AgentRuntimeServiceError extends Error {
  constructor(code) {
    super("The agent runtime request was rejected.");
    this.name = "AgentRuntimeServiceError";
    this.code = code;
  }
}

function id(value, code = "invalid_request") {
  const text = String(value ?? "").trim();
  if (!ID.test(text)) throw new AgentRuntimeServiceError(code);
  return text;
}

function runtimeKind(value) {
  const kind = String(value ?? "").trim();
  if (!RUNTIME_KINDS.has(kind)) throw new AgentRuntimeServiceError("unknown_runtime");
  return kind;
}

function scope(input) {
  return { orgId: id(input?.orgId), workspaceId: id(input?.workspaceId) };
}

function exactInput(method, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentRuntimeServiceError("invalid_request");
  const allowed = METHOD_SCHEMAS[method];
  if (!allowed || Object.keys(input).some((key) => !allowed.includes(key))) throw new AgentRuntimeServiceError("invalid_request");
}

/**
 * Main-only router around runtime adapters. Every thread binding is learned
 * from an authoritative create/resume result, never from renderer assertions.
 */
export function createAgentRuntimeService({ adapters = [] } = {}) {
  const runtimes = new Map();
  const workspaces = new Map();
  const threads = new Map();
  const listeners = new Set();
  const unsubscribers = [];
  const seenEventIds = new Map();
  const lastOccurredAtByStream = new Map();
  const MAX_SEEN_EVENTS = 10_000;

  for (const adapter of adapters) {
    const kind = runtimeKind(adapter?.kind);
    if (runtimes.has(kind)) throw new TypeError(`Duplicate runtime adapter: ${kind}`);
    runtimes.set(kind, adapter);
    unsubscribers.push(adapter.subscribe((event) => {
      if (!event || typeof event.eventId !== "string" || seenEventIds.has(event.eventId)) return;
      const binding = event?.threadId ? threads.get(event.threadId) : null;
      if (binding && (event.orgId !== binding.orgId || event.workspaceId !== binding.workspaceId ||
          event.sessionId !== binding.sessionId || event.runtimeKind !== binding.runtimeKind)) return;
      const streamKey = event.threadId
        ? `${event.runtimeKind}\u0000${event.threadId}\u0000${event.turnId ?? ""}`
        : `${event.runtimeKind}\u0000${event.workspaceId}`;
      const occurredAt = Number(event.occurredAt);
      const previousOccurredAt = lastOccurredAtByStream.get(streamKey) ?? -1;
      // Lifecycle and delta events are emitted by both backends in order. An
      // older event arriving after a newer event must never regress UI state.
      if (!Number.isSafeInteger(occurredAt) || occurredAt < previousOccurredAt) return;
      lastOccurredAtByStream.set(streamKey, occurredAt);
      seenEventIds.set(event.eventId, true);
      if (seenEventIds.size > MAX_SEEN_EVENTS) {
        const oldestEventId = seenEventIds.keys().next().value;
        if (oldestEventId !== undefined) seenEventIds.delete(oldestEventId);
      }
      for (const listener of listeners) listener(event);
    }));
  }

  function adapter(kind) {
    const value = runtimes.get(runtimeKind(kind));
    if (!value) throw new AgentRuntimeServiceError("runtime_unavailable");
    return value;
  }

  function workspaceBinding(input) {
    const expected = scope(input);
    const binding = workspaces.get(expected.workspaceId);
    if (!binding || binding.orgId !== expected.orgId) throw new AgentRuntimeServiceError("workspace_scope_mismatch");
    return binding;
  }

  function threadBinding(input) {
    const expected = { ...scope(input), sessionId: id(input?.sessionId), threadId: id(input?.threadId) };
    const binding = threads.get(expected.threadId);
    if (!binding || binding.orgId !== expected.orgId || binding.workspaceId !== expected.workspaceId ||
        binding.sessionId !== expected.sessionId) throw new AgentRuntimeServiceError("thread_scope_mismatch");
    return binding;
  }

  async function startWorkspace(kind, input) {
    exactInput("startWorkspace", input);
    const parsed = { ...scope(input), cwd: String(input?.cwd ?? "").trim() };
    if (!parsed.cwd || parsed.cwd.length > 4096) throw new AgentRuntimeServiceError("invalid_request");
    const current = workspaces.get(parsed.workspaceId);
    if (current && (current.orgId !== parsed.orgId || current.runtimeKind !== runtimeKind(kind))) {
      throw new AgentRuntimeServiceError("workspace_scope_mismatch");
    }
    const result = await adapter(kind).startWorkspace(parsed);
    if (result.orgId !== parsed.orgId || result.id !== parsed.workspaceId || result.runtimeKind !== kind) {
      throw new AgentRuntimeServiceError("invalid_runtime_response");
    }
    workspaces.set(parsed.workspaceId, { ...parsed, runtimeKind: kind });
    return result;
  }

  async function stopWorkspace(kind, input) {
    exactInput("stopWorkspace", input);
    const binding = workspaceBinding(input);
    if (binding.runtimeKind !== runtimeKind(kind)) throw new AgentRuntimeServiceError("workspace_scope_mismatch");
    await adapter(kind).stopWorkspace(scope(input));
    workspaces.delete(binding.workspaceId);
    for (const [threadId, thread] of threads) if (thread.workspaceId === binding.workspaceId) threads.delete(threadId);
  }

  async function createThread(kind, input) {
    exactInput("createThread", input);
    const workspace = workspaceBinding(input);
    if (workspace.runtimeKind !== runtimeKind(kind)) throw new AgentRuntimeServiceError("workspace_scope_mismatch");
    const result = await adapter(kind).createThread({ ...input, orgId: workspace.orgId, workspaceId: workspace.workspaceId });
    if (result.orgId !== workspace.orgId || result.workspaceId !== workspace.workspaceId || result.sessionId !== input.sessionId || result.runtimeKind !== kind) {
      throw new AgentRuntimeServiceError("invalid_runtime_response");
    }
    threads.set(result.id, {
      orgId: result.orgId, workspaceId: result.workspaceId, sessionId: result.sessionId,
      threadId: result.id, runtimeKind: result.runtimeKind,
    });
    return result;
  }

  async function resumeThread(kind, input) {
    exactInput("resumeThread", input);
    const workspace = workspaceBinding(input);
    if (workspace.runtimeKind !== runtimeKind(kind)) throw new AgentRuntimeServiceError("workspace_scope_mismatch");
    const result = await adapter(kind).resumeThread(input);
    if (result.orgId !== workspace.orgId || result.workspaceId !== workspace.workspaceId || result.sessionId !== input.sessionId || result.runtimeKind !== kind) {
      throw new AgentRuntimeServiceError("invalid_runtime_response");
    }
    threads.set(result.id, {
      orgId: result.orgId, workspaceId: result.workspaceId, sessionId: result.sessionId,
      threadId: result.id, runtimeKind: result.runtimeKind,
    });
    return result;
  }

  async function threadOperation(kind, input, method, remove = false) {
    exactInput(method, input);
    const binding = threadBinding(input);
    if (binding.runtimeKind !== runtimeKind(kind)) throw new AgentRuntimeServiceError("thread_scope_mismatch");
    const result = await adapter(kind)[method](input);
    if (remove) threads.delete(binding.threadId);
    return result;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Runtime event listener is required.");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function dispose() {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    listeners.clear();
    await Promise.all([...runtimes.values()].map((value) => value.dispose?.()).filter(Boolean));
    workspaces.clear();
    threads.clear();
    seenEventIds.clear();
    lastOccurredAtByStream.clear();
  }

  return Object.freeze({
    startWorkspace, stopWorkspace, createThread, resumeThread,
    archiveThread: (kind, input) => threadOperation(kind, input, "archiveThread", true),
    sendTurn: (kind, input) => threadOperation(kind, input, "sendTurn"),
    steerTurn: (kind, input) => threadOperation(kind, input, "steerTurn"),
    interruptTurn: (kind, input) => threadOperation(kind, input, "interruptTurn"),
    respondToApproval: (kind, input) => threadOperation(kind, input, "respondToApproval"),
    subscribe, dispose,
  });
}
