import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { desktopRemotePromptPartSchema } from "@jugglework/types/desktop-remote-control";
import { isChatSelectableProviderModel } from "@jugglework/types/media-generation";
import { z } from "zod";
import {
  detectResponseLanguageFromText,
  responseLanguageInstruction,
  type ResponseLanguage,
} from "@jugglework/types/response-language";
import { ApiError } from "../errors.js";
import { admitOpencodePrompt, type AdmissionIdentity } from "../opencode-admission.js";
import { currentRunTerminalStatus } from "../session-completion-evidence.js";
import { cloudDocTurnSchema } from "../cloud-docs/schema.js";
import { officeSelectionSubmissionSchema, type OfficeSelectionSubmission } from "../office/selection-edits.js";
import {
  SessionMutationError,
  type SessionMutationCoordinator,
  type SessionMutationObservationStatus,
  type SessionMutationOrigin,
} from "../session-mutation-coordinator.js";
import { buildSession, buildSessionList, buildSessionMessages, buildSessionSnapshot } from "../session-read-model.js";
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
import type { SessionModelPreferenceStore } from "../session-model-preferences.js";
import {
  SESSION_PENDING_OPERATION_IDLE_CONFIRM_MS,
  type SessionPendingOperationPump,
} from "../session-pending-operation-pump.js";
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
  readRunTerminalStatus?: (workspaceId: string, sessionId: string, runId: string) => "completed" | "failed" | "aborted" | null;
  listRunTerminals?: import("../session-run-journal.js").SessionRunJournal["listTerminals"];
  listLifecycleFeed?: import("../session-run-journal.js").SessionRunJournal["listFeed"];
  ackLifecycleFeed?: import("../session-run-journal.js").SessionRunJournal["ackFeed"];
  sessionPendingOperations: SessionPendingOperationStore;
  sessionModelPreferences: SessionModelPreferenceStore;
  sessionPendingOperationPump: SessionPendingOperationPump;
  applySessionResponseLanguage?: (input: {
    workspaceId: string;
    sessionId: string;
    detected?: ResponseLanguage;
    fallback: ResponseLanguage;
  }) => { language: ResponseLanguage; rollback: () => void };
  resolveSessionResponseLanguage?: (input: {
    workspaceId: string;
    sessionId: string;
    detected?: ResponseLanguage;
    fallback: ResponseLanguage;
  }) => ResponseLanguage;
  copySessionResponseLanguage?: (workspaceId: string, sourceSessionId: string, targetSessionId: string) => void;
  readSessionResponseLanguage?: (workspaceId: string, sessionId: string) => ResponseLanguage | null;
  /** 在提交引擎 admission 前登记真实用户消息归属，不创建额外宿主运行。 */
  preparePromptAdmission: (identity: AdmissionIdentity, selection?: OfficeSelectionSubmission) => void | Promise<void>;
  /** Post-delete cleanup for session-scoped server-owned state. */
  onSessionDeleted?: (workspaceId: string, sessionId: string) => void;
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
const responseLanguageSchema = z.enum(["en", "zh"]);
const responseLanguageSignalSchema = z.object({
  detected: responseLanguageSchema.optional(),
  fallback: responseLanguageSchema,
}).strict();
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
}).extend(officeSelectionSubmissionSchema.shape).extend({ cloudDocTurn: cloudDocTurnSchema.optional() }).strict().refine((value) => JSON.stringify(value).length <= 16 * 1024 * 1024, "prompt payload is too large");
const remotePromptBodySchema = z.object({
  parts: z.array(desktopRemotePromptPartSchema).min(1).max(1_000),
  model: z.object({ providerID: runIdentifierSchema, modelID: runIdentifierSchema }).strict().optional(),
}).strict().superRefine((prompt, context) => {
  const files = prompt.parts.filter((part) => part.type === "file");
  const text = prompt.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
  if (files.length > 3) context.addIssue({ code: "custom", message: "too many files" });
  if (Buffer.byteLength(text, "utf8") > 200_000) context.addIssue({ code: "custom", message: "prompt text is too large" });
  if (!text.trim() && files.length === 0) context.addIssue({ code: "custom", message: "prompt is empty" });
  if (Buffer.byteLength(JSON.stringify(prompt.parts), "utf8") > 28 * 1024 * 1024) context.addIssue({ code: "custom", message: "prompt is too large" });
});
const startRunBodySchema = z.discriminatedUnion("origin", [
  z.object({
    origin: z.literal("local-renderer"),
    startCommandCorrelationId: runIdentifierSchema.nullable(),
    prompt: promptBodySchema,
    responseLanguage: responseLanguageSignalSchema.optional(),
    whenBusy: z.enum(["reject", "steer"]).default("reject"),
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
const forkSessionBodySchema = z.object({ messageId: runIdentifierSchema.optional() }).strict();
const updateSessionBodySchema = z.object({
  title: z.string().optional(),
  archived: z.boolean().optional(),
}).strict().refine((value) => value.title !== undefined || value.archived !== undefined);
const queueSessionBodySchema = z.object({
  id: runIdentifierSchema,
  prompt: z.string().min(1).refine((value) => value.trim().length > 0).refine((value) => Buffer.byteLength(value, "utf8") <= 200_000),
}).extend(officeSelectionSubmissionSchema.shape).strict();
const legacyAbortRunBodySchema = z.object({ expectedRunId: runIdentifierSchema, commandId: runIdentifierSchema }).strict();
const observeRunBodySchema = z.object({
  status: z.enum(["starting", "running", "waiting", "retrying", "aborting", "idle", "completed", "failed", "aborted"]),
}).strict();
const lifecycleAckBodySchema = z.object({
  consumerId: runIdentifierSchema,
  deviceEpoch: z.string().uuid(),
  sequence: z.number().int().positive(),
  eventId: z.string().uuid(),
}).strict();
const sessionModelPreferenceBodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto"), model: z.null(), expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ mode: z.literal("explicit"), model: z.object({ providerID: runIdentifierSchema, modelID: runIdentifierSchema }).strict(), expectedRevision: z.number().int().nonnegative() }).strict(),
]);
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

function promptBodyToV2Input(prompt: Record<string, unknown>) {
  if (!Array.isArray(prompt.parts)) {
    throw new ApiError(400, "invalid_payload", "Steer prompt parts are required");
  }

  let text = "";
  const files: Array<{ uri: string; name?: string }> = [];
  const agents: Array<{ name: string }> = [];
  for (const part of prompt.parts) {
    if (!isRecord(part) || typeof part.type !== "string") {
      throw new ApiError(400, "invalid_payload", "Steer prompt contains an invalid part");
    }
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
      continue;
    }
    if (part.type === "file" && typeof part.url === "string") {
      files.push({
        uri: part.url,
        ...(typeof part.filename === "string" && part.filename.trim() ? { name: part.filename } : {}),
      });
      continue;
    }
    if (part.type === "agent" && typeof part.name === "string" && part.name.trim()) {
      agents.push({ name: part.name });
      continue;
    }
    throw new ApiError(400, "unsupported_steer_prompt", `Steer does not support prompt part type: ${part.type}`);
  }
  if (!text.trim() && files.length === 0 && agents.length === 0) {
    throw new ApiError(400, "invalid_payload", "Steer prompt must contain text, a file, or an agent");
  }
  return {
    text,
    ...(files.length ? { files } : {}),
    ...(agents.length ? { agents } : {}),
  };
}

function isInternalTextPart(part: unknown): boolean {
  return isRecord(part) && part.type === "text" && (
    part.synthetic === true || part.ignored === true ||
    (isRecord(part.metadata) && part.metadata.compaction_continue === true)
  );
}

function promptText(prompt: Record<string, unknown>): string {
  return Array.isArray(prompt.parts)
    ? prompt.parts.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && !isInternalTextPart(part) ? [part.text] : []).join("\n")
    : "";
}

function promptResponseLanguage(input: {
  origin: SessionMutationOrigin;
  prompt: Record<string, unknown>;
  responseLanguage?: { detected?: ResponseLanguage; fallback: ResponseLanguage };
}): { detected?: ResponseLanguage; fallback: ResponseLanguage } | undefined {
  const hasInternalText = Array.isArray(input.prompt.parts) && input.prompt.parts.some(isInternalTextPart);
  // Preserve renderer signals (including attachment-only locale fallback) for
  // ordinary submissions. Mixed/internal prompts cannot vouch for that signal.
  if (input.origin === "local-renderer" && !hasInternalText) return input.responseLanguage;
  const text = promptText(input.prompt);
  if (hasInternalText && !text.trim()) return undefined;
  const detected = detectResponseLanguageFromText(text) ?? undefined;
  if (input.origin === "local-renderer") {
    return { detected, fallback: input.responseLanguage?.fallback ?? "en" };
  }
  return detected ? { detected, fallback: "en" } : undefined;
}

function withResponseLanguageSystem(prompt: Record<string, unknown>, language: ResponseLanguage): Record<string, unknown> {
  const existing = typeof prompt.system === "string" && prompt.system.trim() ? `${prompt.system.trim()}\n\n` : "";
  return { ...prompt, system: `${existing}${responseLanguageInstruction(language)}` };
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

export function registerSessionRoutes(options: RegisterSessionRoutesOptions) {
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
    sessionModelPreferences,
    sessionPendingOperationPump,
    applySessionResponseLanguage,
    resolveSessionResponseLanguage,
    copySessionResponseLanguage,
    readSessionResponseLanguage,
    onSessionDeleted,
  } = options;

  async function validateExplicitModel(workspace: WorkspaceInfo, model: { providerID: string; modelID: string }) {
    const catalog = await createWorkspaceOpencodeClient(config, workspace).provider.list();
    if (catalog.error || !catalog.data || !catalog.response.ok) throw new ApiError(502, "model_catalog_unavailable", "Model catalog unavailable");
    const { all, connected } = catalog.data;
    const provider = all.find((item) => item.id === model.providerID && connected.includes(item.id));
    const selected = provider?.models[model.modelID];
    if (!selected || !isChatSelectableProviderModel(selected)) throw new ApiError(400, "model_unavailable", "Selected chat model is unavailable");
  }
  const sessionGroupEvents = new SessionGroupEventStore();

  type NormalizedEngineSessionStatus = "idle" | "running" | "waiting" | "retrying";

  function normalizeEngineSessionStatus(status: z.infer<typeof opencodeTargetSessionStatusSchema>["type"]): NormalizedEngineSessionStatus {
    if (status === "idle") return "idle";
    if (status === "waiting") return "waiting";
    if (status === "retry" || status === "retrying") return "retrying";
    return "running";
  }

  async function hasActiveDelegatedDescendant(
    opencode: WorkspaceOpencodeClient,
    statuses: Record<string, unknown>,
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const parentCache = new Map<string, string | null>();
    const readParent = async (sessionId: string): Promise<string | null> => {
      if (parentCache.has(sessionId)) return parentCache.get(sessionId) ?? null;
      try {
        const session = unwrapOpencodeResult(
          await opencode.session.get({ sessionID: sessionId }, { signal }),
          `/session/${encodeURIComponent(sessionId)}`,
        );
        const parentID = isRecord(session) && typeof session.parentID === "string"
          ? session.parentID.trim() || null
          : null;
        parentCache.set(sessionId, parentID);
        return parentID;
      } catch {
        signal?.throwIfAborted();
        parentCache.set(sessionId, null);
        return null;
      }
    };

    for (const [candidateId, candidateStatus] of Object.entries(statuses)) {
      if (candidateId === parentSessionId) continue;
      const parsed = opencodeTargetSessionStatusSchema.safeParse(candidateStatus);
      if (!parsed.success || normalizeEngineSessionStatus(parsed.data.type) === "idle") continue;

      const visited = new Set<string>([candidateId]);
      let cursor = candidateId;
      for (let depth = 0; depth < 64; depth += 1) {
        const parentID = await readParent(cursor);
        if (!parentID) break;
        if (parentID === parentSessionId) return true;
        if (visited.has(parentID)) break;
        visited.add(parentID);
        cursor = parentID;
      }
    }
    return false;
  }

  async function readEngineSessionStatus(
    workspace: WorkspaceInfo,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<NormalizedEngineSessionStatus> {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    const statuses = unwrapOpencodeResult(await opencode.session.status(undefined, { signal }), "/session/status");
    if (!isRecord(statuses)) {
      throw new ApiError(502, "opencode_invalid_response", "OpenCode returned invalid session status");
    }
    const targetStatus = Object.prototype.hasOwnProperty.call(statuses, sessionId)
      ? statuses[sessionId]
      : undefined;
    if (targetStatus !== undefined) {
      const parsedStatus = opencodeTargetSessionStatusSchema.safeParse(targetStatus);
      if (!parsedStatus.success) {
        throw new ApiError(502, "opencode_invalid_response", "OpenCode returned invalid session status");
      }
      const normalized = normalizeEngineSessionStatus(parsedStatus.data.type);
      if (normalized !== "idle") return normalized;
    }

    // OpenCode can briefly report the root session idle while a delegated
    // child (or nested grandchild) is still executing. The root task remains
    // active in that state: settling it here makes the sidebar claim success
    // and admits overlapping work into a still-running objective.
    return await hasActiveDelegatedDescendant(opencode, statuses, sessionId, signal)
      ? "running"
      : "idle";
  }

  function finalizeClearedRun(workspaceId: string, sessionId: string, runId: string): void {
    for (const admitted of sessionPendingOperations.list(workspaceId, sessionId)) {
      if (admitted.state === "admitted" && admitted.admittedId === runId) {
        sessionPendingOperations.markCompleted(admitted.id);
      }
    }
    void sessionPendingOperationPump.wake();
  }

  async function reconcileWorkspaceActiveRuns(workspace: WorkspaceInfo, signal?: AbortSignal): Promise<void> {
    for (const active of sessionMutations.listActive(workspace.id)) {
      // A current-process admission remains fenced until its dispatch returns.
      // After a restart that continuation no longer exists, so a restored
      // starting run must be allowed to converge from authoritative engine
      // state instead of blocking runtime shutdown forever.
      const restoredStarting = active.status === "starting" &&
        sessionMutations.isRestored(workspace.id, active.sessionId, active.runId);
      if (active.status === "starting" && !restoredStarting) continue;
      let engineStatus: NormalizedEngineSessionStatus;
      try {
        engineStatus = await readEngineSessionStatus(workspace, active.sessionId, signal);
      } catch {
        // Fail closed when authoritative engine state is unavailable.
        continue;
      }
      try {
        if (engineStatus === "idle") {
          const terminalRead = active.status === "aborting"
            ? { available: true as const, status: null }
            : await readCurrentRunTerminalStatus(workspace, active, signal);
          if (!terminalRead.available) continue;
          const terminal = terminalRead.status;
          signal?.throwIfAborted();
          if (terminal === "failed" || terminal === "aborted") {
            sessionMutations.observe({ workspaceId: workspace.id, sessionId: active.sessionId, runId: active.runId, status: terminal });
            finalizeClearedRun(workspace.id, active.sessionId, active.runId);
            continue;
          }
          const restored = sessionMutations.isRestored(workspace.id, active.sessionId, active.runId);
          const interruptedAfterRestart = active.status !== "aborting" && !terminal && restored;
          if (active.status !== "aborting" && !terminal && !interruptedAfterRestart) continue;
          const reconciliation = sessionMutations.reconcileAuthoritativeIdle({
            workspaceId: workspace.id,
            sessionId: active.sessionId,
            runId: active.runId,
            minimumIntervalMs: SESSION_PENDING_OPERATION_IDLE_CONFIRM_MS,
            terminalStatus: interruptedAfterRestart ? "failed" : terminal === "completed" ? "completed" : undefined,
          });
          if (reconciliation.cleared) finalizeClearedRun(workspace.id, active.sessionId, active.runId);
        } else {
          sessionMutations.observe({
            workspaceId: workspace.id,
            sessionId: active.sessionId,
            runId: active.runId,
            status: engineStatus,
          });
        }
      } catch (error) {
        if (!(error instanceof SessionMutationError && error.code === "run_mismatch")) throw error;
      }
    }
  }

  async function readCurrentRunTerminalStatus(
    workspace: WorkspaceInfo,
    run: { sessionId: string; startedAt: number },
    signal?: AbortSignal,
  ): Promise<
    | { available: true; status: "completed" | "failed" | "aborted" | null }
    | { available: false; status: null }
  > {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    try {
      const messages = unwrapOpencodeResult(
        await opencode.session.messages({ sessionID: run.sessionId, limit: 10 }, { signal }),
        "/session/message",
      );
      return { available: true, status: currentRunTerminalStatus(messages, run.startedAt) };
    } catch {
      return { available: false, status: null };
    }
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
      const [sessions, statuses] = await Promise.all([
        opencode.session.list({
          roots: input.roots,
          start: input.start,
          search: input.search,
          limit: input.limit,
        }).then((result) => unwrapOpencodeResult(result, "/session")),
        opencode.session.status()
          .then((result) => unwrapOpencodeResult(result, "/session/status")),
      ]);
      return buildSessionList(sessions, statuses);
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
      await dispatchSessionPromptAsync(config, workspace, session.id, {
        parts: [{ type: "text", text: input.prompt }],
      });
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
    return jsonResponse({ item: { ...item, modelPreference: sessionModelPreferences.get(workspace.id, sessionId) } });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/model-preference", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    await readWorkspaceSession(workspace, sessionId);
    return jsonResponse({ item: sessionModelPreferences.get(workspace.id, sessionId) });
  });

  addRoute(routes, "PUT", "/workspace/:id/sessions/:sessionId/model-preference", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    await readWorkspaceSession(workspace, sessionId);
    const body = parseRunBody(sessionModelPreferenceBodySchema, await readJsonBody(ctx.request));
    if (body.mode === "explicit") await validateExplicitModel(workspace, body.model);
    const result = sessionModelPreferences.set({ workspaceId: workspace.id, sessionId, ...body });
    if (!result.updated) throw new ApiError(409, "revision_conflict", "Session model preference revision is stale", { current: result.preference });
    return jsonResponse({ item: result.preference });
  });

  addRoute(routes, "GET", "/workspace/:id/session-model-events", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const since = parseOptionalNonNegativeInteger(ctx.url.searchParams.get("since"), "since") ?? 0;
    return jsonResponse(sessionModelPreferences.events(workspace.id, since));
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/fork", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const body = parseRunBody(forkSessionBodySchema, await readJsonBody(ctx.request));
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    const item = buildSession(unwrapOpencodeResult(
      await opencode.session.fork({ sessionID: sessionId, messageID: body.messageId }),
      `/session/${encodeURIComponent(sessionId)}/fork`,
    ));
    copySessionResponseLanguage?.(workspace.id, sessionId, item.id);
    return jsonResponse({ item }, 201);
  });

  addRoute(routes, "PATCH", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const body = parseRunBody(updateSessionBodySchema, await readJsonBody(ctx.request));
    const title = body.title === undefined ? undefined : parseSessionCreateTitle(body.title);
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    const item = buildSession(unwrapOpencodeResult(
      await opencode.session.update({
        sessionID: sessionId,
        title,
        time: body.archived === undefined ? undefined : { archived: body.archived ? Date.now() : 0 },
      }),
      `/session/${encodeURIComponent(sessionId)}`,
    ));
    if (title !== undefined) sessionMutations.updateTitle({
      workspaceId: workspace.id,
      sessionId,
      // The upstream response permits a nullish title, but a successful title
      // update still has the validated request value as its local authority.
      title: item.title ?? title,
    });
    return jsonResponse({ item });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/queue", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = parseRunIdentifier(ctx.params.sessionId, "sessionId");
    const body = parseRunBody(queueSessionBodySchema, await readJsonBody(ctx.request));
    await options.preparePromptAdmission({ workspaceId: workspace.id, sessionId, source: "local-queue", id: body.id }, {
      officeSelectionRefs: body.officeSelectionRefs, officeInstructions: body.officeInstructions,
    });
    await admitOpencodePrompt(createWorkspaceOpencodeClient(config, workspace), {
      workspaceId: workspace.id,
      sessionId,
      source: "local-queue",
      id: body.id,
      prompt: { text: body.prompt },
      delivery: "queue",
    });
    return jsonResponse({ disposition: "enqueued", admissionId: body.id }, 202);
  });

  async function startSessionRun(
    ctx: RequestContext,
    input: {
      sessionId: string;
      origin: SessionMutationOrigin;
      startCommandCorrelationId: string | null;
      prompt: Record<string, unknown>;
      responseLanguage?: {
        detected?: ResponseLanguage;
        fallback: ResponseLanguage;
      };
      whenBusy?: "reject" | "steer" | "enqueue";
    },
  ) {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const responseLanguage = promptResponseLanguage(input);
    if (input.origin === "remote-control" && isRecord(input.prompt.model)) {
      if (input.whenBusy !== "reject") throw new ApiError(400, "invalid_payload", "Explicit model requires whenBusy reject");
      await validateExplicitModel(workspace, input.prompt.model as { providerID: string; modelID: string });
    }
    let run;
    try {
      let title = "";
      try { title = (await readWorkspaceSession(workspace, input.sessionId)).title ?? ""; } catch {
        // Title is presentation metadata. Admission authority must not depend on
        // a second engine read when status already proved the session runnable.
      }
      let engineStatus = await readEngineSessionStatus(workspace, input.sessionId);
      let active = sessionMutations.getActive(workspace.id, input.sessionId);

      const terminalRead = engineStatus === "idle" && active && active.status !== "aborting"
        ? await readCurrentRunTerminalStatus(workspace, active)
        : { available: true as const, status: null };
      const terminal = terminalRead.available ? terminalRead.status : null;
      if (active && (terminal === "failed" || terminal === "aborted")) {
        sessionMutations.observe({ workspaceId: workspace.id, sessionId: input.sessionId, runId: active.runId, status: terminal });
        finalizeClearedRun(workspace.id, input.sessionId, active.runId);
        active = null;
      }
      if (engineStatus === "idle" && active && (active.status === "aborting" || terminal === "completed")) {
        const staleRunId = active.runId;
        let reconciliation = sessionMutations.reconcileAuthoritativeIdle({
          workspaceId: workspace.id,
          sessionId: input.sessionId,
          runId: staleRunId,
          minimumIntervalMs: SESSION_PENDING_OPERATION_IDLE_CONFIRM_MS,
        });
        if (!reconciliation.cleared && reconciliation.retryAfterMs !== null) {
          if (reconciliation.retryAfterMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, reconciliation.retryAfterMs!));
          }
          engineStatus = await readEngineSessionStatus(workspace, input.sessionId);
          if (engineStatus === "idle") {
            try {
              reconciliation = sessionMutations.reconcileAuthoritativeIdle({
                workspaceId: workspace.id,
                sessionId: input.sessionId,
                runId: staleRunId,
                minimumIntervalMs: SESSION_PENDING_OPERATION_IDLE_CONFIRM_MS,
              });
            } catch (error) {
              // An active-run poll or another start contender may have already
              // reconciled this exact stale run while this request waited for
              // the second authoritative sample. Continue only when no
              // replacement was installed; reserveStart remains the atomic
              // winner fence below.
              if (!(error instanceof SessionMutationError && error.code === "run_mismatch" &&
                sessionMutations.getActive(workspace.id, input.sessionId) === null)) throw error;
            }
          } else {
            sessionMutations.observe({
              workspaceId: workspace.id,
              sessionId: input.sessionId,
              runId: staleRunId,
              status: engineStatus,
            });
          }
        }
        if (reconciliation.cleared) finalizeClearedRun(workspace.id, input.sessionId, staleRunId);
        active = sessionMutations.getActive(workspace.id, input.sessionId);
      }

      if (engineStatus !== "idle") {
        if (active) {
          sessionMutations.observe({
            workspaceId: workspace.id,
            sessionId: input.sessionId,
            runId: active.runId,
            status: engineStatus,
          });
        }
        if (input.origin === "local-renderer" && input.whenBusy === "steer") {
          if (!input.startCommandCorrelationId) {
            throw new ApiError(400, "invalid_payload", "Local steer requires an admission id");
          }
          const languageMutation = responseLanguage
            ? applySessionResponseLanguage?.({
              workspaceId: workspace.id,
              sessionId: input.sessionId,
              ...responseLanguage,
            })
            : undefined;
          try {
            await options.preparePromptAdmission({ workspaceId: workspace.id, sessionId: input.sessionId, source: "local-steer", id: input.startCommandCorrelationId }, {
              officeSelectionRefs: input.prompt.officeSelectionRefs as string[] | undefined,
              officeInstructions: input.prompt.officeInstructions as OfficeSelectionSubmission["officeInstructions"],
            });
            await admitOpencodePrompt(createWorkspaceOpencodeClient(config, workspace), {
              workspaceId: workspace.id,
              sessionId: input.sessionId,
              source: "local-steer",
              id: input.startCommandCorrelationId,
              prompt: promptBodyToV2Input(input.prompt),
              delivery: "steer",
            });
          } catch (error) {
            languageMutation?.rollback();
            throw error;
          }
          return jsonResponse({ disposition: "steered", admissionId: input.startCommandCorrelationId }, 202);
        }
        if (input.origin === "remote-control" && input.whenBusy && input.whenBusy !== "reject") {
          const promptParts = isRecord(input.prompt) && Array.isArray(input.prompt.parts) ? input.prompt.parts : [];
          const hasFiles = promptParts.some((part) => isRecord(part) && part.type === "file");
          if (hasFiles) {
            throw new SessionMutationError("session_busy", sessionMutations.getActive(workspace.id, input.sessionId)?.runId ?? null);
          }
          const text = promptParts.every((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
            ? promptParts.map((part) => String(part.text)).join("") : null;
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

      // Every contender reads authoritative engine state first. This synchronous
      // reservation then decides which idle local/remote start may dispatch.
      run = sessionMutations.reserveStart({
        workspaceId: workspace.id,
        sessionId: input.sessionId,
        origin: input.origin,
        startCommandCorrelationId: input.startCommandCorrelationId,
        title,
      });
    } catch (error) {
      remapSessionMutationError(error);
    }
    try {
      const languageMutation = responseLanguage
        ? applySessionResponseLanguage?.({
          workspaceId: workspace.id,
          sessionId: input.sessionId,
          ...responseLanguage,
        })
        : undefined;
      const selectedResponseLanguage = languageMutation?.language ?? (responseLanguage
        ? resolveSessionResponseLanguage?.({
            workspaceId: workspace.id,
            sessionId: input.sessionId,
            ...responseLanguage,
          }) ?? responseLanguage.detected ?? responseLanguage.fallback
        : readSessionResponseLanguage?.(workspace.id, input.sessionId) ?? null);
      const preference = sessionModelPreferences.get(workspace.id, input.sessionId);
      if (preference.mode === "explicit" && preference.model &&
        (input.origin === "local-renderer" || input.prompt.model === undefined)) {
        await validateExplicitModel(workspace, preference.model);
        input.prompt.model = preference.model;
      } else if (isRecord(input.prompt.model)) {
        // Auto mode uses the renderer's displayed workspace default. Validate it
        // at dispatch time so provider changes cannot send a stale model.
        await validateExplicitModel(workspace, input.prompt.model as { providerID: string; modelID: string });
      }
      try {
        await dispatchSessionPromptAsync(
          config,
          workspace,
          input.sessionId,
          selectedResponseLanguage ? withResponseLanguageSystem(input.prompt, selectedResponseLanguage) : input.prompt,
        );
      } catch (error) {
        languageMutation?.rollback();
        throw error;
      }
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

  async function abortDelegatedSession(
    ctx: RequestContext,
    input: {
      parentSessionId: string;
      childSessionId: string;
      abortCommandCorrelationId: string | null;
    },
  ) {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const child = await readWorkspaceSession(workspace, input.childSessionId);
    if (child.parentID !== input.parentSessionId) {
      throw new ApiError(409, "delegated_session_parent_mismatch", "Delegated session does not belong to the parent session", {
        parentSessionId: input.parentSessionId,
        childSessionId: input.childSessionId,
      });
    }

    const opencode = createWorkspaceOpencodeClient(config, workspace);
    const statuses = unwrapOpencodeResult(await opencode.session.status(), "/session/status");
    const childStatus = statuses[input.childSessionId];
    if (!childStatus || childStatus.type === "idle") {
      return jsonResponse({
        childSessionId: input.childSessionId,
        abortRequested: false,
        status: "idle",
        abortCommandCorrelationId: input.abortCommandCorrelationId,
      });
    }

    const abortRequested = await dispatchSessionAbort(config, workspace, input.childSessionId);
    if (!abortRequested) {
      throw new ApiError(502, "opencode_abort_not_accepted", "OpenCode did not accept the delegated session abort request");
    }
    return jsonResponse({
      childSessionId: input.childSessionId,
      abortRequested: true,
      status: "aborting",
      abortCommandCorrelationId: input.abortCommandCorrelationId,
    }, 202);
  }

  async function observeSessionRun(
    ctx: RequestContext,
    input: { sessionId: string; runId: string; status: SessionMutationObservationStatus },
  ) {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    try {
      const current = sessionMutations.getActive(workspace.id, input.sessionId);
      if (current && current.runId !== input.runId) {
        throw new SessionMutationError("run_mismatch", current.runId);
      }
      // Another observer/pump may already have cleared this exact run. Return
      // persisted authority, never infer completion from an empty active list.
      const terminalStatus = options.readRunTerminalStatus?.(workspace.id, input.sessionId, input.runId);
      if (terminalStatus) return jsonResponse({ cleared: true, run: null, terminalStatus });
      if (input.status === "idle" || input.status === "completed") {
        const active = sessionMutations.getActive(workspace.id, input.sessionId);
        if (!active || active.runId !== input.runId) {
          throw new SessionMutationError("run_mismatch", active?.runId ?? null);
        }
        if (active.status === "aborting") {
          const observation = sessionMutations.observe({ workspaceId: workspace.id, ...input, status: "idle" });
          if (observation.cleared) finalizeClearedRun(workspace.id, input.sessionId, input.runId);
          return jsonResponse(observation);
        }
        const engineStatus = await readEngineSessionStatus(workspace, input.sessionId);
        if (engineStatus !== "idle") {
          return jsonResponse(sessionMutations.observe({ workspaceId: workspace.id, ...input, status: engineStatus }));
        }
        const terminalRead = await readCurrentRunTerminalStatus(workspace, active);
        if (!terminalRead.available) {
          return jsonResponse({ cleared: false, run: active, terminalStatus: null });
        }
        const terminal = terminalRead.status;
        if (!terminal) {
          return jsonResponse({ cleared: false, run: active, terminalStatus: null });
        }
        if (terminal === "failed" || terminal === "aborted") {
          const observation = sessionMutations.observe({ workspaceId: workspace.id, ...input, status: terminal });
          if (observation.cleared) finalizeClearedRun(workspace.id, input.sessionId, input.runId);
          return jsonResponse(observation);
        }
        if (input.status === "completed") {
          const observation = sessionMutations.observe({ workspaceId: workspace.id, ...input });
          if (observation.cleared) finalizeClearedRun(workspace.id, input.sessionId, input.runId);
          return jsonResponse(observation);
        }
        const observation = sessionMutations.reconcileAuthoritativeIdle({
          workspaceId: workspace.id, sessionId: input.sessionId, runId: input.runId,
          minimumIntervalMs: SESSION_PENDING_OPERATION_IDLE_CONFIRM_MS,
        });
        if (observation.cleared) finalizeClearedRun(workspace.id, input.sessionId, input.runId);
        return jsonResponse(observation);
      }
      const observation = sessionMutations.observe({ workspaceId: workspace.id, ...input });
      if (observation.cleared) {
        finalizeClearedRun(workspace.id, input.sessionId, input.runId);
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

  addRoute(routes, "POST", "/workspace/:id/sessions/:parentSessionId/delegated-sessions/:childSessionId/abort", "client", async (ctx) => {
    const parentSessionId = parseRunIdentifier(ctx.params.parentSessionId, "parentSessionId");
    const childSessionId = parseRunIdentifier(ctx.params.childSessionId, "childSessionId");
    const body = parseRunBody(abortRunBodySchema, await readJsonBody(ctx.request));
    return abortDelegatedSession(ctx, { parentSessionId, childSessionId, ...body });
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

  addRoute(routes, "GET", "/workspace/:id/session-run-terminals", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const after = parseOptionalNonNegativeInteger(ctx.url.searchParams.get("after"), "after") ?? 0;
    const limit = parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit") ?? 100;
    if (!Number.isSafeInteger(after) || limit > 100) throw new ApiError(400, "invalid_payload", "Invalid journal page");
    if (!options.listRunTerminals) throw new ApiError(503, "journal_unavailable", "Run journal unavailable");
    return jsonResponse(options.listRunTerminals(workspace.id, after, limit));
  });

  addRoute(routes, "GET", "/workspace/:id/session-runs", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    return jsonResponse({ items: sessionMutations.listActive(workspace.id) });
  });

  addRoute(routes, "GET", "/session-lifecycle/feed", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const consumerId = parseRunIdentifier(ctx.url.searchParams.get("consumerId"), "consumerId");
    const after = parseOptionalNonNegativeInteger(ctx.url.searchParams.get("after"), "after");
    const limit = parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit") ?? 100;
    const wait = parseOptionalNonNegativeInteger(ctx.url.searchParams.get("wait"), "wait") ?? 0;
    if (limit > 100 || !options.listLifecycleFeed) throw new ApiError(400, "invalid_payload", "Invalid lifecycle feed request");
    if (wait > 30_000) throw new ApiError(400, "invalid_payload", "Lifecycle feed wait exceeds 30000ms");
    let page = options.listLifecycleFeed(consumerId, after, limit);
    if (page.items.length === 0 && wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      page = options.listLifecycleFeed(consumerId, after, limit);
    }
    return jsonResponse(page);
  });

  addRoute(routes, "POST", "/session-lifecycle/feed/ack", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    if (!options.ackLifecycleFeed) throw new ApiError(503, "lifecycle_feed_unavailable", "Lifecycle feed unavailable");
    const body = parseRunBody(lifecycleAckBodySchema, await readJsonBody(ctx.request));
    try { return jsonResponse(options.ackLifecycleFeed(body.consumerId, body.deviceEpoch, body.sequence, body.eventId)); }
    catch (error) { throw new ApiError(409, error instanceof Error ? error.message : "lifecycle_ack_conflict", "Lifecycle ACK rejected"); }
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

    try {
      onSessionDeleted?.(workspace.id, sessionId);
    } catch {
      // Session-owned state cleanup must never fail the engine deletion.
    }

    return jsonResponse({ ok: true });
  });

  return { reconcileWorkspaceActiveRuns };
}
