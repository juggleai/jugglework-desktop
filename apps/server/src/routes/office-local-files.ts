import type { LocalOfficeFiles } from "../office/local-files.js";
import type { OfficeDocuments } from "../office/documents.js";
import type { WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import { addRoute, type Route } from "./registry.js";

/** 登记入口仅接受宿主令牌；读取入口只匹配本次生成的明确文件上下文。 */
export function registerLocalOfficeRoutes(options: {
  routes: Route[];
  files: LocalOfficeFiles;
  documents: OfficeDocuments;
  jsonResponse: (value: unknown) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: () => void;
  workspaceById: (id: string) => WorkspaceInfo | undefined;
  /** 将外部文件绑定到自己的 child 工作区中的真实会话。 */
  ensureConversation: (binding: { workspaceId: string; workspaceRoot: string; sessionId?: string }, name: string) => Promise<string>;
}): void {
  const { routes, files, documents, jsonResponse } = options;
  addRoute(routes, "POST", "/office/local-files/resolve", "client", async (ctx) => {
    const body = await options.readJsonBody(ctx.request);
    if (typeof body.workspaceRoot !== "string" || !body.workspaceRoot.trim() || typeof body.path !== "string")
      throw new ApiError(400, "invalid_path", "文件来源不可用");
    await files.load();
    const workspaceId = files.workspaceIdForRoot(body.workspaceRoot);
    if (!workspaceId) return jsonResponse({ absolutePath: null });
    const original = await files.resolve(workspaceId, body.path);
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
      const binding = await files.bindingFor(path);
      const resolved = await files.resolve(binding.workspaceId, path);
      // TIPS: 系统入口沿用存活模型的真实归属，不能把聊天模型复制进本机上下文。
      const existing = await documents.findByAbsolutePath(
        resolved.absolutePath,
      );
      if (existing) {
        const workspace = options.workspaceById(existing.workspaceId);
        if (!workspace) throw new ApiError(404, "workspace_not_found", "文档所属工作区不可用");
        const local = workspace.fileAssistantManaged === true || files.owns(workspace.id);
        return jsonResponse({
          workspaceId: existing.workspaceId, sessionId: existing.ownerSessionId,
          workspaceRoot: workspace.path, path: existing.relativePath, local,
          absolutePath: resolved.absolutePath,
          group: local ? { kind: "file-assistant" } : { kind: "conversation", workspaceId: existing.workspaceId, sessionId: existing.ownerSessionId },
        });
      }
      const sessionId = await options.ensureConversation(binding, resolved.file.name);
      await files.bindSession(binding.workspaceId, path, sessionId);
      return jsonResponse({
        workspaceId: binding.workspaceId,
        workspaceRoot: binding.workspaceRoot,
        sessionId,
        path,
        local: true,
        absolutePath: resolved.absolutePath,
        group: { kind: "file-assistant" },
      });
    },
  );
}
