import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { ApiError } from "../errors.js";
import {
  InteractionResolutionError,
  type InteractionKind,
  type InteractionResolutionCoordinator,
  type InteractionScope,
} from "../interaction-resolution-coordinator.js";
import { buildSessionAncestry, type SessionAncestryRecord } from "../session-ancestry.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterInteractionRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  interactionResolutions: InteractionResolutionCoordinator;
}

type PendingPermission = {
  id: string;
  sessionID: string;
  protocol: "legacy" | "v2";
} & Record<string, unknown>;

type PendingQuestion = {
  id: string;
  sessionID: string;
  protocol: "legacy" | "v2";
  questions: Array<Record<string, unknown> & {
    id?: string;
    question: string;
    options: Array<Record<string, unknown> & { label: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
} & Record<string, unknown>;

type OwnedInteraction<T> = T & {
  targetSessionId: string;
  parentSessionId: string | null;
  rootSessionId: string;
  ancestryPath: string[];
};

const SNAPSHOT_V2_CONCURRENCY = 8;

const identifierSchema = z.string().trim().min(1).max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const baseReplyShape = {
  origin: z.enum(["local-renderer", "remote-control"]),
  commandCorrelationId: identifierSchema.nullable(),
};
const permissionReplySchema = z.discriminatedUnion("origin", [
  z.object({
    ...baseReplyShape,
    origin: z.literal("local-renderer"),
    response: z.enum(["allow_once", "always", "reject"]),
  }).strict(),
  z.object({
    ...baseReplyShape,
    origin: z.literal("remote-control"),
    rootSessionId: identifierSchema,
    response: z.enum(["allow_once", "reject"]),
  }).strict(),
]);
const questionAnswersShape = {
  answers: z.array(z.object({
    questionId: identifierSchema,
    values: z.array(z.string().max(10_000)).min(1).max(100),
  }).strict()).min(1).max(100).refine(
    (answers) => new Set(answers.map((answer) => answer.questionId)).size === answers.length,
    "questions must be answered at most once",
  ),
} as const;
const questionReplySchema = z.discriminatedUnion("origin", [
  z.object({ ...baseReplyShape, ...questionAnswersShape, origin: z.literal("local-renderer") }).strict(),
  z.object({ ...baseReplyShape, ...questionAnswersShape, origin: z.literal("remote-control"), rootSessionId: identifierSchema }).strict(),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentifier(value: unknown, field: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", `${field} is invalid`);
  return parsed.data;
}

function parsePermissionBody(body: Record<string, unknown>) {
  if (
    body.origin !== "local-renderer" &&
    (body.response === "always" || body.response === "allow_always" || body.response === "allow_persistent")
  ) {
    throw new ApiError(400, "unsupported_permission_response", "Persistent permission responses are not supported");
  }
  const parsed = permissionReplySchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Permission reply payload is invalid");
  return parsed.data;
}

function parseQuestionBody(body: Record<string, unknown>) {
  const parsed = questionReplySchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Question reply payload is invalid");
  return parsed.data;
}

function successfulData(result: unknown): unknown | undefined {
  if (!isRecord(result) || result.error !== undefined || result.data === undefined) return undefined;
  return result.data;
}

function resultItems(result: unknown, v2: boolean): unknown[] | null {
  const data = successfulData(result);
  if (v2) return isRecord(data) && Array.isArray(data.data) ? data.data : null;
  return Array.isArray(data) ? data : null;
}

function throwUpstream(result: unknown, path: string): never {
  const response = isRecord(result) && result.response instanceof Response ? result.response : null;
  throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
    status: response?.status ?? 502,
    path,
  });
}

function resultStatus(result: unknown): number | null {
  return isRecord(result) && result.response instanceof Response ? result.response.status : null;
}

function isExplicitlyUnsupported(result: unknown): boolean {
  const status = resultStatus(result);
  const error = isRecord(result) && isRecord(result.error) ? result.error : null;
  return resultItems(result, true) === null &&
    (status === 405 || status === 501 || (status === 404 && error?.code === "not_found"));
}

function normalizePermission(value: unknown, protocol: "legacy" | "v2"): PendingPermission | null {
  if (!isRecord(value)) return null;
  const id = identifierSchema.safeParse(value.id);
  const sessionID = identifierSchema.safeParse(value.sessionID);
  if (!id.success || !sessionID.success) return null;
  return { ...value, id: id.data, sessionID: sessionID.data, protocol };
}

function normalizeQuestion(value: unknown, protocol: "legacy" | "v2"): PendingQuestion | null {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 100) {
    return null;
  }
  const id = identifierSchema.safeParse(value.id);
  const sessionID = identifierSchema.safeParse(value.sessionID);
  if (!id.success || !sessionID.success) return null;
  const questions: PendingQuestion["questions"] = [];
  const questionIds = new Set<string>();
  for (const raw of value.questions) {
    if (!isRecord(raw) || typeof raw.question !== "string" || !raw.question.trim() || raw.question.length > 5_000 ||
        !Array.isArray(raw.options) || raw.options.length > 100 ||
        (raw.multiple !== undefined && typeof raw.multiple !== "boolean") ||
        (raw.custom !== undefined && typeof raw.custom !== "boolean")) return null;
    const parsedQuestionId = raw.id === undefined
      ? identifierSchema.safeParse(`q_${raw.question.slice(0, 32)}`)
      : identifierSchema.safeParse(raw.id);
    if (!parsedQuestionId.success || questionIds.has(parsedQuestionId.data)) return null;
    questionIds.add(parsedQuestionId.data);
    const options: PendingQuestion["questions"][number]["options"] = [];
    for (const option of raw.options) {
      if (!isRecord(option) || typeof option.label !== "string" || !option.label.trim() || option.label.length > 1_000) return null;
      options.push({ ...option, label: option.label });
    }
    questions.push({
      ...raw,
      id: parsedQuestionId.data,
      question: raw.question,
      options,
      ...(typeof raw.multiple === "boolean" ? { multiple: raw.multiple } : {}),
      ...(typeof raw.custom === "boolean" ? { custom: raw.custom } : {}),
    });
  }
  return { ...value, id: id.data, sessionID: sessionID.data, protocol, questions };
}

function sessionAncestryRecord(value: unknown): SessionAncestryRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  if (value.parentID === undefined || value.parentID === null) {
    return { id: value.id, parentId: null, valid: true };
  }
  if (typeof value.parentID !== "string" || !value.parentID) {
    return { id: value.id, parentId: null, valid: false };
  }
  return { id: value.id, parentId: value.parentID, valid: true };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function mergeOwnedInteractions<T extends PendingPermission | PendingQuestion>(
  legacyItems: unknown[] | null,
  legacyResult: unknown,
  v2Reads: Array<{ sessionId: string; items: unknown[] | null; result: unknown }>,
  visibleSessionIds: string[],
  rootSessionId: string,
  parentOf: (sessionId: string) => string | null,
  pathOf: (sessionId: string) => string[] | null,
  normalize: (value: unknown, protocol: "legacy" | "v2") => T | null,
  kind: InteractionKind,
): Array<OwnedInteraction<T>> {
  if (legacyItems === null) throwUpstream(legacyResult, `/${kind}`);
  const failedReads = v2Reads.filter((read) => read.items === null);
  const unsupportedReads = failedReads.filter((read) => isExplicitlyUnsupported(read.result));
  const useLegacyOnly = failedReads.length === v2Reads.length && unsupportedReads.length === v2Reads.length;
  if (failedReads.length > 0 && !useLegacyOnly) {
    const failed = failedReads.find((read) => !isExplicitlyUnsupported(read.result)) ?? failedReads[0]!;
    throwUpstream(failed.result, `/api/session/${encodeURIComponent(failed.sessionId)}/${kind}`);
  }

  const visible = new Set(visibleSessionIds);
  const merged = new Map<string, OwnedInteraction<T>>();
  function add(raw: unknown, protocol: "legacy" | "v2", expectedSessionId?: string): void {
    const item = normalize(raw, protocol);
    if (!item) throw new ApiError(502, "opencode_snapshot_incomplete", "OpenCode interaction snapshot is incomplete");
    if (!visible.has(item.sessionID)) return;
    if (expectedSessionId && item.sessionID !== expectedSessionId) {
      throw new ApiError(502, "opencode_snapshot_incomplete", "OpenCode interaction snapshot is incomplete");
    }
    const ancestryPath = pathOf(item.sessionID);
    if (!ancestryPath || ancestryPath[0] !== rootSessionId) return;
    merged.set(`${item.sessionID}\0${item.id}`, {
      ...item,
      targetSessionId: item.sessionID,
      parentSessionId: parentOf(item.sessionID),
      rootSessionId,
      ancestryPath,
    });
  }
  for (const raw of legacyItems) add(raw, "legacy");
  for (const read of useLegacyOnly ? [] : v2Reads) {
    for (const raw of read.items ?? []) add(raw, "v2", read.sessionId);
  }
  return [...merged.values()];
}

async function readInteractionSnapshot(
  client: WorkspaceOpencodeClient,
  requestedSessionId: string,
  includeDescendants: boolean,
) {
  const snapshotStartedAt = Date.now();
  const [sessionResult, legacyPermissionResult, legacyQuestionResult] = await Promise.all([
    client.session.list(),
    client.permission.list(),
    client.question.list(),
  ]);
  const rawSessions = resultItems(sessionResult, false);
  if (!rawSessions) throwUpstream(sessionResult, "/session");
  const ancestry = buildSessionAncestry(rawSessions.flatMap((value) => {
    const record = sessionAncestryRecord(value);
    return record ? [record] : [];
  }));
  if (!ancestry.has(requestedSessionId)) {
    throw new ApiError(404, "session_not_found", "Session not found");
  }
  const rootSessionId = ancestry.rootOf(requestedSessionId);
  if (!rootSessionId) {
    throw new ApiError(409, "invalid_session_ancestry", "Session ancestry is malformed");
  }
  if (includeDescendants && rootSessionId !== requestedSessionId) {
    throw new ApiError(400, "session_not_root", "includeDescendants requires a root session");
  }
  const sessionIds = includeDescendants ? ancestry.descendantsOf(rootSessionId) : [requestedSessionId];
  const reads = sessionIds.flatMap((sessionId) => [
    { sessionId, kind: "permission" as const },
    { sessionId, kind: "question" as const },
  ]);
  const v2Reads = await mapWithConcurrency(reads, SNAPSHOT_V2_CONCURRENCY, async ({ sessionId, kind }) => {
    const result = kind === "permission"
      ? await client.v2.session.permission.list({ sessionID: sessionId })
      : await client.v2.session.question.list({ sessionID: sessionId });
    return { sessionId, kind, items: resultItems(result, true), result };
  });
  const parentOf = (sessionId: string) => ancestry.parentOf(sessionId);
  const pathOf = (sessionId: string) => ancestry.pathOf(sessionId);
  return {
    snapshotStartedAt,
    rootSessionId,
    includeDescendants,
    permissions: mergeOwnedInteractions(
      resultItems(legacyPermissionResult, false),
      legacyPermissionResult,
      v2Reads.filter((read) => read.kind === "permission"),
      sessionIds,
      rootSessionId,
      parentOf,
      pathOf,
      normalizePermission,
      "permission",
    ),
    questions: mergeOwnedInteractions(
      resultItems(legacyQuestionResult, false),
      legacyQuestionResult,
      v2Reads.filter((read) => read.kind === "question"),
      sessionIds,
      rootSessionId,
      parentOf,
      pathOf,
      normalizeQuestion,
      "question",
    ),
  };
}

function parseIncludeDescendants(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ApiError(400, "invalid_query", "includeDescendants must be a boolean");
}

async function readPendingPermissions(client: WorkspaceOpencodeClient, sessionId: string): Promise<PendingPermission[]> {
  const v2Result = await client.v2.session.permission.list({ sessionID: sessionId });
  const v2 = resultItems(v2Result, true);
  if (v2 === null && !isExplicitlyUnsupported(v2Result)) {
    throwUpstream(v2Result, `/api/session/${encodeURIComponent(sessionId)}/permission`);
  }
  // A supported v2 endpoint may legitimately return an empty list while a
  // mixed-version engine still has legacy requests pending. Snapshot reads
  // merge both protocols, so exact replies must use the same protocol view.
  const legacyResult = await client.permission.list();
  const legacy = resultItems(legacyResult, false);
  if (legacy === null) throwUpstream(legacyResult, "/permission");
  const byId = new Map<string, PendingPermission>();
  for (const raw of legacy) {
    const item = normalizePermission(raw, "legacy");
    if (!item) {
      throw new ApiError(502, "opencode_snapshot_incomplete", "OpenCode interaction snapshot is incomplete");
    }
    if (item.sessionID === sessionId) byId.set(item.id, item);
  }
  for (const raw of v2 ?? []) {
    const item = normalizePermission(raw, "v2");
    if (!item || item.sessionID !== sessionId) {
      throw new ApiError(502, "opencode_snapshot_incomplete", "OpenCode interaction snapshot is incomplete");
    }
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

async function readPendingQuestions(client: WorkspaceOpencodeClient, sessionId: string): Promise<PendingQuestion[]> {
  const v2Result = await client.v2.session.question.list({ sessionID: sessionId });
  const v2 = resultItems(v2Result, true);
  if (v2 === null && !isExplicitlyUnsupported(v2Result)) {
    throwUpstream(v2Result, `/api/session/${encodeURIComponent(sessionId)}/question`);
  }
  const legacyResult = await client.question.list();
  const legacy = resultItems(legacyResult, false);
  if (legacy === null) throwUpstream(legacyResult, "/question");
  const byId = new Map<string, PendingQuestion>();
  for (const raw of legacy) {
    const item = normalizeQuestion(raw, "legacy");
    if (!item) {
      throw new ApiError(502, "opencode_snapshot_incomplete", "OpenCode interaction snapshot is incomplete");
    }
    if (item.sessionID === sessionId) byId.set(item.id, item);
  }
  for (const raw of v2 ?? []) {
    const item = normalizeQuestion(raw, "v2");
    if (!item || item.sessionID !== sessionId) {
      throw new ApiError(502, "opencode_snapshot_incomplete", "OpenCode interaction snapshot is incomplete");
    }
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

async function verifyImmutableRootBinding(
  client: WorkspaceOpencodeClient,
  rootSessionId: string,
  targetSessionId: string,
): Promise<void> {
  const sessionResult = await client.session.list();
  const rawSessions = resultItems(sessionResult, false);
  if (!rawSessions) throwUpstream(sessionResult, "/session");
  const ancestry = buildSessionAncestry(rawSessions.flatMap((value) => {
    const record = sessionAncestryRecord(value);
    return record ? [record] : [];
  }));
  if (!ancestry.has(rootSessionId) || ancestry.rootOf(rootSessionId) !== rootSessionId ||
      ancestry.rootOf(targetSessionId) !== rootSessionId) {
    throw new ApiError(404, "interaction_not_found", "The interaction was not found");
  }
}

function questionId(question: PendingQuestion["questions"][number]): string {
  return question.id || `q_${question.question.slice(0, 32)}`;
}

function validateQuestionAnswers(
  pending: PendingQuestion,
  answers: Array<{ questionId: string; values: string[] }>,
): string[][] {
  const expected = pending.questions.map((question) => ({ id: questionId(question), question }));
  if (new Set(expected.map((entry) => entry.id)).size !== expected.length || answers.length !== expected.length) {
    throw new ApiError(400, "invalid_question_answers", "Question answers do not match the pending question schema");
  }
  const byId = new Map(answers.map((answer) => [answer.questionId, answer.values]));
  return expected.map(({ id, question }) => {
    const values = byId.get(id);
    if (!values || (!question.multiple && values.length !== 1) || new Set(values).size !== values.length) {
      throw new ApiError(400, "invalid_question_answers", "Question answer cardinality is invalid");
    }
    const optionLabels = new Set(question.options.map((option) => option.label));
    for (const value of values) {
      if (!value.trim() || (question.custom === false && !optionLabels.has(value))) {
        throw new ApiError(400, "invalid_question_answers", "Question answer is not permitted by the pending schema");
      }
    }
    return values;
  });
}

function remapResolutionError(error: unknown): never {
  if (error instanceof InteractionResolutionError) {
    if (error.code === "already_resolved") {
      throw new ApiError(409, error.code, "The interaction is already reserved or resolved");
    }
    if (error.code === "interaction_expired") {
      throw new ApiError(410, error.code, "The interaction has expired");
    }
    throw new ApiError(404, error.code, "The interaction was not found");
  }
  throw error;
}

function requireUnresolved(interactionResolutions: InteractionResolutionCoordinator, scope: InteractionScope): void {
  const status = interactionResolutions.status(scope);
  if (status === "reserved" || status === "resolved") remapResolutionError(new InteractionResolutionError("already_resolved"));
  if (status === "expired") remapResolutionError(new InteractionResolutionError("interaction_expired"));
}

async function dispatchPermissionReply(
  client: WorkspaceOpencodeClient,
  pending: PendingPermission,
  response: "allow_once" | "always" | "reject",
): Promise<void> {
  const reply = response === "allow_once" ? "once" : response;
  const result = pending.protocol === "v2"
    ? await client.v2.session.permission.reply({ sessionID: pending.sessionID, requestID: pending.id, reply })
    : await client.permission.reply({ requestID: pending.id, reply });
  if (isRecord(result) && result.error !== undefined) {
    throwUpstream(result, pending.protocol === "v2"
      ? `/api/session/${encodeURIComponent(pending.sessionID)}/permission/${encodeURIComponent(pending.id)}/reply`
      : `/permission/${encodeURIComponent(pending.id)}/reply`);
  }
}

async function dispatchQuestionReply(
  client: WorkspaceOpencodeClient,
  pending: PendingQuestion,
  answers: string[][],
): Promise<void> {
  const result = pending.protocol === "v2"
    ? await client.v2.session.question.reply({
        sessionID: pending.sessionID,
        requestID: pending.id,
        questionV2Reply: { answers },
      })
    : await client.question.reply({ requestID: pending.id, answers });
  if (isRecord(result) && result.error !== undefined) {
    throwUpstream(result, pending.protocol === "v2"
      ? `/api/session/${encodeURIComponent(pending.sessionID)}/question/${encodeURIComponent(pending.id)}/reply`
      : `/question/${encodeURIComponent(pending.id)}/reply`);
  }
}

export function registerInteractionRoutes(options: RegisterInteractionRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    createWorkspaceOpencodeClient,
    interactionResolutions,
  } = options;

  async function prepare(
    ctx: RequestContext,
    kind: InteractionKind,
  ): Promise<{ workspace: WorkspaceInfo; client: WorkspaceOpencodeClient; scope: InteractionScope }> {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const scope = {
      workspaceId: workspace.id,
      sessionId: parseIdentifier(ctx.params.sessionId, "sessionId"),
      interactionId: parseIdentifier(ctx.params.interactionId, "interactionId"),
      kind,
    } satisfies InteractionScope;
    requireUnresolved(interactionResolutions, scope);
    return { workspace, client: createWorkspaceOpencodeClient(config, workspace), scope };
  }

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/interactions/snapshot", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = parseIdentifier(ctx.params.sessionId, "sessionId");
    const includeDescendants = parseIncludeDescendants(ctx.url.searchParams.get("includeDescendants"));
    const client = createWorkspaceOpencodeClient(config, workspace);
    return jsonResponse({ item: await readInteractionSnapshot(client, sessionId, includeDescendants) });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/interactions/:interactionId/permission/reply", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const body = parsePermissionBody(await readJsonBody(ctx.request));
    const { client, scope } = await prepare(ctx, "permission");
    if (body.origin === "remote-control") {
      await verifyImmutableRootBinding(client, body.rootSessionId, scope.sessionId);
    }
    const pending = (await readPendingPermissions(client, scope.sessionId))
      .find((item) => item.id === scope.interactionId);
    if (!pending) {
      requireUnresolved(interactionResolutions, scope);
      throw new ApiError(404, "interaction_not_found", "The interaction was not found");
    }
    try {
      interactionResolutions.observePending(scope);
      const reservation = interactionResolutions.reserve({ ...scope, ...body });
      try {
        await dispatchPermissionReply(client, pending, body.response);
        interactionResolutions.accept(reservation);
        return jsonResponse({ interactionId: scope.interactionId, status: "resolved" });
      } catch (error) {
        interactionResolutions.rollback(reservation);
        throw error;
      }
    } catch (error) {
      remapResolutionError(error);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/interactions/:interactionId/question/reply", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const body = parseQuestionBody(await readJsonBody(ctx.request));
    const { client, scope } = await prepare(ctx, "question");
    if (body.origin === "remote-control") {
      await verifyImmutableRootBinding(client, body.rootSessionId, scope.sessionId);
    }
    const pending = (await readPendingQuestions(client, scope.sessionId))
      .find((item) => item.id === scope.interactionId);
    if (!pending) {
      requireUnresolved(interactionResolutions, scope);
      throw new ApiError(404, "interaction_not_found", "The interaction was not found");
    }
    try {
      interactionResolutions.observePending(scope);
      const answers = validateQuestionAnswers(pending, body.answers);
      const reservation = interactionResolutions.reserve({
        ...scope,
        origin: body.origin,
        commandCorrelationId: body.commandCorrelationId,
      });
      try {
        await dispatchQuestionReply(client, pending, answers);
        interactionResolutions.accept(reservation);
        return jsonResponse({ interactionId: scope.interactionId, status: "resolved" });
      } catch (error) {
        interactionResolutions.rollback(reservation);
        throw error;
      }
    } catch (error) {
      remapResolutionError(error);
    }
  });
}
