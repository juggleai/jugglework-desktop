import type { OfficeDocuments } from "../office/documents.js";
import type { LocalOfficeFiles } from "../office/local-files.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

interface OfficeRouteOptions {
  routes: Route[];
  config: ServerConfig;
  documents: OfficeDocuments;
  localFiles?: LocalOfficeFiles;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (
    config: ServerConfig,
    id: string,
  ) => Promise<WorkspaceInfo>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(400, "invalid_payload", `${name} is required`);
  return value;
}

/** 本机 Office 编辑接口；保存不接受目标路径，关闭必须提供用户决定。 */
export function registerOfficeRoutes(options: OfficeRouteOptions): void {
  const { routes, config, documents, jsonResponse } = options;
  const base = "/workspace/:id/office";
  const workspace = async (ctx: RequestContext, write = false) => {
    if (write) {
      options.ensureWritable(config);
      options.requireClientScope(ctx, "collaborator");
    }
    if (options.localFiles?.owns(ctx.params.id)) {
      // TIPS: 本机上下文只供编辑器生命周期使用，不成为 Agent 的工作区或工具目标。
      if (
        ["tools", "call", "create"].includes(
          ctx.url.pathname.split("/").at(-1) ?? "",
        )
      )
        throw new ApiError(
          400,
          "local_file_operation_unavailable",
          "此操作需要聊天工作区",
        );
      return { id: ctx.params.id };
    }
    const result = await options.resolveWorkspace(config, ctx.params.id);
    if (result.workspaceType === "remote")
      throw new ApiError(
        400,
        "local_workspace_required",
        "Office 仅支持本机工作区",
      );
    return result;
  };
  addRoute(routes, "GET", `${base}/capabilities`, "client", async (ctx) => {
    const target = await workspace(ctx);
    return jsonResponse(
      config.readOnly
        ? { available: false, formats: [], reason: "当前服务端为只读" }
        : await documents.capabilities(),
    );
  });
  addRoute(routes, "GET", "/office/documents", "client", async () =>
    jsonResponse({ items: await documents.list() }),
  );
  addRoute(
    routes,
    "POST",
    "/office/check-copy-target",
    "client",
    async (ctx) => {
      const body = await options.readJsonBody(ctx.request);
      await documents.assertCopyTargetAllowed(text(body.path, "path"));
      return jsonResponse({ ok: true });
    },
  );
  addRoute(routes, "GET", `${base}/current`, "client", async (ctx) => {
    const target = await workspace(ctx);
    return jsonResponse(
      await documents.context(
        target.id,
        text(ctx.url.searchParams.get("sessionId"), "sessionId"),
      ),
    );
  });
  addRoute(routes, "GET", `${base}/by-path`, "client", async (ctx) => {
    const target = await workspace(ctx);
    return jsonResponse({
      document: await documents.find(
        target.id,
        text(ctx.url.searchParams.get("sessionId"), "sessionId"),
        text(ctx.url.searchParams.get("path"), "path"),
      ),
    });
  });
  addRoute(routes, "GET", `${base}/tools`, "client", async (ctx) => {
    const target = await workspace(ctx);
    return jsonResponse(
      await documents.tools(
        target.id,
        text(ctx.url.searchParams.get("sessionId"), "sessionId"),
        ctx.url.searchParams.get("name") ?? undefined,
        ctx.url.searchParams.get("messageId") ?? undefined,
        ctx.url.searchParams.get("selectionRef") ?? undefined,
      ),
    );
  });
  addRoute(routes, "POST", `${base}/call`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    if (!body.args || typeof body.args !== "object" || Array.isArray(body.args))
      throw new ApiError(400, "invalid_payload", "args 必须是对象");
    return jsonResponse(
      await documents.call(
        target.id,
        text(body.sessionId, "sessionId"),
        text(body.messageId, "messageId"),
        text(body.name, "name"),
        body.args as Record<string, unknown>,
        body.selectionRef === undefined ? undefined : text(body.selectionRef, "selectionRef"),
      ),
    );
  });
  addRoute(routes, "GET", `${base}/selection`, "client", async (ctx) => {
    const target = await workspace(ctx);
    return jsonResponse(await documents.selectionContext(target.id,
      text(ctx.url.searchParams.get("sessionId"), "sessionId"),
      text(ctx.url.searchParams.get("messageId"), "messageId")));
  });
  addRoute(routes, "POST", `${base}/save-for-actor`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse(await documents.saveForActor(target.id, text(body.sessionId, "sessionId"),
      text(body.messageId, "messageId"), body.selectionRef === undefined ? undefined : text(body.selectionRef, "selectionRef")));
  });
  addRoute(routes, "POST", `${base}/selection-references/release`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    if (!Array.isArray(body.referenceIds) || body.referenceIds.length > 64 || body.referenceIds.some((id) => typeof id !== "string"))
      throw new ApiError(400, "invalid_payload", "referenceIds 必须是选区身份列表");
    documents.selections.release(target.id, text(body.sessionId, "sessionId"), body.referenceIds);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", `${base}/selection-references/reveal`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse({ reference: await documents.selections.reveal(target.id, text(body.sessionId, "sessionId"), text(body.referenceId, "referenceId")) });
  });
  addRoute(routes, "POST", `${base}/selection-references/validate`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    if (!Array.isArray(body.referenceIds) || body.referenceIds.length > 16 || body.referenceIds.some((id) => typeof id !== "string"))
      throw new ApiError(400, "invalid_payload", "referenceIds 必须是选区身份列表");
    await documents.selections.validate(target.id, text(body.sessionId, "sessionId"), body.referenceIds);
    return jsonResponse({ ok: true });
  });
  const captureSelection = async (ctx: RequestContext, reviewed: boolean) => {
    const target = await workspace(ctx, true);
    if (options.localFiles?.owns(target.id)) throw new ApiError(409, "office_chat_required", "请先将文档添加到目标聊天，再使用 AI 编辑");
    const body = await options.readJsonBody(ctx.request);
    // 核对权限只来自 host-token 路由，普通 client 不能用公开 generation 自报确认。
    if (Object.hasOwn(body, "reviewedUnconfirmed") || (!reviewed && Object.hasOwn(body, "expectedGeneration")))
      throw new ApiError(400, "invalid_payload", "采集不接受人工核对标记");
    if (reviewed && (typeof body.expectedGeneration !== "string" || !body.expectedGeneration.trim()))
      throw new ApiError(400, "invalid_payload", "人工核对需要 expectedGeneration");
    const document = await documents.get(target.id, ctx.params.documentId);
    if (document.ownerSessionId !== text(body.sessionId, "sessionId")) throw new ApiError(409, "office_wrong_document", "选区不属于当前聊天");
    if (reviewed && (document.state !== "ready" || !document.engineFileId || body.expectedGeneration !== `${document.pageId}:${document.engineFileId}`))
      throw new ApiError(409, "office_selection_stale", "核对期间文档模型已变化，请重新选择");
    documents.updateContext(target.id, document.documentId, text(body.pageId, "pageId"));
    return jsonResponse({ reference: await documents.selections.capture(document, text(body.captureId, "captureId"), body.expectedSelection, reviewed) });
  };
  addRoute(routes, "POST", `${base}/:documentId/selection-references`, "client", (ctx) => captureSelection(ctx, false));
  addRoute(routes, "POST", `${base}/:documentId/selection-references/review-confirmed`, "host-token", (ctx) => captureSelection(ctx, true));
  addRoute(routes, "POST", `${base}/open`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse({
      document: await documents.open(
        target.id,
        text(body.sessionId, "sessionId"),
        text(body.path, "path"),
        false,
        body.activate !== false,
      ),
    });
  });
  addRoute(routes, "POST", `${base}/check-open-target`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse(await documents.checkOpenTarget(target.id, text(body.sessionId, "sessionId"), text(body.path, "path")));
  });
  addRoute(routes, "POST", `${base}/create`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    const sessionId = text(body.sessionId, "sessionId");
    const document = await documents.create(
      target.id,
      sessionId,
      text(body.path, "path"),
    );
    return jsonResponse({ document });
  });
  addRoute(routes, "POST", `${base}/prepare-file`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    const sessionId = text(body.sessionId, "sessionId");
    const path = text(body.path, "path");
    if (body.external === true)
      return jsonResponse({
        ok: true,
        document: await documents.external(target.id, sessionId, path),
      });
    await documents.prepareFile(target.id, sessionId, path);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", `${base}/reopen`, "client", async (ctx) => {
    const target = await workspace(ctx, true);
    const body = await options.readJsonBody(ctx.request);
    return jsonResponse({
      document: await documents.reopen(
        target.id,
        text(body.sessionId, "sessionId"),
        text(body.path, "path"),
      ),
    });
  });
  addRoute(routes, "GET", `${base}/:documentId`, "client", async (ctx) => {
    const target = await workspace(ctx);
    return jsonResponse({
      document: await documents.get(target.id, ctx.params.documentId),
    });
  });
  addRoute(
    routes,
    "POST",
    `${base}/:documentId/context`,
    "client",
    async (ctx) => {
      const target = await workspace(ctx, true);
      const body = await options.readJsonBody(ctx.request);
      documents.updateContext(
        target.id,
        ctx.params.documentId,
        text(body.pageId, "pageId"),
        body.activate === true,
      );
      return jsonResponse({ ok: true });
    },
  );
  addRoute(
    routes,
    "GET",
    `${base}/:documentId/transfer-status`,
    "client",
    async (ctx) => {
      const target = await workspace(ctx);
      return jsonResponse(
        await documents.transferStatus(target.id, ctx.params.documentId),
      );
    },
  );
  addRoute(
    routes,
    "POST",
    `${base}/:documentId/page-failed`,
    "client",
    async (ctx) => {
      const target = await workspace(ctx, true);
      return jsonResponse({
        document: documents.failPage(target.id, ctx.params.documentId),
      });
    },
  );
  addRoute(
    routes,
    "POST",
    `${base}/:documentId/recover`,
    "client",
    async (ctx) => {
      const target = await workspace(ctx, true);
      return jsonResponse({
        document: await documents.recover(target.id, ctx.params.documentId),
      });
    },
  );
  addRoute(
    routes,
    "POST",
    `${base}/:documentId/save`,
    "client",
    async (ctx) => {
      const target = await workspace(ctx, true);
      const body = await options.readJsonBody(ctx.request);
      if (Object.keys(body).length)
        throw new ApiError(400, "invalid_payload", "保存不接受替代路径或格式");
      return jsonResponse({
        document: await documents.save(target.id, ctx.params.documentId, true),
      });
    },
  );
  addRoute(
    routes,
    "POST",
    `${base}/:documentId/close`,
    "client",
    async (ctx) => {
      const target = await workspace(ctx, true);
      const body = await options.readJsonBody(ctx.request);
      if (!["save", "discard", "cancel"].includes(String(body.decision)))
        throw new ApiError(
          400,
          "invalid_payload",
          "关闭需要保存、放弃或取消决定",
        );
      return jsonResponse({
        document: await documents.close(
          target.id,
          ctx.params.documentId,
          body.decision as "save" | "discard" | "cancel",
        ),
      });
    },
  );
}
