import { z } from "zod";

import { loopbackFetch } from "./server-fetch.js";

export const CLAUDE_WORKER_TOKEN_HEADER = "x-jugglework-worker-token";
export const CLAUDE_WORKER_PROTOCOL_VERSION = 1;

const healthSchema = z.object({
  protocolVersion: z.literal(CLAUDE_WORKER_PROTOCOL_VERSION),
  status: z.enum(["disabled", "unavailable", "starting", "healthy", "degraded", "failed", "stopping"]),
  checkedAt: z.string().datetime({ offset: true }),
  reasonCode: z.string().nullable(),
  message: z.string().nullable(),
}).strict();

const capabilitiesSchema = z.object({
  protocolVersion: z.literal(CLAUDE_WORKER_PROTOCOL_VERSION),
  sdkVersion: z.string().min(1),
  cliVersion: z.string().min(1),
  nodeVersion: z.string().min(1),
  transport: z.literal("loopback-http"),
  limits: z.object({
    maxHeaderBytes: z.number().int().positive(),
    maxRequestBytes: z.number().int().positive(),
    maxEventBytes: z.number().int().positive(),
    maxRetainedEvents: z.number().int().positive(),
  }).strict(),
  operations: z.object({
    health: z.literal(true),
    capabilities: z.literal(true),
    events: z.literal(true),
    shutdown: z.literal(true),
    run: z.boolean(),
    abort: z.boolean(),
    interactions: z.boolean(),
    configurationRefresh: z.boolean(),
    currentTurnConfiguration: z.boolean(),
    stopSubagent: z.boolean(),
    nativeFork: z.boolean(),
  }).strict(),
  advanced: z.object({
    subagentProjection: z.boolean(),
    subagentProgress: z.boolean(),
    subagentStop: z.boolean(),
    planMode: z.boolean(),
    fileCheckpointing: z.boolean(),
    rewind: z.boolean(),
    nativeFork: z.boolean(),
    partialFallback: z.literal(true),
    filesystemState: z.literal("shared-working-tree"),
    prewarm: z.boolean(),
    residentSession: z.boolean(),
    protocolInterrupt: z.boolean(),
    queuedInput: z.boolean(),
    steer: z.boolean(),
    dynamicModel: z.boolean(),
    dynamicEffort: z.boolean(),
    dynamicPermissionMode: z.boolean(),
  }).strict(),
  sandbox: z.object({
    supported: z.boolean(),
    enabled: z.boolean(),
    failClosed: z.literal(true),
    allowUnsandboxedCommands: z.literal(false),
    backend: z.enum(["seatbelt", "bubblewrap", "windows-sandbox", "unsupported"]),
    reasonCode: z.enum(["sandbox_supported", "sandbox_unsupported_host"]),
  }).strict(),
}).strict();

const shutdownSchema = z.object({
  accepted: z.literal(true),
  status: z.literal("stopping"),
}).strict();

const acceptedSchema = z.object({
  accepted: z.literal(true),
}).strict();

const mcpRefreshResponseSchema = z.object({
  accepted: z.literal(true),
  workspaceId: z.string().trim().min(1).max(256),
  revision: z.number().int().nonnegative(),
  added: z.array(z.string()),
  updated: z.array(z.string()),
  removed: z.array(z.string()),
}).strict();

const mcpDiagnosticsResponseSchema = z.object({
  workspaceId: z.string().trim().min(1).max(256),
  revision: z.number().int().nonnegative(),
  items: z.array(z.object({
    workspaceId: z.string(),
    serverName: z.string(),
    state: z.enum(["initializing", "pending", "connected", "failed", "needs_auth", "expired", "removed"]),
    code: z.string(),
    revision: z.number().int().nonnegative(),
    occurredAt: z.number().int().nonnegative(),
    retryable: z.boolean(),
  }).strict()),
}).strict();

export type ClaudeWorkerMcpConfiguration = {
  workspaceId: string;
  revision: number;
  generatedAt: number;
  servers: Record<string, {
    type: "http" | "sse";
    url: string;
    headers?: Record<string, string>;
    credentialExpiresAt?: number;
    timeoutMs?: number;
    alwaysLoad?: boolean;
  }>;
  internalTools?: {
    url: string;
    credential: string;
    actor: "claude-worker";
    schemaVersion: 1;
    credentialExpiresAt: number;
  };
};

const abortResponseSchema = z.object({
  accepted: z.literal(true),
  runId: z.string().trim().min(1).max(256),
  status: z.literal("aborting"),
}).strict();

const stopSubagentResponseSchema = z.object({
  accepted: z.literal(true),
  taskId: z.string().trim().min(1).max(256),
  status: z.literal("stopping"),
}).strict();

const resolvedInteractionSchema = z.object({
  accepted: z.literal(true),
  interactionId: z.string().trim().min(1).max(256),
}).strict();

const runResponseSchema = z.object({
  accepted: z.literal(true),
  runId: z.string().trim().min(1).max(256),
  status: z.literal("starting"),
}).strict();

const forkResponseSchema = z.object({
  accepted: z.literal(true),
  backendSessionId: z.string().uuid(),
  filesystemState: z.object({
    sharedWorkingTree: z.literal(true),
    checkpointHistoryCopied: z.literal(false),
    filesRewound: z.literal(false),
    warning: z.string().min(1).max(2_000),
  }).strict(),
}).strict();

const workerEventSchema = z.object({
  protocolVersion: z.literal(CLAUDE_WORKER_PROTOCOL_VERSION),
  sequence: z.number().int().positive(),
  id: z.string().trim().min(1).max(512),
  type: z.string().trim().min(1).max(128),
  createdAt: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type ClaudeWorkerHealth = z.infer<typeof healthSchema>;
export type ClaudeWorkerCapabilities = z.infer<typeof capabilitiesSchema>;
export type ClaudeWorkerEvent = z.infer<typeof workerEventSchema>;

export interface ClaudeWorkerRunRequest {
  workspaceId: string;
  sessionId: string;
  backendSessionId: string | null;
  runId: string;
  cwd: string;
  prompt: string;
  delivery: "start" | "enqueue" | "steer";
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: "default" | "acceptEdits" | "dontAsk";
  planMode?: boolean;
  limits?: {
    maxTurns: number;
    maxBudgetUsd: number;
    wallClockMs: number;
    hardCloseMs: number;
    approvalDeadlineMs: number;
  };
  permissionPolicy?:
    | { mode: "default" }
    | { mode: "headless"; action: "deny" | "preapproved" | "wait" };
}

export class ClaudeWorkerClientError extends Error {
  constructor(
    readonly code: "ownership_lost" | "request_failed" | "invalid_response" | "already_resolved" | "unsupported_capability",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeWorkerClientError";
  }
}

export class ClaudeWorkerClient {
  readonly url: string;
  readonly generation: number;

  private readonly token: string;
  private readonly assertOwnership?: () => void;
  private readonly requestTimeoutMs: number;

  constructor(options: {
    url: string;
    generationToken: string;
    generation: number;
    requestTimeoutMs?: number;
    assertOwnership?: () => void;
  }) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1")) {
      throw new ClaudeWorkerClientError("invalid_response", "Claude worker URL must use loopback HTTP");
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new ClaudeWorkerClientError("invalid_response", "Claude worker URL is not a transport origin");
    }
    this.url = url.origin;
    this.token = options.generationToken;
    this.generation = options.generation;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.assertOwnership = options.assertOwnership;
  }

  health(): Promise<ClaudeWorkerHealth> {
    return this.request("/v1/health", healthSchema);
  }

  capabilities(): Promise<ClaudeWorkerCapabilities> {
    return this.request("/v1/capabilities", capabilitiesSchema);
  }

  run(input: ClaudeWorkerRunRequest): Promise<z.infer<typeof runResponseSchema>> {
    return this.request("/v1/runs", runResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  abort(sessionId: string, runId: string): Promise<void> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/abort`, abortResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, runId }),
    }).then(() => undefined);
  }

  stopSubagent(sessionId: string, runId: string, taskId: string): Promise<void> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(taskId)}/stop`, stopSubagentResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, runId, taskId }),
    }).then(() => undefined);
  }

  forkSession(input: { sourceBackendSessionId: string; cwd: string; title?: string; upToMessageId?: string }) {
    return this.request("/v1/sessions/fork", forkResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  resolveInteraction(
    interactionId: string,
    sessionId: string,
    runId: string,
    resolution: Record<string, unknown>,
  ): Promise<void> {
    return this.request(`/v1/interactions/${encodeURIComponent(interactionId)}/resolve`, resolvedInteractionSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, runId, resolution }),
    }).then(() => undefined);
  }

  refreshConfiguration(configuration: ClaudeWorkerMcpConfiguration): Promise<z.infer<typeof mcpRefreshResponseSchema>> {
    return this.request("/v1/configuration/refresh", mcpRefreshResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configuration),
    });
  }

  mcpDiagnostics(workspaceId: string): Promise<z.infer<typeof mcpDiagnosticsResponseSchema>> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/mcp/diagnostics`, mcpDiagnosticsResponseSchema);
  }

  reconnectMcp(workspaceId: string, serverName: string): Promise<void> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(serverName)}/reconnect`, acceptedSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    }).then(() => undefined);
  }

  async *events(cursor = 0, signal?: AbortSignal): AsyncIterable<ClaudeWorkerEvent> {
    this.assertOwnership?.();
    let response: Response;
    try {
      response = await loopbackFetch(`${this.url}/v1/events?cursor=${cursor}`, {
        headers: {
          accept: "text/event-stream",
          [CLAUDE_WORKER_TOKEN_HEADER]: this.token,
        },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) return;
      throw new ClaudeWorkerClientError("request_failed", "Claude worker event stream failed", { cause: error });
    }
    if (!response.ok || !response.body) {
      throw new ClaudeWorkerClientError("request_failed", `Claude worker event stream failed with status ${response.status}`);
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (!signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          throw new ClaudeWorkerClientError("invalid_response", "Claude worker event frame exceeds the size limit");
        }
        let boundary = buffer.match(/\r?\n\r?\n/);
        while (boundary?.index !== undefined) {
          const frame = buffer.slice(0, boundary.index).replace(/\r/g, "");
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) {
            let payload: unknown;
            try {
              payload = JSON.parse(data);
            } catch (error) {
              throw new ClaudeWorkerClientError("invalid_response", "Claude worker returned malformed event JSON", { cause: error });
            }
            const parsed = workerEventSchema.safeParse(payload);
            if (!parsed.success) {
              throw new ClaudeWorkerClientError("invalid_response", "Claude worker returned an invalid event", {
                cause: parsed.error,
              });
            }
            yield parsed.data;
          }
          boundary = buffer.match(/\r?\n\r?\n/);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async shutdown(reason: string): Promise<void> {
    await this.request("/v1/shutdown", shutdownSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    this.assertOwnership?.();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Claude worker request timed out")), this.requestTimeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set(CLAUDE_WORKER_TOKEN_HEADER, this.token);
      const response = await loopbackFetch(`${this.url}${path}`, { ...init, headers, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        try {
          const payload = JSON.parse(text) as { error?: { code?: unknown } };
          if (payload.error?.code === "already_resolved") throw new ClaudeWorkerClientError("already_resolved", "Claude interaction is already resolved");
          if (payload.error?.code === "unsupported_capability") throw new ClaudeWorkerClientError("unsupported_capability", "Claude worker capability is unavailable");
        } catch (error) {
          if (error instanceof ClaudeWorkerClientError) throw error;
        }
        throw new ClaudeWorkerClientError("request_failed", `Claude worker request failed with status ${response.status}`);
      }
      if (Buffer.byteLength(text) > 1024 * 1024) {
        throw new ClaudeWorkerClientError("invalid_response", "Claude worker response exceeds the size limit");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new ClaudeWorkerClientError("invalid_response", "Claude worker returned malformed JSON", { cause: error });
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new ClaudeWorkerClientError("invalid_response", "Claude worker returned an invalid response", {
          cause: parsed.error,
        });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ClaudeWorkerClientError) throw error;
      throw new ClaudeWorkerClientError("request_failed", "Claude worker request failed", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
