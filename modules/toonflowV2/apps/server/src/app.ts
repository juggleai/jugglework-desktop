import logger from "morgan";
import express from "express";
import cors from "cors";
import { resolve } from "node:path";
import type { Request, Response, NextFunction } from "express";
import buildRoute from "@/core";
import { error } from "@/lib/responseFormat";
import desktopRequest from "@/lib/desktop";
import { configureManagedResources, isManagedMode, managedGuard } from "@/lib/managed";
import initializePlugins from "@/utils/plugins/initialize";

const autoInstallProviders = ["tfRouter.ts"];

export async function createApp({
  webRoot,
  dataDirectory,
  toolsRoot,
  nodesRoot,
  providersRoot,
  skillsRoot,
  agentsRoot,
  resourcesRoot,
  manifestPath,
  pluginRevision,
  authorize,
}: {
  webRoot: string;
  dataDirectory?: string;
  toolsRoot?: string;
  nodesRoot?: string;
  providersRoot?: string;
  skillsRoot?: string;
  agentsRoot?: string;
  resourcesRoot?: string;
  manifestPath?: string;
  pluginRevision?: string;
  authorize?: import("express").RequestHandler;
}) {
  const managed = isManagedMode();
  // conf 由下方的路由动态加载，必须先确定整个进程共用的数据目录。
  if (dataDirectory) process.env.TOONFLOW_DATA_DIR = resolve(dataDirectory);
  const managedResources = managed && resourcesRoot && toolsRoot && nodesRoot && skillsRoot
    ? await configureManagedResources({ resourcesRoot, dataDirectory, toolsRoot, nodesRoot, skillsRoot, manifestPath, pluginRevision })
    : undefined;
  if (managed && !managedResources) throw new Error("managed 模式缺少构建资源目录");
  if (!managed && dataDirectory && toolsRoot)
    await initializePlugins(resolve(dataDirectory, "tools"), toolsRoot, /^[a-z][a-zA-Z0-9]*\.tool\.js$/, pluginRevision);
  if (!managed && dataDirectory && nodesRoot) await initializePlugins(resolve(dataDirectory, "nodes"), nodesRoot, /^[a-z][a-zA-Z0-9]*\.umd\.js$/, pluginRevision);
  // ACT: 供应方和技能可由用户编辑，只补首次安装，不随应用版本覆盖。
  if (!managed && dataDirectory && providersRoot)
    await initializePlugins(resolve(dataDirectory, "providers"), resolve(providersRoot, "media"), autoInstallProviders);
  if (!managed && dataDirectory && skillsRoot) await initializePlugins(resolve(dataDirectory, "skills"), skillsRoot);
  if (!managed && dataDirectory && agentsRoot) await initializePlugins(resolve(dataDirectory, "agents"), agentsRoot);
  const app = express();
  app.locals.managedResources = managedResources;
  if (authorize) app.use(authorize);
  app.use(managedGuard(managed));

  if (process.env.NODE_ENV === "dev") {
    await buildRoute();
    app.use(logger("dev"));
  }
  app.use(cors());
  if (!managed) app.use("/a2a", express.json({ limit: "2mb" }));
  app.use(["/api/workspaces/files/write", "/api/assets/save"], express.raw({ type: "application/octet-stream", limit: "100mb" }));
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));
  app.use("/api/desktop", desktopRequest);

  const { default: initializeProviderModels } = await import("@/utils/ai/initialize");
  if (!process.env.TOONFLOW_BRIDGE_URL) await initializeProviderModels();
  const router = await import("@/router");
  router.default(app);
  if (!managed) {
    const [{ createMcpRouter }, { getMcpTools }, { authorizeMcp }, { skillResources }] = await Promise.all([
      import("@toonflow/mcp"),
      import("@/utils/mcp/tools"),
      import("@/utils/mcp/control"),
      import("@/utils/mcp/resources"),
    ]);
    app.use("/mcp", createMcpRouter({ getTools: getMcpTools, authorize: authorizeMcp, resources: skillResources }));
    const { createA2aRouter } = await import("@/agent/a2a");
    app.use("/a2a", createA2aRouter());
  }
  app.use(express.static(webRoot));

  // 错误处理
  app.use((err: Error & { status?: number }, request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(err);
    console.error(err);
    const code = (err as NodeJS.ErrnoException).code;
    const status = err.status || ({ ENOENT: 404, ENOTDIR: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403, EPERM: 403 }[code ?? ""] ?? 500);
    const message =
      {
        ENOENT: "找不到这个文件或文件夹，可能已被移动、删除，或者位置选错了。",
        ENOTDIR: "你选中的是文件，但这里需要选择文件夹。请重新选择。",
        EEXIST: "这个名称已经被占用了，请换一个名称。原来的内容不会被覆盖。",
        ENOTEMPTY: "这个文件夹里还有内容，不能直接删除。请先清空或移走里面的文件。",
        EACCES: "没有权限访问这个文件或文件夹。请检查权限，或换一个位置重试。",
        EPERM: "系统不允许这次操作。文件可能正在被其他程序使用，请关闭后重试。",
        EISDIR: "你选中的是文件夹，但这里需要的是文件。请重新选择具体文件。",
      }[code ?? ""] ?? err.message;
    response.status(status).json(error(message, code ? { code } : null, status));
  });

  return app;
}
