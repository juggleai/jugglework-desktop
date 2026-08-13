import type {
  AgentRuntimeContract,
  RuntimeEvent,
  RuntimeThread,
  RuntimeWorkspace,
} from "@jugglework/types/agent-runtime";

type OpenCodeClient = {
  session: {
    create(input: { directory?: string }): Promise<unknown>;
    promptAsync(input: Record<string, unknown>): Promise<unknown>;
    abort(input: { sessionID: string }): Promise<unknown>;
  };
  permission?: { reply(input: Record<string, unknown>): Promise<unknown> };
  v2?: { session?: { permission?: { reply(input: Record<string, unknown>): Promise<unknown> } } };
};

type Options = {
  createClient(input: { workspaceId: string; cwd: string }): OpenCodeClient;
  archiveSession?(input: { client: OpenCodeClient; sessionId: string }): Promise<void>;
  subscribeEvents?(input: {
    workspaceId: string;
    listener: (event: unknown) => void;
  }): (() => void) | Promise<() => void>;
  now?: () => number;
};

function unwrap<T>(value: unknown): T {
  return value && typeof value === "object" && "data" in value && (value as { data?: T }).data !== undefined
    ? (value as { data: T }).data
    : value as T;
}

/** Existing Renderer OpenCode transport behind the shared runtime contract. */
export function createOpenCodeRuntimeAdapter(options: Options): AgentRuntimeContract {
  const now = options.now ?? Date.now;
  const workspaces = new Map<string, RuntimeWorkspace & { client: OpenCodeClient }>();
  const threads = new Map<string, RuntimeThread>();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const eventUnsubscribers = new Map<string, () => void>();
  const activeTurnIds = new Map<string, string>();
  let eventSequence = 0;

  function emit(event: RuntimeEvent) {
    for (const listener of listeners) listener(event);
  }

  function receiveEvent(workspaceId: string, rawValue: unknown) {
    const raw = rawValue && typeof rawValue === "object" && "data" in rawValue
      ? (rawValue as { data?: unknown }).data
      : rawValue;
    if (!raw || typeof raw !== "object") return;
    const event = raw as { type?: unknown; properties?: unknown };
    const type = typeof event.type === "string" ? event.type : "invalid";
    const properties = event.properties && typeof event.properties === "object"
      ? event.properties as Record<string, unknown>
      : {};
    const backendThreadId = typeof properties.sessionID === "string" ? properties.sessionID : null;
    const thread = backendThreadId ? threads.get(backendThreadId) : null;
    const ws = workspaces.get(workspaceId);
    if (!ws || (thread && thread.workspaceId !== workspaceId)) return;
    const occurredAt = now();
    const eventId = `opencode:${workspaceId}:${++eventSequence}`;
    const base = { schemaVersion: 1 as const, eventId, occurredAt, workspaceId, orgId: ws.orgId, runtimeKind: "opencode" as const };
    if (!thread) {
      emit({ ...base, type: "unknown", originalType: type, diagnostic: { reason: "invalid_payload" } });
      return;
    }
    const messageId = typeof properties.messageID === "string" ? properties.messageID : null;
    const info = properties.info && typeof properties.info === "object" ? properties.info as Record<string, unknown> : null;
    const infoId = typeof info?.id === "string" ? info.id : null;
    const turnId = messageId ?? infoId ?? activeTurnIds.get(thread.id) ?? `turn:${thread.id}`;
    const scoped = { ...base, sessionId: thread.sessionId, threadId: thread.id, turnId };

    if (type === "message.updated" && infoId && info?.role === "assistant") {
      activeTurnIds.set(thread.id, infoId);
      emit({ ...scoped, turnId: infoId, type: "turn.started" });
      return;
    }
    if (type === "message.part.delta" && typeof properties.delta === "string") {
      emit({ ...scoped, type: "assistant.delta", text: properties.delta });
      return;
    }
    if (type === "permission.asked" || type === "permission.v2.asked") {
      const requestId = typeof properties.id === "string" ? properties.id : null;
      if (requestId) {
        emit({ ...scoped, type: "approval.requested", request: {
          id: requestId, kind: "tool", title: "OpenCode permission", description: "OpenCode is waiting for permission.",
          choices: ["allow_once", "allow_session", "deny"], metadata: {},
        } });
        return;
      }
    }
    if (type === "session.idle") {
      emit({ ...scoped, type: "turn.completed" });
      activeTurnIds.delete(thread.id);
      return;
    }
    if (type === "session.error") {
      emit({ ...scoped, type: "turn.failed", error: {
        code: "internal", message: "The OpenCode turn failed.", retryable: true, status: null, metadata: {},
      } });
      activeTurnIds.delete(thread.id);
      return;
    }
    emit({ ...base, type: "unknown", originalType: type, diagnostic: { reason: "unsupported_type" } });
  }

  function workspace(input: { orgId: string; workspaceId: string }) {
    const value = workspaces.get(input.workspaceId);
    if (!value || value.orgId !== input.orgId) throw new Error("OpenCode workspace scope mismatch.");
    return value;
  }

  function thread(input: { orgId: string; workspaceId: string; sessionId: string; threadId: string }) {
    const value = threads.get(input.threadId);
    if (!value || value.orgId !== input.orgId || value.workspaceId !== input.workspaceId || value.sessionId !== input.sessionId) {
      throw new Error("OpenCode thread scope mismatch.");
    }
    return value;
  }

  const adapter: AgentRuntimeContract = {
    kind: "opencode",
    async startWorkspace(input) {
      const result: RuntimeWorkspace = {
        id: input.workspaceId,
        orgId: input.orgId,
        runtimeKind: "opencode",
        cwd: input.cwd,
        capabilities: {
          images: true, mcp: true, skills: true, approvals: true, steering: true,
          reasoningStream: true, planMode: true, reviewMode: false, sessionFork: true,
        },
      };
      workspaces.set(input.workspaceId, { ...result, client: options.createClient(input) });
      if (options.subscribeEvents && !eventUnsubscribers.has(input.workspaceId)) {
        const pending = options.subscribeEvents({ workspaceId: input.workspaceId, listener: (event) => receiveEvent(input.workspaceId, event) });
        const unsubscribe = await pending;
        eventUnsubscribers.set(input.workspaceId, unsubscribe);
      }
      return result;
    },
    async stopWorkspace(input) {
      workspace(input);
      eventUnsubscribers.get(input.workspaceId)?.();
      eventUnsubscribers.delete(input.workspaceId);
      workspaces.delete(input.workspaceId);
      for (const [id, value] of threads) if (value.workspaceId === input.workspaceId) {
        threads.delete(id);
        activeTurnIds.delete(id);
      }
    },
    async createThread(input) {
      const ws = workspace(input);
      const raw = unwrap<{ id: string; time?: { created?: number } }>(await ws.client.session.create({ directory: input.cwd }));
      if (!raw?.id) throw new Error("OpenCode returned an invalid session.");
      const result: RuntimeThread = {
        id: raw.id, backendThreadId: raw.id, orgId: input.orgId, workspaceId: input.workspaceId,
        sessionId: input.sessionId, runtimeKind: "opencode", modelProviderId: input.modelProviderId,
        modelId: input.modelId, createdAt: raw.time?.created ?? now(),
      };
      threads.set(result.id, result);
      emit({
        schemaVersion: 1, eventId: `opencode:${input.workspaceId}:${++eventSequence}`, occurredAt: now(),
        workspaceId: input.workspaceId, orgId: input.orgId, runtimeKind: "opencode", type: "thread.created", thread: result,
      });
      return result;
    },
    async resumeThread(input) {
      const ws = workspace(input);
      const result: RuntimeThread = {
        id: input.backendThreadId, backendThreadId: input.backendThreadId, orgId: input.orgId,
        workspaceId: input.workspaceId, sessionId: input.sessionId, runtimeKind: "opencode",
        modelProviderId: input.modelProviderId, modelId: input.modelId, createdAt: now(),
      };
      void ws;
      threads.set(result.id, result);
      return result;
    },
    async archiveThread(input) {
      const value = thread(input);
      const ws = workspace(input);
      await options.archiveSession?.({ client: ws.client, sessionId: value.backendThreadId });
      threads.delete(value.id);
      activeTurnIds.delete(value.id);
    },
    async sendTurn(input) {
      const value = thread(input);
      const ws = workspace(input);
      const parts = input.content.map((part) => part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "file", mime: part.attachment.mimeType, filename: part.attachment.name, url: part.attachment.objectRef });
      await ws.client.session.promptAsync({ sessionID: value.backendThreadId, parts });
    },
    async steerTurn(input) {
      const value = thread(input);
      const ws = workspace(input);
      const parts = input.content.map((part) => part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "file", mime: part.attachment.mimeType, filename: part.attachment.name, url: part.attachment.objectRef });
      await ws.client.session.promptAsync({ sessionID: value.backendThreadId, parts });
    },
    async interruptTurn(input) {
      const value = thread(input);
      await workspace(input).client.session.abort({ sessionID: value.backendThreadId });
    },
    async respondToApproval(input) {
      const value = thread(input);
      const client = workspace(input).client;
      const response = input.decision === "allow_once" ? "once" : input.decision === "allow_session" ? "always" : "reject";
      const v2 = client.v2?.session?.permission?.reply;
      if (v2) await v2({ sessionID: value.backendThreadId, requestID: input.requestId, response });
      else if (client.permission?.reply) await client.permission.reply({ requestID: input.requestId, reply: response });
      else throw new Error("OpenCode permission API is unavailable.");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return adapter;
}
