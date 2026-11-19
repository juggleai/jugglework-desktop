import { ApiError } from "../errors.js";
import type { NativeActionsService } from "../native-actions/service.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type Route } from "./registry.js";

interface NativeActionRouteOptions {
  routes: Route[];
  config: ServerConfig;
  service: NativeActionsService;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  /** Resolves the engine assistant message to its real user turn. */
  resolveTurn: (workspaceId: string, sessionId: string, messageId: string) => Promise<string | null>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new ApiError(400, "invalid_payload", `${name} is invalid`);
  return value;
}

/**
 * Read-only native queries for conversation tools. The calling session and
 * message decide the identity; no request field can choose an organization,
 * account, server address or API path.
 */
export function registerNativeActionRoutes(options: NativeActionRouteOptions): void {
  const { routes, config, service, jsonResponse } = options;
  const toolTurn = async (workspaceId: string, body: Record<string, unknown>) => {
    const sessionId = text(body.sessionId, "sessionId");
    const messageId = await options.resolveTurn(workspaceId, sessionId, text(body.messageId, "messageId"));
    // TIPS: 不取最近一条消息或当前前台窗口，避免其他轮次或会话借用登录身份。
    if (!messageId) throw new ApiError(409, "native_action_turn_unavailable", "尚未确认本轮消息归属，请稍后重试");
    return { workspaceId, sessionId, messageId };
  };
  const local = async (id: string) => {
    const workspace = await options.resolveWorkspace(config, id);
    if (workspace.workspaceType === "remote")
      throw new ApiError(400, "local_workspace_required", "原生能力仅支持本机工作区");
    return workspace;
  };
  addRoute(routes, "POST", "/workspace/:id/native-actions/product-tasks", "client", async (ctx) => {
    const workspace = await local(ctx.params.id);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse(await service.listProductTasks(await toolTurn(workspace.id, body), body.args));
  });
  addRoute(routes, "POST", "/workspace/:id/native-actions/contacts", "client", async (ctx) => {
    const workspace = await local(ctx.params.id);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse(await service.searchContacts(await toolTurn(workspace.id, body), body.args));
  });
}
