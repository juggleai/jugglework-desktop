import { ApiError } from "../errors.js";
import type { FileDeliveryService } from "../artifacts/delivery.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

interface FileDeliveryRouteOptions {
  routes: Route[];
  config: ServerConfig;
  service: FileDeliveryService;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (
    config: ServerConfig,
    id: string,
  ) => Promise<WorkspaceInfo>;
  isIdle: (workspace: WorkspaceInfo, sessionId: string) => Promise<boolean>;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(400, "invalid_payload", `${name} is required`);
  return value;
}

function outputPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    !value.every((path) => typeof path === "string" && path.length > 0)
  ) {
    throw new ApiError(
      400,
      "invalid_payload",
      "outputs must contain workspace file paths",
    );
  }
  return value;
}

async function generationResult(operation: Promise<unknown>): Promise<unknown> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof Error && error.message === "artifact_origin_not_found")
      throw new ApiError(
        409,
        error.message,
        "This tool message has no managed file delivery run",
      );
    if (
      error instanceof Error &&
      error.message === "artifact_generation_not_found"
    )
      throw new ApiError(404, error.message, "File generation not found");
    throw error;
  }
}

/** 注册工作区内的交付查询、重启恢复与确认重试接口，沿用现有客户端权限。 */
export function registerFileDeliveryRoutes(
  options: FileDeliveryRouteOptions,
): void {
  const { routes, config, service, jsonResponse } = options;
  const base = "/workspace/:id/sessions/:sessionId/file-deliveries";
  const resolve = async (ctx: RequestContext) => {
    const workspace = await options.resolveWorkspace(config, ctx.params.id);
    if (workspace.workspaceType === "remote")
      throw new ApiError(
        400,
        "local_workspace_required",
        "Local workspace required",
      );
    return {
      workspace,
      sessionId: identifier(ctx.params.sessionId, "sessionId"),
    };
  };
  addRoute(
    routes,
    "POST",
    `${base}/generations/prepare`,
    "client",
    async (ctx) => {
      options.ensureWritable(config);
      options.requireClientScope(ctx, "collaborator");
      const { workspace, sessionId } = await resolve(ctx);
      const body = await options.readJsonBody(ctx.request);
      return jsonResponse(
        await generationResult(
          service.prepareGeneration(
            workspace.id,
            sessionId,
            identifier(body.messageId, "messageId"),
            outputPaths(body.outputs ?? []),
          ),
        ),
      );
    },
  );
  addRoute(
    routes,
    "POST",
    `${base}/generations/complete`,
    "client",
    async (ctx) => {
      options.ensureWritable(config);
      options.requireClientScope(ctx, "collaborator");
      const { workspace, sessionId } = await resolve(ctx);
      const body = await options.readJsonBody(ctx.request);
      if (body.exitCode !== null && !Number.isInteger(body.exitCode))
        throw new ApiError(400, "invalid_payload", "exitCode is required");
      return jsonResponse(
        await generationResult(
          service.completeGeneration(
            workspace.id,
            sessionId,
            identifier(body.generationId, "generationId"),
            body.exitCode as number | null,
          ),
        ),
      );
    },
  );
  addRoute(routes, "POST", `${base}/register`, "client", async (ctx) => {
    options.ensureWritable(config);
    options.requireClientScope(ctx, "collaborator");
    const { workspace, sessionId } = await resolve(ctx);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse(
      await generationResult(
        service.registerOutputs(
          workspace.id,
          sessionId,
          identifier(body.messageId, "messageId"),
          outputPaths(body.outputs),
        ),
      ),
    );
  });
  addRoute(routes, "GET", base, "client", async (ctx) => {
    const { workspace, sessionId } = await resolve(ctx);
    return jsonResponse(await service.list(workspace.id, sessionId));
  });
  addRoute(routes, "POST", `${base}/sync`, "client", async (ctx) => {
    options.ensureWritable(config);
    options.requireClientScope(ctx, "collaborator");
    const { workspace, sessionId } = await resolve(ctx);
    return jsonResponse(
      await service.synchronize(
        workspace.id,
        sessionId,
        await options.isIdle(workspace, sessionId),
      ),
    );
  });
  addRoute(routes, "POST", `${base}/retry`, "client", async (ctx) => {
    options.ensureWritable(config);
    options.requireClientScope(ctx, "collaborator");
    const { workspace, sessionId } = await resolve(ctx);
    if (!(await options.isIdle(workspace, sessionId)))
      throw new ApiError(
        409,
        "session_busy",
        "Wait for the active run to finish",
      );
    const { turnId } = await options.readJsonBody(ctx.request);
    if (
      !service
        .registry(workspace.id)
        .list(sessionId)
        .turns.some((turn) => turn.turnId === turnId)
    ) {
      throw new ApiError(
        404,
        "artifact_turn_not_found",
        "Turn delivery not found",
      );
    }
    return jsonResponse(
      await service.retry(
        workspace.id,
        sessionId,
        identifier(turnId, "turnId"),
      ),
    );
  });
}
