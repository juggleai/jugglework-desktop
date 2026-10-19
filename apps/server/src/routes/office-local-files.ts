import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { LocalOfficeFiles } from "../office/local-files.js";
import type { OfficeDocuments } from "../office/documents.js";
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
}): void {
  const { routes, files, documents, jsonResponse } = options;
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
              sessionId: files.sessionId,
              path,
              local: true,
              absolutePath: resolved.absolutePath,
            },
      );
    },
  );
  // TIPS: 在通用工作区路由之前注册精确上下文路径，不扩展工作区解析或目录权限。
  const base = `/workspace/${files.id}/files`;
  addRoute(routes, "GET", `${base}/stat`, "client", async (ctx) => {
    const { file } = await files.resolve(
      ctx.url.searchParams.get("path") ?? "",
    );
    return jsonResponse({
      ok: true,
      path: file.relativePath,
      exists: true,
      kind: "file",
      size: file.sizeBytes,
      updatedAt: file.updatedAt,
    });
  });
  addRoute(routes, "GET", `${base}/raw`, "client", async (ctx) => {
    const { absolutePath, file } = await files.resolve(
      ctx.url.searchParams.get("path") ?? "",
    );
    const body = Readable.toWeb(
      createReadStream(absolutePath),
    ) as unknown as ReadableStream;
    return new Response(body, {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.sizeBytes),
      },
    });
  });
}
