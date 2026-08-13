import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  SessionMutationError,
  type SessionMutationCoordinator,
  type SessionMutationObservationStatus,
  type SessionMutationOrigin,
} from "../session-mutation-coordinator.js";
import { buildSession, buildSessionList, buildSessionMessages, buildSessionSnapshot } from "../session-read-model.js";
import { buildRuntimeSessionSnapshot } from "../session-read-model.js";
import { runtimeDbPath } from "../runtime-db.js";
import { RuntimeSessionStore, RuntimeSessionStoreError } from "../runtime-session-store.js";
import { runtimeEventSchema } from "@jugglework/types/agent-runtime";
import { runtimeSessionRecordSchema } from "@jugglework/types/runtime-session";
import {
  createSessionGroupId,
  normalizeSessionGroupState,
  readSessionGroupState,
  SessionGroupEventStore,
  updateSessionGroupState,
  type SessionGroupDefinition,
  type SessionGroupState,
} from "../session-groups.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { SessionPendingOperationError, type SessionPendingOperationStore } from "../session-pending-operations.js";
import type { SessionPendingOperationPump } from "../session-pending-operation-pump.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ParseOptionalBoolean = (value: string | null, name: string) => boolean | undefined;
type ParseOptionalPositiveInteger = (value: string | null, name: string) => number | undefined;
type ParseOptionalNonNegativeInteger = (value: string | null, name: string) => number | undefined;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;
type OpencodeClientResult<T, E> =
  | { data: T | undefined; error: undefined; response: Response }
  | { data: undefined; error: E; response: Response };
type UnwrapOpencodeResult = <T, E>(result: OpencodeClientResult<T, E>, path: string) => NonNullable<T>;

interface RegisterSessionRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  parseOptionalBoolean: ParseOptionalBoolean;
  parseOptionalPositiveInteger: ParseOptionalPositiveInteger;
  parseOptionalNonNegativeInteger: ParseOptionalNonNegativeInteger;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  unwrapOpencodeResult: UnwrapOpencodeResult;
  dispatchSessionPromptAsync: (
    config: ServerConfig,
    workspace: WorkspaceInfo,
    sessionId: string,
    prompt: Record<string, unknown>,
  ) => Promise<void>;
  dispatchSessionAbort: (config: ServerConfig, workspace: WorkspaceInfo, sessionId: string) => Promise<boolean>;
  sessionMutations: SessionMutationCoordinator;
  sessionPendingOperations: SessionPendingOperationStore;
  sessionPendingOperationPump: SessionPendingOperationPump;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionCreateTitleScalarCount(value: string): number | null {
  if (/\p{Cc}/u.test(value)) return null;
  let count = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    count += 1;
  }
  return count;
}

function parseSessionCreateTitle(value: unknown): string {
  if (typeof value !== "string" || sessionCreateTitleScalarCount(value) === null) {
    throw new ApiError(400, "invalid_payload", "title contains invalid Unicode characters");
  }
  const title = value.trim();
  const scalarCount = sessionCreateTitleScalarCount(title);
  if (scalarCount === null || scalarCount < 1 || scalarCount > 120) {
    throw new ApiError(400, "invalid_payload", "title must contain 1 to 120 Unicode scalar values");
  }
  return title;
}

const runIdentifierSchema = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const promptBodySchema = z.object({
  messageID: runIdentifierSchema.optional(),
  model: z.object({ providerID: runIdentifierSchema, modelID: runIdentifierSchema }).strict().optional(),
  agent: runIdentifierSchema.optional(),
  noReply: z.boolean().optional(),
  tools: z.record(runIdentifierSchema, z.boolean()).refine((value) => Object.keys(value).length <= 1_000).optional(),
  format: z.union([
    z.object({ type: z.literal("text") }).strict(),
    z.object({ type: z.literal("json_schema"), schema: z.record(z.string(), z.unknown()), retryCount: z.number().int().nonnegative().optional() }).strict(),
  ]).optional(),
  system: z.string().max(200_000).optional(),
  variant: z.string().max(256).optional(),
  parts: z.array(z.json()).max(10_000).optional(),
  reasoning_effort: z.string().max(256).optional(),
}).strict().refine((value) => JSON.stringify(value).length <= 16 * 1024 * 1024, "prompt payload is too large");
const remotePromptBodySchema = z.object({
  parts: z.tuple([z.object({
    type: z.literal("text"),
    text: z.string().min(1)
      .refine((value) => value.trim().length > 0)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 200_000),
  }).strict()]),
}).strict();
const startRunBodySchema = z.discriminatedUnion("origin", [
  z.object({
    origin: z.literal("local-renderer"),
    startCommandCorrelationId: runIdentifierSchema.nullable(),
    prompt: promptBodySchema,
  }).strict(),
  z.object({
    origin: z.literal("remote-control"),
    startCommandCorrelationId: runIdentifierSchema.nullable(),
    prompt: remotePromptBodySchema,
    whenBusy: z.enum(["reject", "steer", "enqueue"]).default("reject"),
  }).strict(),
]);
const legacyStartRunBodySchema = z.discriminatedUnion("origin", [
  z.object({ origin: z.literal("local"), commandId: runIdentifierSchema, prompt: promptBodySchema }).strict(),
  z.object({ origin: z.literal("remote"), commandId: runIdentifierSchema, prompt: remotePromptBodySchema }).strict(),
]);
const abortRunBodySchema = z.object({ abortCommandCorrelationId: runIdentifierSchema.nullable() }).strict();
const cancelPendingBodySchema = z.object({ commandCorrelationId: runIdentifierSchema }).strict();
const legacyAbortRunBodySchema = z.object({ expectedRunId: runIdentifierSchema, commandId: runIdentifierSchema }).strict();
const observeRunBodySchema = z.object({
  status: z.enum(["starting", "running", "waiting", "retrying", "aborting", "idle", "completed", "failed", "aborted"]),
}).strict();
const legacyObserveRunBodySchema = z.object({
  expectedRunId: runIdentifierSchema,
  observation: z.enum(["idle", "error", "completed", "failed", "aborted"]),
}).strict();
const opencodeTargetSessionStatusSchema = z.object({
  type: z.enum(["idle", "busy", "running", "retry", "retrying", "waiting"]),
}).passthrough();

function parseRunBody<T>(schema: z.ZodType<T>, body: Record<string, unknown>): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Session run payload is invalid");
  return parsed.data;
}

function parseRunIdentifier(value: unknown, field: string): string {
  const parsed = runIdentifierSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", `${field} is invalid`);
  return parsed.data;
}

function remapSessionMutationError(error: unknown): never {
  if (error instanceof SessionMutationError) {
    const message = error.code === "session_busy"
      ? "The session already has an active run"
      : "The expected run does not match the active run";
    throw new ApiError(409, error.code, message, { currentRunId: error.currentRunId });
  }
  throw error;
}

export function registerSessionRoutes(options: RegisterSessionRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    parseOptionalBoolean,
    parseOptionalPositiveInteger,
    parseOptionalNonNegativeInteger,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    resolveWorkspaceWithoutBootstrap,
    createWorkspaceOpencodeClient,
    unwrapOpencodeResult,
    dispatchSessionPromptAsync,
    dispatchSessionAbort,
    sessionMutations,
    sessionPendingOperations,
    sessionPendingOperationPump,
  } = options;
  const sessionGroupEvents = new SessionGroupEventStore();

  async function withRuntimeSessionStore<T>(action: (store: RuntimeSessionStore) => Promise<T> | T): Promise<T> {
    const store = await RuntimeSessionStore.open(runtimeDbPath(config));
    try { return await action(store); } finally { store.close(); }
  }

  function remapRuntimeStoreError(error: unknown): never {
    if (error instanceof RuntimeSessionStoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "scope_mismatch" ? 403 : 409;
      throw new ApiError(status, `runtime_session_${error.code}`, "Runtime session request failed");
    }
    throw error;
  }

  function remapSessionReadError(error: unknown): never {
    if (error instanceof ApiError && error.code === "opencode_request_failed") {
      const details = error.details;
      const upstreamStatus =
        isRecord(details) && "status" in details ? Number(details.status) : NaN;
      if (upstreamStatus === 400) {
        throw new ApiError(400, "invalid_query", "OpenCode rejected the session read request", details);
      }
      if (upstreamStatus === 404) {
        throw new ApiError(404, "session_not_found", "Session not found", details);
      }
    }
    throw error;
  }

  async function listWorkspaceSessions(
    workspace: WorkspaceInfo,
    input: { roots?: boolean; start?: number; search?: string; limit?: number },
  ) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      return buildSessionList(
        unwrapOpencodeResult(
          await opencode.session.list({
            roots: input.roots,
            start: input.start,
            search: input.search,
            limit: input.limit,
          }),
          "/session",
        ),
      );
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function createWorkspaceSession(
    workspace: WorkspaceInfo,
    input: { title: string; prompt?: string },
  ) {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    const session = buildSession(
      unwrapOpencodeResult(
        await opencode.session.create({ title: input.title }),
        "/session",
      ),
    );

    if (input.prompt) {
      const result = await opencode.session.promptAsync({
        sessionID: session.id,
        parts: [{ type: "text", text: input.prompt }],
      });
      if (result.error !== undefined) {
        throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
          status: result.response.status,
          body: result.error,
          path: `/session/${encodeURIComponent(session.id)}/prompt_async`,
        });
      }
    }

    return { item: session, started: Boolean(input.prompt) };
  }

  async function readWorkspaceSession(workspace: WorkspaceInfo, sessionId: string) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      return buildSession(
        unwrapOpencodeResult(
          await opencode.session.get({ sessionID: sessionId }),
          `/session/${encodeURIComponent(sessionId)}`,
        ),
      );
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function readWorkspaceSessionMessages(
    workspace: WorkspaceInfo,
    sessionId: string,
    input: { limit?: number },
  ) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      return buildSessionMessages(
        unwrapOpencodeResult(
          await opencode.session.messages({ sessionID: sessionId, limit: input.limit }),
          `/session/${encodeURIComponent(sessionId)}/message`,
        ),
      );
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function readWorkspaceSessionSnapshot(
    workspace: WorkspaceInfo,
    sessionId: string,
    input: { limit?: number },
  ) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      const [session, messages, todos, statuses] = await Promise.all([
        opencode.session
          .get({ sessionID: sessionId })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}`)),
        opencode.session
          .messages({ sessionID: sessionId, limit: input.limit })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}/message`)),
        opencode.session
          .todo({ sessionID: sessionId })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}/todo`)),
        opencode.session.status().then((result) => unwrapOpencodeResult(result, "/session/status")),
      ]);
      return buildSessionSnapshot({ session, messages, todos, statuses });
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function updateWorkspaceSessionGroups(
    workspaceId: string,
    updater: (current: SessionGroupState) => SessionGroupState,
  ) {
    return updateSessionGroupState(config, workspaceId, updater);
  }

  function requireStringField(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, "invalid_payload", `${field} is required`);
    }
    return value.trim();
  }

  function optionalStringField(body: Record<string, unknown>, field: string): string | undefined {
    const value = body[field];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, "invalid_payload", `${field} must be a non-empty string`);
    }
    return value.trim();
  }

  // Host-only ledger surface. The browser/client credential can read the
  // regular session projection but cannot assert an organization or append
  // backend events; Electron Main is the trust boundary for runtime IPC.
  addRoute(routes, "PUT", "/workspace/:id/runtime-session/:sessionId", "host-token", async (ctx) => {
    ensureWritable(config);
    await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const parsed = runtimeSessionRecordSchema.safeParse(body.record);
    if (!parsed.success || parsed.data.id !== ctx.params.sessionId || parsed.data.workspaceId !== ctx.params.id) {
      throw new ApiError(400, "invalid_payload", "Runtime session record is invalid");
    }
    try {
      const record = await withRuntimeSessionStore((store) => store.putSession(parsed.data));
      return jsonResponse({ record });
    } catch (error) { remapRuntimeStoreError(error); }
  });

  addRoute(routes, "POST", "/workspace/:id/runtime-session/:sessionId/event", "host-token", async (ctx) => {
    ensureWritable(config);
    await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const orgId = parseRunIdentifier(body.orgId, "orgId");
    const backendEventId = parseRunIdentifier(body.backendEventId, "backendEventId");
    const parsed = runtimeEventSchema.safeParse(body.event);
    if (!parsed.success) throw new ApiError(400, "invalid_payload", "Runtime event is invalid");
    try {
      const result = await withRuntimeSessionStore((store) => store.appendEvent(
        { orgId, workspaceId: ctx.params.id, sessionId: ctx.params.sessionId }, backendEventId, parsed.data,
      ));
      return jsonResponse({ inserted: result.inserted });
    } catch (error) { remapRuntimeStoreError(error); }
  });

  addRoute(routes, "POST", "/workspace/:id/runtime-session/:sessionId/backend-thread", "host-token", async (ctx) => {
    ensureWritable(config);
    await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const orgId = parseRunIdentifier(body.orgId, "orgId");
    const runtimeKind = body.runtimeKind === "opencode" || body.runtimeKind === "codex" ? body.runtimeKind : null;
    if (!runtimeKind) throw new ApiError(400, "invalid_payload", "runtimeKind is invalid");
    const backendThreadId = parseRunIdentifier(body.backendThreadId, "backendThreadId");
    try {
      const record = await withRuntimeSessionStore((store) => store.bindBackendThread(
        { orgId, workspaceId: ctx.params.id, sessionId: ctx.params.sessionId },
        { runtimeKind, backendThreadId, updatedAt: Date.now() },
      ));
      return jsonResponse({ record });
    } catch (error) { remapRuntimeStoreError(error); }
  });

  addRoute(routes, "POST", "/workspace/:id/runtime-session/:sessionId/archive", "host-token", async (ctx) => {
    ensureWritable(config);
    await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const orgId = parseRunIdentifier(body.orgId, "orgId");
    const archivedAt = body.archived === false ? null : Date.now();
    try {
      const record = await withRuntimeSessionStore((store) => store.archiveSession(
        { orgId, workspaceId: ctx.params.id, sessionId: ctx.params.sessionId }, archivedAt,
      ));
      return jsonResponse({ record });
    } catch (error) { remapRuntimeStoreError(error); }
  });

  addRoute(routes, "POST", "/workspace/:id/runtime-session/:sessionId/snapshot", "host-token", async (ctx) => {
    await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const orgId = parseRunIdentifier(body.orgId, "orgId");
    try {
      const snapshot = await withRuntimeSessionStore((store) => {
        const scope = { orgId, workspaceId: ctx.params.id, sessionId: ctx.params.sessionId };
        return buildRuntimeSessionSnapshot({ record: store.getSession(scope), events: store.readEvents(scope) });
      });
      return jsonResponse(snapshot);
    } catch (error) { remapRuntimeStoreError(error); }
  });

  addRoute(routes, "POST", "/workspace/:id/runtime-sessions/query", "host-token", async (ctx) => {
    await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const orgId = parseRunIdentifier(body.orgId, "orgId");
    const search = typeof body.search === "string" ? body.search.slice(0, 512) : "";
    const includeArchived = body.includeArchived === true;
    const limit = typeof body.limit === "number" && Number.isSafeInteger(body.limit) ? body.limit : 100;
    const records = await withRuntimeSessionStore((store) => store.searchSessions({
      orgId, workspaceId: ctx.params.id, search, includeArchived, limit,
    }));
    return jsonResponse({ records });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const title = parseSessionCreateTitle(body.title);
    const prompt = optionalStringField(body, "prompt");
    if (prompt && prompt.length > 100_000) {
      throw new ApiError(400, "invalid_payload", "prompt must be 100000 characters or fewer");
    }
    const result = await createWorkspaceSession(workspace, { title, ...(prompt ? { prompt } : {}) });
    return jsonResponse(result, 201);
  });

  addRoute(routes, "GET", "/workspace/:id/sessions", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listWorkspaceSessions(workspace, {
      roots: parseOptionalBoolean(ctx.url.searchParams.get("roots"), "roots"),
      start: parseOptionalNonNegativeInteger(ctx.url.searchParams.get("start"), "start"),
      search: ctx.url.searchParams.get("search")?.trim() || undefined,
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/session-groups", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const result = await readSessionGroupState(config, workspace.id);
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PUT", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const state = normalizeSessionGroupState(body.state);
    const result = await updateWorkspaceSessionGroups(workspace.id, () => state);
    sessionGroupEvents.record(workspace.id, "imported");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const label = requireStringField(body, "label").slice(0, 120);
    const requestedId = typeof body.id === "string" ? body.id.trim().slice(0, 128) : "";
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const existingIds = new Set(current.groups.map((group) => group.id));
      const id = requestedId && !existingIds.has(requestedId) ? requestedId : createSessionGroupId();
      return { ...current, groups: [...current.groups, { id, label }] };
    });
    const groupId = result.state.groups[result.state.groups.length - 1]?.id;
    sessionGroupEvents.record(workspace.id, "created", groupId ? { groupId } : undefined);
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/reorder", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const requestedIds = Array.isArray(body.groupIds)
      ? body.groupIds.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const byId = new Map(current.groups.map((group) => [group.id, group]));
      const used = new Set<string>();
      const groups: SessionGroupDefinition[] = [];
      for (const id of requestedIds) {
        const group = byId.get(id);
        if (!group || used.has(id)) continue;
        groups.push(group);
        used.add(id);
      }
      for (const group of current.groups) {
        if (!used.has(group.id)) groups.push(group);
      }
      return { ...current, groups };
    });
    sessionGroupEvents.record(workspace.id, "reordered");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/assignments/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) throw new ApiError(400, "invalid_payload", "sessionId is required");
    const body = await readJsonBody(ctx.request);
    const groupId = typeof body.groupId === "string" && body.groupId.trim() ? body.groupId.trim() : null;
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const assignments = { ...current.assignments };
      if (groupId && current.groups.some((group) => group.id === groupId)) {
        assignments[sessionId] = groupId;
      } else {
        delete assignments[sessionId];
      }
      return { ...current, assignments };
    });
    sessionGroupEvents.record(workspace.id, "assigned", { sessionId, ...(groupId ? { groupId } : {}) });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const groupId = (ctx.params.groupId ?? "").trim();
    if (!groupId) throw new ApiError(400, "invalid_payload", "groupId is required");
    const body = await readJsonBody(ctx.request);
    const label = requireStringField(body, "label").slice(0, 120);
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId ? { ...group, label } : group),
    }));
    sessionGroupEvents.record(workspace.id, "updated", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "DELETE", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const groupId = (ctx.params.groupId ?? "").trim();
    if (!groupId) throw new ApiError(400, "invalid_payload", "groupId is required");
    const requestedDestinationGroupId = ctx.url.searchParams.get("destinationGroupId")?.trim() || null;
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const destinationGroupId = requestedDestinationGroupId && current.groups.some(
        (group) => group.id === requestedDestinationGroupId && group.id !== groupId,
      ) ? requestedDestinationGroupId : null;
      const assignments: Record<string, string> = {};
      for (const [sessionId, assignedGroupId] of Object.entries(current.assignments)) {
        if (assignedGroupId !== groupId) {
          assignments[sessionId] = assignedGroupId;
        } else if (destinationGroupId) {
          assignments[sessionId] = destinationGroupId;
        }
      }
      return {
        groups: current.groups.filter((group) => group.id !== groupId),
        assignments,
      };
    });
    sessionGroupEvents.record(workspace.id, "deleted", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "GET", "/workspace/:id/session-groups/events", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const sinceRaw = ctx.url.searchParams.get("since");
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const items = sessionGroupEvents.list(workspace.id, since);
    return jsonResponse({ items, cursor: sessionGroupEvents.cursor(workspace.id), workspaceId: workspace.id });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const item = await readWorkspaceSession(workspace, sessionId);
    return jsonResponse({ item });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/messages", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const items = await readWorkspaceSessionMessages(workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/snapshot", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const item = await readWorkspaceSessionSnapshot(workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ item });
  });

  async function startSessionRun(
    ctx: RequestContext,
    input: {
      sessionId: string;
      origin: SessionMutationOrigin;
      startCommandCorrelationId: string | null;
      prompt: Record<string, unknown>;
      whenBusy?: "reject" | "steer" | "enqueue";
    },
  ) {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    let run;
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      const statuses = unwrapOpencodeResult(await opencode.session.status(), "/session/status");
      if (!isRecord(statuses)) {
        throw new ApiError(502, "opencode_invalid_response", "OpenCode returned invalid session status");
      }
      const targetStatus = Object.prototype.hasOwnProperty.call(statuses, input.sessionId)
        ? statuses[input.sessionId]
        : undefined;
      if (targetStatus !== undefined) {
        const parsedStatus = opencodeTargetSessionStatusSchema.safeParse(targetStatus);
        if (!parsedStatus.success) {
          throw new ApiError(502, "opencode_invalid_response", "OpenCode returned invalid session status");
        }
        if (parsedStatus.data.type !== "idle") {
          if (input.origin === "remote-control" && input.whenBusy && input.whenBusy !== "reject") {
            const text = isRecord(input.prompt) && Array.isArray(input.prompt.parts) && input.prompt.parts.length === 1 &&
              isRecord(input.prompt.parts[0]) && input.prompt.parts[0].type === "text" && typeof input.prompt.parts[0].text === "string"
              ? input.prompt.parts[0].text : null;
            if (!text || !input.startCommandCorrelationId) throw new ApiError(400, "invalid_payload", "Remote pending prompt is invalid");
            const pending = sessionPendingOperations.create({
              workspaceId: workspace.id,
              sessionId: input.sessionId,
              mode: input.whenBusy,
              prompt: text,
              commandCorrelationId: input.startCommandCorrelationId,
            });
            if (input.whenBusy === "enqueue") {
              const position = sessionPendingOperations.list(workspace.id, input.sessionId)
                .filter((item) => item.mode === "enqueue" && item.state === "pending" && item.queueSequence <= pending.queueSequence).length;
              return jsonResponse({ disposition: "enqueued", pendingOperationId: pending.id, position }, 202);
            }
            // Return the durable ID while it is still pending/cancellable. The
            // lifecycle pump claims and submits it asynchronously as steer.
            void sessionPendingOperationPump.wake();
            return jsonResponse({ disposition: "enqueued", pendingOperationId: pending.id, position: 1 }, 202);
          }
          throw new SessionMutationError(
            "session_busy",
            sessionMutations.getActive(workspace.id, input.sessionId)?.runId ?? null,
          );
        }
      }

      // Every contender reads authoritative engine state first. This synchronous
      // reservation then decides which idle local/remote start may dispatch.
      run = sessionMutations.reserveStart({
        workspaceId: workspace.id,
        sessionId: input.sessionId,
        origin: input.origin,
        startCommandCorrelationId: input.startCommandCorrelationId,
      });
    } catch (error) {
      remapSessionMutationError(error);
    }
    try {
      await dispatchSessionPromptAsync(config, workspace, input.sessionId, input.prompt);
      return jsonResponse({
        disposition: "started",
        run: sessionMutations.acceptStart({ workspaceId: workspace.id, sessionId: input.sessionId, runId: run.runId }) ?? run,
      }, 202);
    } catch (error) {
      sessionMutations.rollbackStart({ workspaceId: workspace.id, sessionId: input.sessionId, runId: run.runId });
      throw error;
    }
  }

  async function abortSessionRun(
    ctx: RequestContext,
    input: { sessionId: string; runId: string; abortCommandCorrelationId: string | null },
  ) {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    let reservation;
    try {
      reservation = sessionMutations.reserveAbort({
        workspaceId: workspace.id,
        sessionId: input.sessionId,
        runId: input.runId,
        abortCommandCorrelationId: input.abortCommandCorrelationId,
      });
    } catch (error) {
      remapSessionMutationError(error);
    }
    try {
      const abortRequested = await dispatchSessionAbort(config, workspace, input.sessionId);
      if (!abortRequested) {
        throw new ApiError(502, "opencode_abort_not_accepted", "OpenCode did not accept the abort request");
      }
      const run = sessionMutations.acceptAbort({
        workspaceId: workspace.id,
        sessionId: input.sessionId,
        runId: input.runId,
        abortCommandCorrelationId: input.abortCommandCorrelationId,
      });
      return jsonResponse({ run: run ?? reservation.run, abortRequested: true }, 202);
    } catch (error) {
      sessionMutations.rollbackAbort({
        workspaceId: workspace.id,
        sessionId: input.sessionId,
        runId: input.runId,
        abortCommandCorrelationId: input.abortCommandCorrelationId,
        previousStatus: reservation.previousStatus,
      });
      throw error;
    }
  }

  async function observeSessionRun(
    ctx: RequestContext,
    input: { sessionId: string; runId: string; status: SessionMutationObservationStatus },
  ) {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    try {
      const observation = sessionMutations.observe({ workspaceId: workspace.id, ...input });
      if (observation.cleared) {
        for (const admitted of sessionPendingOperations.list(workspace.id, input.sessionId)) {
          if (admitted.state === "admitted" && admitted.admittedId === input.runId) {
            sessionPendingOperations.markCompleted(admitted.id);
          }
        }
        void sessionPendingOperationPump.wake();
      }
      return jsonResponse(observation);
    } catch (error) {
      remapSessionMutationError(error);
    }
  }

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/runs/start", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const body = parseRunBody(startRunBodySchema, await readJsonBody(ctx.request));
    return startSessionRun(ctx, { sessionId, ...body, prompt: body.prompt as Record<string, unknown> });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/pending/:pendingOperationId/cancel", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const pendingOperationId = parseRunIdentifier(ctx.params.pendingOperationId, "pendingOperationId");
    const body = parseRunBody(cancelPendingBodySchema, await readJsonBody(ctx.request));
    const pending = sessionPendingOperations.get(pendingOperationId);
    if (!pending || pending.workspaceId !== workspace.id || pending.sessionId !== sessionId) throw new ApiError(404, "pending_operation_not_found", "Pending operation not found");
    try {
      const result = sessionPendingOperations.cancel(pendingOperationId, body.commandCorrelationId);
      return jsonResponse({ pendingOperationId, status: result.cancelled ? "cancelled" : "already_cancelled" });
    } catch (error) {
      if (error instanceof SessionPendingOperationError && error.code === "not_cancellable") {
        return jsonResponse({ pendingOperationId, status: "not_cancellable" });
      }
      throw error;
    }
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/pending", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const pending = sessionPendingOperations.list(workspace.id, sessionId)
      .filter((item) => item.state === "pending");
    return jsonResponse({ items: pending.map((item, index) => ({ id: item.id, mode: item.mode, position: index + 1, status: "pending" })) });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/runs/:runId/abort", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const runId = parseRunIdentifier(ctx.params.runId, "runId");
    const body = parseRunBody(abortRunBodySchema, await readJsonBody(ctx.request));
    return abortSessionRun(ctx, { sessionId, runId, ...body });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/runs/:runId/observations", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const runId = parseRunIdentifier(ctx.params.runId, "runId");
    const body = parseRunBody(observeRunBodySchema, await readJsonBody(ctx.request));
    return observeSessionRun(ctx, { sessionId, runId, ...body });
  });

  // Existing in-flight callers use these aliases while Electron and renderer migrate.
  addRoute(routes, "POST", "/workspace/:id/session-runs/:sessionId/start", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const body = parseRunBody(legacyStartRunBodySchema, await readJsonBody(ctx.request));
    return startSessionRun(ctx, {
      sessionId,
      origin: body.origin === "local" ? "local-renderer" : "remote-control",
      startCommandCorrelationId: body.commandId,
      prompt: body.prompt as Record<string, unknown>,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/session-runs/:sessionId/abort", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const body = parseRunBody(legacyAbortRunBodySchema, await readJsonBody(ctx.request));
    return abortSessionRun(ctx, {
      sessionId,
      runId: body.expectedRunId,
      abortCommandCorrelationId: body.commandId,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/session-runs/:sessionId/observe", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const body = parseRunBody(legacyObserveRunBodySchema, await readJsonBody(ctx.request));
    const status = body.observation === "error" ? "failed" : body.observation;
    return observeSessionRun(ctx, { sessionId, runId: body.expectedRunId, status });
  });

  addRoute(routes, "GET", "/workspace/:id/session-runs", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    return jsonResponse({ items: sessionMutations.listActive(workspace.id) });
  });

  addRoute(routes, "POST", "/remote-control/pending/cancel-all", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const body = parseRunBody(z.object({ commandCorrelationId: runIdentifierSchema }).strict(), await readJsonBody(ctx.request));
    return jsonResponse({ cancelled: await sessionPendingOperationPump.cancelAll(body.commandCorrelationId) });
  });

  addRoute(routes, "POST", "/remote-control/pending/enable", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const body = parseRunBody(z.object({ enabled: z.boolean(), steer: z.boolean(), enqueue: z.boolean() }).strict(), await readJsonBody(ctx.request));
    const policy = {
      steer: body.enabled && body.steer,
      enqueue: body.enabled && body.enqueue,
    };
    const cancelled = policy.steer || policy.enqueue
      ? sessionPendingOperationPump.enable(policy).cancelled
      : await sessionPendingOperationPump.cancelAll("policy_disabled");
    return jsonResponse({ enabled: policy.steer || policy.enqueue, ...policy, cancelled });
  });

  addRoute(routes, "DELETE", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");

    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }

    const opencode = createWorkspaceOpencodeClient(config, workspace);
    unwrapOpencodeResult(
      await opencode.session.delete({ sessionID: sessionId }),
      `/session/${encodeURIComponent(sessionId)}`,
    );

    return jsonResponse({ ok: true });
  });
}
