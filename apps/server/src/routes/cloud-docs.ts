import type { CloudDocsService } from "../cloud-docs/service.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

interface CloudDocsRouteOptions {
  routes: Route[];
  config: ServerConfig;
  service: CloudDocsService;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ApiError(400, "invalid_payload", `${name} is invalid`);
  return value;
}

/** 云文档工具与变更卡片使用的接口；写入范围始终由本轮消息登记的引用决定。 */
export function registerCloudDocsRoutes(options: CloudDocsRouteOptions): void {
  const { routes, config, service, jsonResponse } = options;
  const base = "/workspace/:id/cloud-docs";
  const local = async (ctx: RequestContext, write = false) => {
    if (write) {
      options.ensureWritable(config);
      options.requireClientScope(ctx, "collaborator");
    }
    const workspace = await options.resolveWorkspace(config, ctx.params.id);
    if (workspace.workspaceType === "remote")
      throw new ApiError(400, "local_workspace_required", "云文档工具仅支持本机工作区");
    return workspace;
  };
  const turn = (workspaceId: string, source: URLSearchParams | Record<string, unknown>) => {
    const get = (name: string) => source instanceof URLSearchParams ? source.get(name) : source[name];
    return { workspaceId, sessionId: text(get("sessionId"), "sessionId"), messageId: text(get("messageId"), "messageId") };
  };
  addRoute(routes, "GET", `${base}/context`, "client", async ctx => {
    const workspace = await local(ctx);
    return jsonResponse(service.context(turn(workspace.id, ctx.url.searchParams)));
  });
  addRoute(routes, "GET", `${base}/search`, "client", async ctx => {
    const workspace = await local(ctx);
    const limit = Number(ctx.url.searchParams.get("limit")) || undefined;
    return jsonResponse(await service.search(turn(workspace.id, ctx.url.searchParams), text(ctx.url.searchParams.get("q"), "q", 200), limit));
  });
  addRoute(routes, "GET", `${base}/read`, "client", async ctx => {
    const workspace = await local(ctx);
    const query = ctx.url.searchParams;
    const blockIds = query.get("blockIds")?.split(",").filter(Boolean);
    return jsonResponse(await service.read(turn(workspace.id, query), {
      workspaceId: text(query.get("workspaceId"), "workspaceId"),
      docId: text(query.get("docId"), "docId"),
      mode: query.get("mode") ?? undefined,
      blockIds,
    }));
  });
  addRoute(routes, "POST", `${base}/edit`, "client", async ctx => {
    const workspace = await local(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    if (!Array.isArray(body.operations)) throw new ApiError(400, "invalid_payload", "operations is required");
    return jsonResponse(await service.edit(turn(workspace.id, body), {
      workspaceId: text(body.workspaceId, "workspaceId"),
      docId: text(body.docId, "docId"),
      operations: body.operations as never,
    }));
  });
  addRoute(routes, "POST", `${base}/create`, "client", async ctx => {
    const workspace = await local(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse(await service.create(turn(workspace.id, body), {
      title: text(body.title, "title", 200),
      markdown: typeof body.markdown === "string" ? body.markdown : "",
    }));
  });
  addRoute(routes, "POST", `${base}/import`, "client", async ctx => {
    const workspace = await local(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse(await service.importFile(turn(workspace.id, body), {
      localWorkspaceId: workspace.id,
      path: text(body.path, "path", 1024),
    }));
  });
  addRoute(routes, "GET", `${base}/session-changes`, "client", async ctx => {
    const workspace = await local(ctx);
    return jsonResponse(service.sessionChanges(workspace.id, text(ctx.url.searchParams.get("sessionId"), "sessionId")));
  });
  addRoute(routes, "GET", `${base}/changes`, "client", async ctx => {
    const workspace = await local(ctx);
    return jsonResponse(service.changes(turn(workspace.id, ctx.url.searchParams)));
  });
  addRoute(routes, "POST", `${base}/undo`, "client", async ctx => {
    const workspace = await local(ctx, true);
    return jsonResponse(await service.undo(turn(workspace.id, await options.readJsonBody(ctx.request))));
  });
}
