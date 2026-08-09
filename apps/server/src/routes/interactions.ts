import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { ApiError } from "../errors.js";
import {
  InteractionResolutionError,
  type InteractionKind,
  type InteractionResolutionCoordinator,
  type InteractionScope,
} from "../interaction-resolution-coordinator.js";
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
};

type PendingQuestion = {
  id: string;
  sessionID: string;
  protocol: "legacy" | "v2";
  questions: Array<{
    id?: string;
    question: string;
    options: Array<{ label: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
};

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
    response: z.enum(["allow_once", "reject"]),
  }).strict(),
]);
const questionReplySchema = z.object({
  ...baseReplyShape,
  answers: z.array(z.object({
    questionId: identifierSchema,
    values: z.array(z.string().max(10_000)).min(1).max(100),
  }).strict()).min(1).max(100).refine(
    (answers) => new Set(answers.map((answer) => answer.questionId)).size === answers.length,
    "questions must be answered at most once",
  ),
}).strict();

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

function normalizePermission(value: unknown, protocol: "legacy" | "v2"): PendingPermission | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionID !== "string") return null;
  return { id: value.id, sessionID: value.sessionID, protocol };
}

function normalizeQuestion(value: unknown, protocol: "legacy" | "v2"): PendingQuestion | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionID !== "string" || !Array.isArray(value.questions)) {
    return null;
  }
  const questions = value.questions.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.question !== "string" || !Array.isArray(raw.options)) return [];
    const options = raw.options.flatMap((option) =>
      isRecord(option) && typeof option.label === "string" ? [{ label: option.label }] : []);
    if (options.length !== raw.options.length) return [];
    return [{
      ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
      question: raw.question,
      options,
      ...(typeof raw.multiple === "boolean" ? { multiple: raw.multiple } : {}),
      ...(typeof raw.custom === "boolean" ? { custom: raw.custom } : {}),
    }];
  });
  if (questions.length !== value.questions.length) return null;
  return { id: value.id, sessionID: value.sessionID, protocol, questions };
}

async function readPendingPermissions(client: WorkspaceOpencodeClient, sessionId: string): Promise<PendingPermission[]> {
  const [legacyResult, v2Result] = await Promise.all([
    client.permission.list(),
    client.v2.session.permission.list({ sessionID: sessionId }),
  ]);
  const legacy = resultItems(legacyResult, false);
  const v2 = resultItems(v2Result, true);
  if (!legacy && !v2) throwUpstream(v2Result, `/api/session/${encodeURIComponent(sessionId)}/permission`);
  const byId = new Map<string, PendingPermission>();
  for (const raw of legacy ?? []) {
    const item = normalizePermission(raw, "legacy");
    if (item?.sessionID === sessionId) byId.set(item.id, item);
  }
  for (const raw of v2 ?? []) {
    const item = normalizePermission(raw, "v2");
    if (item?.sessionID === sessionId) byId.set(item.id, item);
  }
  return [...byId.values()];
}

async function readPendingQuestions(client: WorkspaceOpencodeClient, sessionId: string): Promise<PendingQuestion[]> {
  const [legacyResult, v2Result] = await Promise.all([
    client.question.list(),
    client.v2.session.question.list({ sessionID: sessionId }),
  ]);
  const legacy = resultItems(legacyResult, false);
  const v2 = resultItems(v2Result, true);
  if (!legacy && !v2) throwUpstream(v2Result, `/api/session/${encodeURIComponent(sessionId)}/question`);
  const byId = new Map<string, PendingQuestion>();
  for (const raw of legacy ?? []) {
    const item = normalizeQuestion(raw, "legacy");
    if (item?.sessionID === sessionId) byId.set(item.id, item);
  }
  for (const raw of v2 ?? []) {
    const item = normalizeQuestion(raw, "v2");
    if (item?.sessionID === sessionId) byId.set(item.id, item);
  }
  return [...byId.values()];
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

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/interactions/:interactionId/permission/reply", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const body = parsePermissionBody(await readJsonBody(ctx.request));
    const { client, scope } = await prepare(ctx, "permission");
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
