import {
  agentRuntimeCatalogSchema,
  agentRuntimeDescriptorSchema,
  agentRuntimeHealthSchema,
  agentRuntimeModelSchema,
  canonicalAgentEventSchema,
  canonicalAgentSessionSchema,
  canonicalSessionLinkSchema,
  agentContinuationPreviewSchema,
  agentContinuationResultSchema,
  canonicalInteractionResolutionSchema,
  canonicalSessionSnapshotSchema,
  agentRuntimeSupportDiagnosticsSchema,
  type AgentRuntimeCatalog,
  type AgentRuntimeDescriptor,
  type AgentRuntimeHealth,
  type AgentRuntimeModel,
  type CanonicalAgentEvent,
  type CanonicalAgentSession,
  type CanonicalInteractionResolution,
  type CanonicalSessionSnapshot,
  type AgentContinuationContext,
  type AgentContinuationPreview,
  type AgentContinuationResult,
  type CanonicalSessionLink,
  type AgentRuntimeSupportDiagnostics,
  type AgentRuntimeCurrentTurnConfiguration,
} from "@jugglework/types/agent-runtime";

import { desktopFetch } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";

export const CANONICAL_AGENT_API_VERSION = "v1" as const;

export type CanonicalAgentClientOptions = {
  baseUrl: string;
  workspaceId: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
};

export type CanonicalSessionListOptions = {
  start?: number;
  search?: string;
  limit?: number;
};

export type CreateCanonicalSessionInput = {
  runtimeId?: string;
  title: string;
  canonicalCwd?: string;
  configuration?: Record<string, unknown>;
};

export type StartCanonicalRunInput = {
  prompt: Record<string, unknown>;
  whenBusy?: "reject" | "steer" | "enqueue";
  origin?: "local-renderer" | "remote-control";
  startCommandCorrelationId?: string | null;
  confirmAmbiguousRetry?: boolean;
  currentTurn?: AgentRuntimeCurrentTurnConfiguration;
};

export type CanonicalRunHandle = {
  runId: string;
  status?: string;
};

export type StartCanonicalRunResult = {
  disposition: "started" | "enqueued";
  run: CanonicalRunHandle | null;
  pendingOperationId?: string;
  position?: number;
};

export type CanonicalWorkspaceEventBatch = {
  schemaVersion: 1;
  workspaceId: string;
  events: CanonicalAgentEvent[];
  cursor: Record<string, number>;
  cursorToken: string;
  requiresSnapshot: boolean;
  snapshots?: CanonicalSessionSnapshot[];
};

export class CanonicalAgentClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CanonicalAgentClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function workspaceAgentPath(workspaceId: string, suffix: string): string {
  return `/workspace/${encodeURIComponent(workspaceId)}/agent/${CANONICAL_AGENT_API_VERSION}${suffix}`;
}

function unwrapItem(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of ["item", "session", "runtime", "health", "snapshot"] as const) {
    if (key in record) return record[key];
  }
  return value;
}

function unwrapItems(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return value;
  return "items" in value ? (value as { items: unknown }).items : value;
}

function runtimeCatalog(value: unknown): AgentRuntimeCatalog {
  const candidate = unwrapItem(value);
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && "runtimes" in candidate) {
    return agentRuntimeCatalogSchema.parse(candidate);
  }
  return agentRuntimeCatalogSchema.parse({ schemaVersion: 1, runtimes: unwrapItems(candidate) });
}

function requestFetch(options: CanonicalAgentClientOptions, url: string): typeof globalThis.fetch {
  if (options.fetch) return options.fetch;
  return isDesktopRuntime() ? desktopFetch : globalThis.fetch;
}

/** Runtime-neutral client for the versioned JuggleWork agent API. */
export function createCanonicalAgentClient(options: CanonicalAgentClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const workspaceId = options.workspaceId.trim();
  if (!baseUrl) throw new Error("Canonical agent client requires a baseUrl");
  if (!workspaceId) throw new Error("Canonical agent client requires a workspaceId");

  const request = async (suffix: string, init: RequestInit = {}): Promise<unknown> => {
    const url = `${baseUrl}${workspaceAgentPath(workspaceId, suffix)}`;
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.token?.trim()) headers.set("Authorization", `Bearer ${options.token.trim()}`);
    const response = await requestFetch(options, url)(url, { ...init, headers });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      if (response.ok) throw new CanonicalAgentClientError(502, "invalid_response", "Canonical agent API returned invalid JSON");
    }
    if (!response.ok) {
      const error = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      throw new CanonicalAgentClientError(
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
        typeof error.message === "string" ? error.message : response.statusText || "Canonical agent request failed",
        error.details,
      );
    }
    return payload;
  };

  const openEventStream = async (cursorToken: string | null, signal: AbortSignal): Promise<Response> => {
    const url = `${baseUrl}${workspaceAgentPath(workspaceId, "/events")}`;
    const headers = new Headers({ Accept: "text/event-stream" });
    if (cursorToken) headers.set("Last-Event-ID", cursorToken);
    if (options.token?.trim()) headers.set("Authorization", `Bearer ${options.token.trim()}`);
    const response = await requestFetch(options, url)(url, { headers, signal });
    if (!response.ok || !response.body) {
      throw new CanonicalAgentClientError(response.status, "event_stream_failed", response.statusText || "Canonical event stream failed");
    }
    return response;
  };

  return {
    baseUrl,
    workspaceId,
    listRuntimes: async (): Promise<AgentRuntimeCatalog> => runtimeCatalog(await request("/runtimes")),
    getRuntime: async (runtimeId: string): Promise<AgentRuntimeDescriptor> =>
      agentRuntimeDescriptorSchema.parse(unwrapItem(await request(`/runtimes/${encodeURIComponent(runtimeId)}`))),
    getRuntimeHealth: async (runtimeId: string): Promise<AgentRuntimeHealth> =>
      agentRuntimeHealthSchema.parse(unwrapItem(await request(`/runtimes/${encodeURIComponent(runtimeId)}/health`))),
    listRuntimeModels: async (runtimeId: string): Promise<AgentRuntimeModel[]> =>
      agentRuntimeModelSchema.array().parse(unwrapItems(await request(`/runtimes/${encodeURIComponent(runtimeId)}/models`))),
    getSupportDiagnostics: async (): Promise<AgentRuntimeSupportDiagnostics> =>
      agentRuntimeSupportDiagnosticsSchema.parse((await request("/support-diagnostics") as { diagnostics: unknown }).diagnostics),
    listSessions: async (listOptions: CanonicalSessionListOptions = {}): Promise<CanonicalAgentSession[]> => {
      const query = new URLSearchParams();
      if (typeof listOptions.start === "number") query.set("start", String(listOptions.start));
      if (listOptions.search?.trim()) query.set("search", listOptions.search.trim());
      if (typeof listOptions.limit === "number") query.set("limit", String(listOptions.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return canonicalAgentSessionSchema.array().parse(unwrapItems(await request(`/sessions${suffix}`)));
    },
    createSession: async (input: CreateCanonicalSessionInput): Promise<CanonicalAgentSession> =>
      canonicalAgentSessionSchema.parse(unwrapItem(await request("/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }))),
    getSession: async (sessionId: string): Promise<CanonicalAgentSession> =>
      canonicalAgentSessionSchema.parse(unwrapItem(await request(`/sessions/${encodeURIComponent(sessionId)}`))),
    updateSession: async (sessionId: string, input: { title: string }): Promise<CanonicalAgentSession> =>
      canonicalAgentSessionSchema.parse(unwrapItem(await request(`/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }))),
    deleteSession: async (sessionId: string): Promise<void> => {
      await request(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    },
    getSessionSnapshot: async (sessionId: string, snapshotOptions: { limit?: number } = {}): Promise<CanonicalSessionSnapshot> => {
      const query = typeof snapshotOptions.limit === "number" ? `?limit=${encodeURIComponent(snapshotOptions.limit)}` : "";
      return canonicalSessionSnapshotSchema.parse(unwrapItem(await request(`/sessions/${encodeURIComponent(sessionId)}/snapshot${query}`)));
    },
    previewContinuation: async (sessionId: string, targetRuntimeId: string): Promise<AgentContinuationPreview> =>
      agentContinuationPreviewSchema.parse((await request(`/sessions/${encodeURIComponent(sessionId)}/continuations/preview`, {
        method: "POST",
        body: JSON.stringify({ targetRuntimeId }),
      }) as { preview: unknown }).preview),
    continueSession: async (
      sessionId: string,
      targetRuntimeId: string,
      context: AgentContinuationContext,
    ): Promise<AgentContinuationResult> => agentContinuationResultSchema.parse((await request(
      `/sessions/${encodeURIComponent(sessionId)}/continuations`,
      { method: "POST", body: JSON.stringify({ targetRuntimeId, context }) },
    ) as { continuation: unknown }).continuation),
    listSessionLinks: async (sessionId: string): Promise<CanonicalSessionLink[]> => {
      const payload = unwrapItems(await request(`/sessions/${encodeURIComponent(sessionId)}/links`));
      return canonicalSessionLinkSchema.array().parse(payload);
    },
    forkSession: async (sessionId: string, input: { title?: string; upToMessageId?: string } = {}) => {
      const payload = await request(`/sessions/${encodeURIComponent(sessionId)}/fork`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!payload || typeof payload !== "object" || !("fork" in payload)) throw new Error("Invalid canonical fork response");
      const fork = (payload as { fork: Record<string, unknown> }).fork;
      return {
        session: canonicalAgentSessionSchema.parse(fork.session),
        link: canonicalSessionLinkSchema.parse(fork.link),
        filesystemState: fork.filesystemState as {
          sharedWorkingTree: true;
          checkpointHistoryCopied: false;
          filesRewound: false;
          warning: string;
        },
      };
    },
    listSessionEvents: async (sessionId: string, eventOptions: { after?: number; limit?: number } = {}): Promise<CanonicalAgentEvent[]> => {
      const query = new URLSearchParams();
      if (typeof eventOptions.after === "number") query.set("after", String(eventOptions.after));
      if (typeof eventOptions.limit === "number") query.set("limit", String(eventOptions.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return canonicalAgentEventSchema.array().parse(unwrapItems(await request(`/sessions/${encodeURIComponent(sessionId)}/events${suffix}`)));
    },
    getWorkspaceEventBatch: async (eventOptions: { cursorToken?: string } = {}): Promise<CanonicalWorkspaceEventBatch> => {
      const query = new URLSearchParams();
      query.set("stream", "false");
      if (eventOptions.cursorToken) query.set("cursor", eventOptions.cursorToken);
      return parseWorkspaceEventBatch(await request(`/events?${query.toString()}`));
    },
    listWorkspaceSnapshots: async (): Promise<CanonicalSessionSnapshot[]> =>
      canonicalSessionSnapshotSchema.array().parse(unwrapItems(await request("/snapshots"))),
    openWorkspaceEventStream: openEventStream,
    startRun: async (sessionId: string, input: StartCanonicalRunInput): Promise<StartCanonicalRunResult> =>
      parseStartRunResult(await request(`/sessions/${encodeURIComponent(sessionId)}/runs`, {
        method: "POST",
        body: JSON.stringify({
          origin: input.origin ?? "local-renderer",
          startCommandCorrelationId: input.startCommandCorrelationId ?? null,
          prompt: input.prompt,
          whenBusy: input.whenBusy ?? "reject",
          ...(input.confirmAmbiguousRetry ? { confirmAmbiguousRetry: true } : {}),
          ...(input.currentTurn ? { currentTurn: input.currentTurn } : {}),
        }),
      })),
    getActiveRun: async (sessionId: string): Promise<CanonicalRunHandle | null> =>
      parseActiveRun(await request(`/sessions/${encodeURIComponent(sessionId)}/runs/active`)),
    abortRun: async (sessionId: string, runId: string): Promise<unknown> =>
      request(`/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/abort`, {
        method: "POST",
        body: JSON.stringify({ abortCommandCorrelationId: null }),
      }),
    stopSubagent: async (sessionId: string, runId: string, taskId: string): Promise<unknown> =>
      request(`/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(taskId)}/stop`, {
        method: "POST",
        body: JSON.stringify({ runId, taskId }),
      }),
    resolveInteraction: async (
      sessionId: string,
      interactionId: string,
      resolution: CanonicalInteractionResolution,
    ): Promise<unknown> => request(
      `/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({
          origin: "local-renderer",
          commandCorrelationId: null,
          resolution: canonicalInteractionResolutionSchema.parse(resolution),
        }),
      },
    ),
  };
}

export type CanonicalAgentClient = ReturnType<typeof createCanonicalAgentClient>;

function parseWorkspaceEventBatch(value: unknown): CanonicalWorkspaceEventBatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid canonical event batch");
  const batch = value as Record<string, unknown>;
  if (batch.schemaVersion !== 1 || typeof batch.workspaceId !== "string" || typeof batch.cursorToken !== "string"
    || typeof batch.requiresSnapshot !== "boolean" || !Array.isArray(batch.events)
    || !batch.cursor || typeof batch.cursor !== "object" || Array.isArray(batch.cursor)) {
    throw new Error("Invalid canonical event batch");
  }
  return {
    schemaVersion: 1,
    workspaceId: batch.workspaceId,
    events: canonicalAgentEventSchema.array().parse(batch.events),
    cursor: Object.fromEntries(Object.entries(batch.cursor).map(([key, item]) => {
      if (!Number.isSafeInteger(item) || Number(item) < 0) throw new Error("Invalid canonical event cursor");
      return [key, Number(item)];
    })),
    cursorToken: batch.cursorToken,
    requiresSnapshot: batch.requiresSnapshot,
    snapshots: batch.snapshots === undefined ? undefined : canonicalSessionSnapshotSchema.array().parse(batch.snapshots),
  };
}

function parseRunHandle(value: unknown): CanonicalRunHandle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const run = value as Record<string, unknown>;
  if (typeof run.runId !== "string" || !run.runId.trim()) return null;
  return {
    runId: run.runId,
    ...(typeof run.status === "string" ? { status: run.status } : {}),
  };
}

function parseStartRunResult(value: unknown): StartCanonicalRunResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid canonical run response");
  const result = value as Record<string, unknown>;
  if (result.disposition !== "started" && result.disposition !== "enqueued") {
    throw new Error("Invalid canonical run disposition");
  }
  const run = parseRunHandle(result.run);
  if (result.disposition === "started" && !run) throw new Error("Canonical run response is missing a run");
  return {
    disposition: result.disposition,
    run,
    ...(typeof result.pendingOperationId === "string" ? { pendingOperationId: result.pendingOperationId } : {}),
    ...(typeof result.position === "number" ? { position: result.position } : {}),
  };
}

function parseActiveRun(value: unknown): CanonicalRunHandle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid canonical active run response");
  const payload = value as Record<string, unknown>;
  if (!("run" in payload)) throw new Error("Invalid canonical active run response");
  return parseRunHandle(payload.run);
}
