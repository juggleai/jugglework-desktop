import type { CanonicalInteractionResolution } from "@jugglework/types/agent-runtime";
import { z } from "zod";

import type { AgentRuntimeControlPlane } from "../agent-runtime-control-plane.js";
import { AgentEngineError } from "../agent-engine/errors.js";
import { ApiError } from "../errors.js";
import { InteractionResolutionError } from "../interaction-resolution-coordinator.js";
import type { ServerConfig, TokenScope } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterInteractionRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  controlPlane: AgentRuntimeControlPlane;
}

const identifierSchema = z.string().trim().min(1).max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const baseReplyShape = {
  origin: z.enum(["local-renderer", "remote-control"]),
  commandCorrelationId: identifierSchema.nullable(),
};
const permissionReplySchema = z.object({
  ...baseReplyShape,
  response: z.enum(["allow_once", "always", "reject"]),
}).strict();
const questionReplySchema = z.object({
  ...baseReplyShape,
  answers: z.array(z.object({
    questionId: identifierSchema,
    values: z.array(z.string().max(10_000)).min(1).max(100),
  }).strict()).min(1).max(100),
}).strict();

export function registerInteractionRoutes(options: RegisterInteractionRoutesOptions): void {
  const resolve = async (
    ctx: RequestContext,
    resolution: CanonicalInteractionResolution,
    origin: "local-renderer" | "remote-control",
    commandCorrelationId: string | null,
    questionAnswers?: Array<{ questionId: string; values: string[] }>,
  ) => {
    options.ensureWritable(options.config);
    options.requireClientScope(ctx, "collaborator");
    const workspaceId = ctx.params.id;
    const sessionId = parseId(ctx.params.sessionId, "sessionId");
    await options.controlPlane.bindLegacyOpenCodeSession(workspaceId, sessionId);
    try {
      const interaction = await options.controlPlane.resolveInteraction({
        workspaceId,
        sessionId,
        interactionId: parseId(ctx.params.interactionId, "interactionId"),
        origin,
        commandCorrelationId,
        resolution,
        ...(questionAnswers ? { questionAnswers } : {}),
      });
      return options.jsonResponse({ interactionId: interaction.id, status: "resolved" });
    } catch (error) {
      if (error instanceof InteractionResolutionError) {
        const status = error.code === "already_resolved" ? 409 : error.code === "interaction_expired" ? 410 : 404;
        throw new ApiError(status, error.code, "The interaction is unavailable");
      }
      if (error instanceof AgentEngineError) {
        if (questionAnswers && error.message.startsWith("Question answers")) {
          throw new ApiError(400, "invalid_question_answers", "Question answers do not match the pending request");
        }
        throw new ApiError(502, error.code, error.message, error.details);
      }
      throw error;
    }
  };

  addRoute(options.routes, "POST", "/workspace/:id/sessions/:sessionId/interactions/:interactionId/permission/reply", "client", async (ctx) => {
    const parsed = permissionReplySchema.safeParse(await options.readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_payload", "Permission reply payload is invalid");
    if (parsed.data.origin !== "local-renderer" && parsed.data.response === "always") {
      throw new ApiError(400, "unsupported_permission_response", "Persistent permission responses are not supported");
    }
    return resolve(
      ctx,
      parsed.data.response === "reject"
        ? { outcome: "deny", reason: "User rejected the permission request" }
        : parsed.data.response === "always"
          ? { outcome: "allow", updatedInput: { permissionPersistence: "always" } }
          : { outcome: "allow" },
      parsed.data.origin,
      parsed.data.commandCorrelationId,
    );
  });

  addRoute(options.routes, "POST", "/workspace/:id/sessions/:sessionId/interactions/:interactionId/question/reply", "client", async (ctx) => {
    const parsed = questionReplySchema.safeParse(await options.readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_payload", "Question reply payload is invalid");
    return resolve(
      ctx,
      { outcome: "answer", values: parsed.data.answers.flatMap((answer) => answer.values) },
      parsed.data.origin,
      parsed.data.commandCorrelationId,
      parsed.data.answers,
    );
  });
}

function parseId(value: unknown, field: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", `${field} is invalid`);
  return parsed.data;
}
