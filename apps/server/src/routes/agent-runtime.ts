import { agentRuntimeCurrentTurnConfigurationSchema, canonicalInteractionResolutionSchema } from "@jugglework/types/agent-runtime";
import { z } from "zod";

import { AgentEngineError } from "../agent-engine/errors.js";
import type { AgentRuntimeControlPlane } from "../agent-runtime-control-plane.js";
import { AgentRuntimePersistenceError } from "../agent-runtime-persistence/repository.js";
import { ApiError } from "../errors.js";
import { InteractionResolutionError } from "../interaction-resolution-coordinator.js";
import { SessionMutationError } from "../session-mutation-coordinator.js";
import { AgentContinuationError } from "../agent-runtime-continuation.js";
import type { AgentRuntimeTelemetry } from "../agent-runtime-telemetry.js";
import { SessionPendingOperationError, type SessionPendingOperationStore } from "../session-pending-operations.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

const EVENT_STREAM_HEARTBEAT_MS = 15_000;
const EVENT_STREAM_MAX_INITIAL_BATCHES = 100;

interface RegisterAgentRuntimeRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  controlPlane: AgentRuntimeControlPlane;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  sessionPendingOperations: SessionPendingOperationStore;
  wakeSessionPendingOperations: () => Promise<void>;
  telemetry: AgentRuntimeTelemetry;
}

const idSchema = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const createSessionSchema = z.object({
  runtimeId: z.string().trim().min(1).max(128).optional(),
  title: z.string().trim().min(1).max(512),
  configuration: z.record(z.string().max(128), z.json()).optional(),
}).strict();
const runStartSchema = z.object({
  origin: z.enum(["local-renderer", "remote-control"]),
  startCommandCorrelationId: idSchema.nullable(),
  prompt: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 16 * 1024 * 1024),
  whenBusy: z.enum(["reject", "steer", "enqueue"]).default("reject"),
  confirmAmbiguousRetry: z.literal(true).optional(),
  currentTurn: agentRuntimeCurrentTurnConfigurationSchema.optional(),
}).strict();
const abortSchema = z.object({ abortCommandCorrelationId: idSchema.nullable() }).strict();
const cancelPendingSchema = z.object({ commandCorrelationId: idSchema }).strict();
const observationSchema = z.object({
  status: z.enum(["starting", "running", "waiting", "retrying", "aborting", "idle", "completed", "failed", "aborted"]),
}).strict();
const interactionSchema = z.object({
  origin: z.enum(["local-renderer", "remote-control"]),
  commandCorrelationId: idSchema.nullable(),
  resolution: canonicalInteractionResolutionSchema,
}).strict();
const continuationPreviewSchema = z.object({
  targetRuntimeId: z.string().trim().min(1).max(128),
}).strict();
const continuationConfirmSchema = z.object({
  targetRuntimeId: z.string().trim().min(1).max(128),
  context: z.object({
    summary: z.string().trim().min(1).max(8_000),
    transcript: z.array(z.object({
      sourceMessageId: idSchema.optional(),
      role: z.enum(["user", "assistant"]),
      text: z.string().trim().min(1).max(40_000),
    }).strict()).max(64),
  }).strict(),
}).strict();
const nativeForkSchema = z.object({
  title: z.string().trim().min(1).max(512).optional(),
  upToMessageId: idSchema.optional(),
}).strict();
const updateSessionSchema = z.object({ title: z.string().trim().min(1).max(512) }).strict();
const stopSubagentSchema = z.object({ runId: idSchema, taskId: idSchema }).strict();

export function registerAgentRuntimeRoutes(options: RegisterAgentRuntimeRoutesOptions): void {
  const prefix = "/workspace/:id/agent/v1";

  addRoute(options.routes, "GET", `${prefix}/runtimes`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    const availableOnly = parseBoolean(ctx.url.searchParams.get("availableOnly"), "availableOnly") ?? false;
    return options.jsonResponse({ schemaVersion: 1, runtimes: await options.controlPlane.listRuntimes(ctx.params.id, { availableOnly }) });
  }));

  addRoute(options.routes, "GET", `${prefix}/runtimes/:runtimeId`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    return options.jsonResponse({ runtime: await options.controlPlane.runtime(ctx.params.id, parseId(ctx.params.runtimeId, "runtimeId")) });
  }));

  addRoute(options.routes, "GET", `${prefix}/runtimes/:runtimeId/health`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    return options.jsonResponse({ health: await options.controlPlane.runtimeHealth(ctx.params.id, parseId(ctx.params.runtimeId, "runtimeId")) });
  }));

  addRoute(options.routes, "GET", `${prefix}/runtimes/:runtimeId/models`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    return options.jsonResponse({ items: await options.controlPlane.runtimeModels(ctx.params.id, parseId(ctx.params.runtimeId, "runtimeId")) });
  }));

  addRoute(options.routes, "GET", `${prefix}/support-diagnostics`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    options.telemetry.queueSnapshot(options.sessionPendingOperations.list());
    return options.jsonResponse({ diagnostics: options.telemetry.snapshot() });
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const body = parse(createSessionSchema, await options.readJsonBody(ctx.request), "Session payload is invalid");
    const session = await options.controlPlane.createSession({ workspaceId: ctx.params.id, ...body });
    return options.jsonResponse({ session }, 201);
  }));

  addRoute(options.routes, "GET", `${prefix}/sessions`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    return options.jsonResponse({ items: await options.controlPlane.listSessions(ctx.params.id) });
  }));

  addRoute(options.routes, "GET", `${prefix}/sessions/:sessionId`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    return options.jsonResponse({ session: await options.controlPlane.readSession(ctx.params.id, parseId(ctx.params.sessionId, "sessionId")) });
  }));

  addRoute(options.routes, "PATCH", `${prefix}/sessions/:sessionId`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const body = parse(updateSessionSchema, await options.readJsonBody(ctx.request), "Session update payload is invalid");
    return options.jsonResponse({ session: await options.controlPlane.updateSession(
      ctx.params.id,
      parseId(ctx.params.sessionId, "sessionId"),
      body,
    ) });
  }));

  addRoute(options.routes, "DELETE", `${prefix}/sessions/:sessionId`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    await options.controlPlane.deleteSession(ctx.params.id, parseId(ctx.params.sessionId, "sessionId"));
    return options.jsonResponse({ ok: true });
  }));

  addRoute(options.routes, "GET", `${prefix}/sessions/:sessionId/snapshot`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    const limit = parsePositiveInteger(ctx.url.searchParams.get("limit"), "limit");
    return options.jsonResponse({ snapshot: await options.controlPlane.snapshot(ctx.params.id, parseId(ctx.params.sessionId, "sessionId"), limit) });
  }));

  addRoute(options.routes, "GET", `${prefix}/sessions/:sessionId/links`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    return options.jsonResponse({ items: options.controlPlane.sessionLinks(ctx.params.id, parseId(ctx.params.sessionId, "sessionId")) });
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions/:sessionId/fork`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const body = parse(nativeForkSchema, await options.readJsonBody(ctx.request), "Native fork payload is invalid");
    const fork = await options.controlPlane.forkSession({
      workspaceId: ctx.params.id,
      sourceSessionId: parseId(ctx.params.sessionId, "sessionId"),
      ...body,
    });
    return options.jsonResponse({ fork }, 201);
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions/:sessionId/continuations/preview`, "client", handle(async (ctx) => {
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const body = parse(continuationPreviewSchema, await options.readJsonBody(ctx.request), "Continuation preview payload is invalid");
    const preview = await options.controlPlane.previewContinuation({
      workspaceId: ctx.params.id,
      sourceSessionId: parseId(ctx.params.sessionId, "sessionId"),
      targetRuntimeId: body.targetRuntimeId,
    });
    return options.jsonResponse({ preview });
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions/:sessionId/continuations`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const body = parse(continuationConfirmSchema, await options.readJsonBody(ctx.request), "Continuation payload is invalid");
    const continuation = await options.controlPlane.continueSession({
      workspaceId: ctx.params.id,
      sourceSessionId: parseId(ctx.params.sessionId, "sessionId"),
      targetRuntimeId: body.targetRuntimeId,
      context: body.context,
    });
    return options.jsonResponse({ continuation }, 201);
  }));

  addRoute(options.routes, "GET", `${prefix}/snapshots`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    return options.jsonResponse({ items: options.controlPlane.workspaceSnapshots(ctx.params.id) });
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions/:sessionId/runs`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const sessionId = parseId(ctx.params.sessionId, "sessionId");
    const body = parse(runStartSchema, await options.readJsonBody(ctx.request), "Run payload is invalid");
    const session = await options.controlPlane.readSession(ctx.params.id, sessionId);
    const interrupted = session.status.type === "interrupted";
    if (!interrupted && await options.controlPlane.sessionActivity(ctx.params.id, sessionId) === "busy") {
      if (body.origin === "remote-control" && body.whenBusy !== "reject") {
        if (body.currentTurn) {
          throw new ApiError(409, "current_turn_configuration_not_queued", "Current-turn controls cannot be deferred to a queued run");
        }
        const prompt = singleTextPrompt(body.prompt);
        if (!prompt || !body.startCommandCorrelationId) throw new ApiError(400, "invalid_payload", "Remote pending prompt is invalid");
        const pending = options.sessionPendingOperations.create({
          workspaceId: ctx.params.id,
          sessionId,
          mode: body.whenBusy,
          prompt,
          commandCorrelationId: body.startCommandCorrelationId,
        });
        options.telemetry.queueCreated();
        options.telemetry.queueSnapshot(options.sessionPendingOperations.list());
        const position = options.sessionPendingOperations.list(ctx.params.id, sessionId)
          .filter((item) => item.mode === body.whenBusy && item.state === "pending" && item.queueSequence <= pending.queueSequence).length;
        void options.wakeSessionPendingOperations();
        return options.jsonResponse({ disposition: "enqueued", pendingOperationId: pending.id, position }, 202);
      }
      throw new SessionMutationError("session_busy", null);
    }
    const run = await options.controlPlane.startRun({ workspaceId: ctx.params.id, sessionId, ...body });
    return options.jsonResponse({ disposition: "started", run }, 202);
  }));

  addRoute(options.routes, "GET", `${prefix}/sessions/:sessionId/runs/active`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    return options.jsonResponse({
      run: options.controlPlane.activeRun(ctx.params.id, parseId(ctx.params.sessionId, "sessionId")),
    });
  }));

  addRoute(options.routes, "GET", `${prefix}/runs/active`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    return options.jsonResponse({ items: options.controlPlane.activeRuns(ctx.params.id) });
  }));

  addRoute(options.routes, "GET", `${prefix}/sessions/:sessionId/pending`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    const sessionId = parseId(ctx.params.sessionId, "sessionId");
    await options.controlPlane.readSession(ctx.params.id, sessionId);
    const items = options.sessionPendingOperations.list(ctx.params.id, sessionId)
      .filter((item) => item.state === "pending")
      .map((item, index) => ({ id: item.id, mode: item.mode, position: index + 1, status: "pending" as const }));
    return options.jsonResponse({ items });
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions/:sessionId/pending/:pendingOperationId/cancel`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const sessionId = parseId(ctx.params.sessionId, "sessionId");
    await options.controlPlane.readSession(ctx.params.id, sessionId);
    const pendingOperationId = parseId(ctx.params.pendingOperationId, "pendingOperationId");
    const pending = options.sessionPendingOperations.get(pendingOperationId);
    if (!pending || pending.workspaceId !== ctx.params.id || pending.sessionId !== sessionId) {
      throw new ApiError(404, "pending_operation_not_found", "Pending operation not found");
    }
    const body = parse(cancelPendingSchema, await options.readJsonBody(ctx.request), "Pending cancellation payload is invalid");
    try {
      const result = options.sessionPendingOperations.cancel(pendingOperationId, body.commandCorrelationId);
      if (result.cancelled) options.telemetry.queueFinished("cancelled", Date.now() - pending.createdAt);
      options.telemetry.queueSnapshot(options.sessionPendingOperations.list());
      return options.jsonResponse({ pendingOperationId, status: result.cancelled ? "cancelled" : "already_cancelled" });
    } catch (error) {
      if (error instanceof SessionPendingOperationError && error.code === "not_cancellable") {
        return options.jsonResponse({ pendingOperationId, status: "not_cancellable" });
      }
      throw error;
    }
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions/:sessionId/runs/:runId/abort`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const body = parse(abortSchema, await options.readJsonBody(ctx.request), "Abort payload is invalid");
    const run = await options.controlPlane.abortRun({
      workspaceId: ctx.params.id,
      sessionId: parseId(ctx.params.sessionId, "sessionId"),
      runId: parseId(ctx.params.runId, "runId"),
      ...body,
    });
    return options.jsonResponse({ run, abortRequested: true }, 202);
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions/:sessionId/runs/:runId/subagents/:taskId/stop`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const body = parse(stopSubagentSchema, await options.readJsonBody(ctx.request), "Subagent stop payload is invalid");
    const runId = parseId(ctx.params.runId, "runId");
    const taskId = parseId(ctx.params.taskId, "taskId");
    if (body.runId !== runId || body.taskId !== taskId) throw new ApiError(400, "invalid_payload", "Subagent identifiers do not match the route");
    await options.controlPlane.stopSubagent({
      workspaceId: ctx.params.id,
      sessionId: parseId(ctx.params.sessionId, "sessionId"),
      runId,
      taskId,
    });
    return options.jsonResponse({ accepted: true, taskId, status: "stopping" }, 202);
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions/:sessionId/runs/:runId/observations`, "client", handle(async (ctx) => {
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const body = parse(observationSchema, await options.readJsonBody(ctx.request), "Observation payload is invalid");
    const observation = options.controlPlane.observeRun({
      workspaceId: ctx.params.id,
      sessionId: parseId(ctx.params.sessionId, "sessionId"),
      runId: parseId(ctx.params.runId, "runId"),
      ...body,
    });
    if (observation.cleared) void options.wakeSessionPendingOperations();
    return options.jsonResponse(observation);
  }));

  addRoute(options.routes, "POST", `${prefix}/sessions/:sessionId/interactions/:interactionId/resolve`, "client", handle(async (ctx) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(options.config, ctx.params.id);
    const body = parse(interactionSchema, await options.readJsonBody(ctx.request), "Interaction resolution is invalid");
    const interaction = await options.controlPlane.resolveInteraction({
      workspaceId: ctx.params.id,
      sessionId: parseId(ctx.params.sessionId, "sessionId"),
      interactionId: parseId(ctx.params.interactionId, "interactionId"),
      ...body,
    });
    return options.jsonResponse({ interaction, status: "resolved" });
  }));

  addRoute(options.routes, "GET", `${prefix}/events`, "client", handle(async (ctx) => {
    await options.resolveWorkspace(options.config, ctx.params.id);
    const cursor = parseCursor(ctx.url.searchParams.get("cursor") ?? ctx.request.headers.get("last-event-id"));
    const stream = parseBoolean(ctx.url.searchParams.get("stream"), "stream") ?? true;
    if (!stream) return options.jsonResponse(eventBatch(options.controlPlane, ctx.params.id, cursor));
    await options.controlPlane.startWorkspaceEvents(ctx.params.id);
    return eventStream(options.controlPlane, ctx.params.id, cursor, ctx.request.signal);
  }));
}

function handle(handler: (ctx: RequestContext) => Promise<Response>): (ctx: RequestContext) => Promise<Response> {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      remapError(error);
    }
  };
}

function remapError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof SessionMutationError) {
    throw new ApiError(409, error.code, error.code === "session_busy" ? "The session already has an active run" : "The run does not match", {
      currentRunId: error.currentRunId,
    });
  }
  if (error instanceof InteractionResolutionError) {
    const status = error.code === "already_resolved" ? 409 : error.code === "interaction_expired" ? 410 : 404;
    throw new ApiError(status, error.code, error.code === "already_resolved" ? "The interaction is already resolved" : "The interaction is unavailable");
  }
  if (error instanceof AgentRuntimePersistenceError) {
    const status = error.code === "not_found" ? 404 : error.code === "binding_conflict" ? 409 : error.code === "payload_too_large" ? 413 : 400;
    throw new ApiError(status, `agent_${error.code}`, error.message);
  }
  if (error instanceof AgentContinuationError) {
    const status = error.code === "source_busy" || error.code === "same_runtime" ? 409
      : error.code === "context_too_large" ? 413 : 422;
    throw new ApiError(status, `agent_continuation_${error.code}`, error.message);
  }
  if (error instanceof AgentEngineError) {
    const status = error.code === "runtime_not_found" ? 404
      : error.code === "runtime_unavailable" ? 503
        : error.code === "runtime_retry_confirmation_required" ? 409
        : error.code === "runtime_capability_unsupported" ? 422
          : error.code === "runtime_configuration_invalid" ? 422
          : error.code === "runtime_session_mismatch" ? 409 : 502;
    throw new ApiError(status, error.code, error.message, error.details);
  }
  throw error;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", message);
  return parsed.data;
}

function parseId(value: string | undefined, field: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", `${field} is invalid`);
  return parsed.data;
}

function parseBoolean(value: string | null, field: string): boolean | undefined {
  if (value === null || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiError(400, "invalid_query", `${field} must be true or false`);
}

function parsePositiveInteger(value: string | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ApiError(400, "invalid_query", `${field} must be a positive integer`);
  return parsed;
}

function singleTextPrompt(prompt: Record<string, unknown>): string | null {
  const parts = Array.isArray(prompt.parts) ? prompt.parts : [];
  const part = parts.length === 1 && typeof parts[0] === "object" && parts[0] !== null ? parts[0] as Record<string, unknown> : null;
  return part?.type === "text" && typeof part.text === "string" && part.text.trim() ? part.text : null;
}

function parseCursor(value: string | null): Record<string, number> {
  if (!value) return {};
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error();
    const cursor: Record<string, number> = {};
    for (const [sessionId, sequence] of Object.entries(decoded)) {
      if (!idSchema.safeParse(sessionId).success || !Number.isSafeInteger(sequence) || Number(sequence) < 0) throw new Error();
      cursor[sessionId] = Number(sequence);
    }
    return cursor;
  } catch {
    throw new ApiError(400, "invalid_cursor", "Event cursor is invalid");
  }
}

function encodeCursor(cursor: Record<string, number>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function eventBatch(controlPlane: AgentRuntimeControlPlane, workspaceId: string, requested: Record<string, number>) {
  const current = controlPlane.workspaceCursor(workspaceId);
  const hasCursor = Object.keys(requested).length > 0;
  const stale = hasCursor && !controlPlane.canResumeWorkspaceCursor(workspaceId, requested);
  const events = stale || !hasCursor ? [] : controlPlane.workspaceEvents(workspaceId, requested);
  const cursor = stale || !hasCursor ? { ...current } : { ...requested };
  for (const event of events) cursor[event.sessionId] = event.sequence;
  return {
    schemaVersion: 1,
    workspaceId,
    events,
    cursor,
    cursorToken: encodeCursor(cursor),
    requiresSnapshot: stale,
    ...(stale || !hasCursor ? { snapshots: controlPlane.workspaceSnapshots(workspaceId) } : {}),
  };
}

function eventStream(
  controlPlane: AgentRuntimeControlPlane,
  workspaceId: string,
  requested: Record<string, number>,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const cursor = { ...requested };
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let replaying = true;
      const pending: Array<ReturnType<AgentRuntimeControlPlane["workspaceEvents"]>[number]> = [];
      const send = (event: string, data: unknown, id?: string) => {
        controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      unsubscribe = controlPlane.onWorkspaceEvent(workspaceId, (event) => {
        if (replaying) {
          pending.push(event);
          return;
        }
        if (event.sequence <= (cursor[event.sessionId] ?? 0)) return;
        cursor[event.sessionId] = event.sequence;
        send("event", event, encodeCursor(cursor));
      });
      let initial = eventBatch(controlPlane, workspaceId, requested);
      if (initial.requiresSnapshot || Object.keys(requested).length === 0) {
        Object.assign(cursor, initial.cursor);
        send("snapshot", initial);
      }
      for (let batch = 0; batch < EVENT_STREAM_MAX_INITIAL_BATCHES; batch += 1) {
        for (const event of initial.events) {
          if (event.sequence <= (cursor[event.sessionId] ?? 0)) continue;
          cursor[event.sessionId] = event.sequence;
          send("event", event, encodeCursor(cursor));
        }
        if (initial.requiresSnapshot || initial.events.length < 2_000) break;
        initial = eventBatch(controlPlane, workspaceId, cursor);
      }
      replaying = false;
      for (const event of pending.sort((left, right) => left.occurredAt - right.occurredAt || left.sequence - right.sequence)) {
        if (event.sequence <= (cursor[event.sessionId] ?? 0)) continue;
        cursor[event.sessionId] = event.sequence;
        send("event", event, encodeCursor(cursor));
      }
      heartbeat = setInterval(() => send("heartbeat", { cursor, cursorToken: encodeCursor(cursor) }), EVENT_STREAM_HEARTBEAT_MS);
      const close = () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch {}
      };
      if (signal.aborted) close();
      else signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
