import type { LocalOfficeFiles } from "../office/local-files.js";
import type { OfficeDocuments } from "../office/documents.js";
import { ApiError } from "../errors.js";
import { resolve } from "node:path";
import { addRoute, type Route } from "./registry.js";

/** 登记入口仅接受宿主令牌；读取入口只匹配本次生成的明确文件上下文。 */
export function registerLocalOfficeRoutes(options: {
  routes: Route[];
  files: LocalOfficeFiles;
  documents: OfficeDocuments;
  jsonResponse: (value: unknown) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: () => void;
  /** 将外部文件绑定到默认工作区中的真实会话。 */
  ensureConversation: (previousSessionId?: string) => Promise<string>;
}): void {
  const { routes, files, documents, jsonResponse } = options;
  addRoute(routes, "POST", "/office/local-files/resolve", "client", async (ctx) => {
    const body = await options.readJsonBody(ctx.request);
    if (typeof body.workspaceRoot !== "string" || !body.workspaceRoot.trim() || typeof body.path !== "string")
      throw new ApiError(400, "invalid_path", "文件来源不可用");
    // TIPS: 其他工作区仍使用普通磁盘路径；默认文件助手的保留标识只能解析已登记原件，不能回退到虚拟目录。
    if (resolve(body.workspaceRoot) !== files.root) return jsonResponse({ absolutePath: null });
    const original = await files.resolve(body.path);
    return jsonResponse({ absolutePath: original.absolutePath });
  });
  addRoute(
    routes,
    "POST",
    "/office/local-files/open",
    "host-token",
    async (ctx) => {
      options.ensureWritable();
      const body = await options.readJsonBody(ctx.request);
      if (typeof body.path !== "string")
        throw new ApiError(400, "invalid_path", "请选择文件");
      const path = await files.register(body.path);
      const resolved = await files.resolve(path);
      // TIPS: 系统入口沿用存活模型的真实归属，不能把聊天模型复制进本机上下文。
      const existing = await documents.findByAbsolutePath(
        resolved.absolutePath,
      );
      const sessionId = existing?.ownerSessionId ?? await options.ensureConversation(await files.sessionFor(path));
      if (!existing) await files.bindSession(path, sessionId);
      return jsonResponse(
        existing
          ? {
              workspaceId: existing.workspaceId,
              sessionId: existing.ownerSessionId,
              path: existing.relativePath,
              local: files.owns(existing.workspaceId),
              absolutePath: resolved.absolutePath,
            }
          : {
              workspaceId: files.id,
              sessionId,
              path,
              local: true,
              absolutePath: resolved.absolutePath,
            },
      );
    },
  );
}
