import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { workspaceIdForPath } from "../workspaces.js";
import { ensureWorkspaceFiles, defaultWorkspaceJuggleWorkConfig } from "../workspace-init.js";
import { seedJuggleWorkWorkspaceConfigIfEmpty } from "../jugglework-workspace-config-store.js";
import { persistServerWorkspaceState } from "../routes/workspaces.js";

/** 文件助手默认目录；隔离验收可显式指定临时目录，不修改用户文件。 */
export function fileAssistantWorkspaceRoot(): string {
  return resolve(process.env.JUGGLEWORK_FILE_ASSISTANT_ROOT?.trim() || join(homedir(), "Documents", "JuggleWork", "FileAssistant"));
}

/**
 * 登记唯一默认工作区，复用现有工作区配置、运行引擎及持久化。
 * @param config 当前 Server 的工作区配置
 * @param root 文件助手目录，默认位于用户文档目录
 */
export async function ensureFileAssistantWorkspace(config: ServerConfig, root = fileAssistantWorkspaceRoot()): Promise<WorkspaceInfo> {
  const path = resolve(root), id = workspaceIdForPath(path);
  const existing = config.workspaces.find((workspace) => workspace.id === id && workspace.workspaceType !== "remote");
  await ensureWorkspaceFiles(path, "starter");
  await seedJuggleWorkWorkspaceConfigIfEmpty(config, id, defaultWorkspaceJuggleWorkConfig(path, "starter"));
  const workspace: WorkspaceInfo = existing ?? { id, path, name: "文件助手", preset: "starter", workspaceType: "local" };
  if (!existing) config.workspaces.push(workspace);
  const authorized = config.authorizedRoots.includes(path);
  if (!authorized) config.authorizedRoots.push(path);
  if (!existing || !authorized) await persistServerWorkspaceState(config);
  return workspace;
}
