import { homedir } from "node:os";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ApiError } from "../errors.js";
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
 * 登记固定文件助手 root，复用现有工作区配置、运行引擎及持久化。
 * @param config 当前 Server 的工作区配置
 * @param root 文件助手目录，默认位于用户文档目录
 */
export async function ensureFileAssistantWorkspace(config: ServerConfig, root = fileAssistantWorkspaceRoot()): Promise<WorkspaceInfo> {
  return ensureManagedWorkspace(config, root, "文件助手");
}

/** 每文件目录只使用固定长度 ASCII hash，不将原文件名拼入磁盘目录。 */
export function fileAssistantChildWorkspaceRoot(root: string, fileId: string): string {
  if (!/^[a-f0-9]{32}$/.test(fileId)) throw new Error("Invalid file assistant id");
  return join(root, "files", fileId);
}

export async function ensureFileAssistantFileWorkspace(config: ServerConfig, root: string, name: string): Promise<WorkspaceInfo> {
  const path = resolve(root), files = dirname(path), namespace = dirname(files);
  if (basename(files) !== "files" || !/^[a-f0-9]{32}$/.test(basename(path)) ||
      !config.workspaces.some((workspace) => workspace.id === workspaceIdForPath(namespace) &&
        workspace.workspaceType !== "remote" && workspace.fileAssistantManaged === true && resolve(workspace.path) === namespace)) {
    throw invalidManagedDirectory();
  }
  const validate = await managedDirectoryValidator(path, true);
  return ensureManagedWorkspace(config, path, name, validate);
}

/** 冷恢复只检查已有目录，不创建目录、初始化工作区或写入配置。 */
export async function validateFileAssistantFileWorkspace(root: string): Promise<void> {
  const validate = await managedDirectoryValidator(resolve(root), false);
  await validate();
}

async function managedDirectoryValidator(path: string, create: boolean): Promise<() => Promise<void>> {
  const files = dirname(path), namespace = dirname(files);
  if (basename(files) !== "files" || !/^[a-f0-9]{32}$/.test(basename(path))) throw invalidManagedDirectory();
  // 信任用户选定 root 的真实位置，保留原路径和旧 ID；只禁止其内部受管目录跳转。
  const canonicalRoot = await realpath(namespace);
  const canonicalFiles = join(canonicalRoot, "files"), canonicalChild = join(canonicalFiles, basename(path));
  const validateRoot = async () => {
    if (!sameDirectory(await realpath(namespace), canonicalRoot)) throw invalidManagedDirectory();
  };
  await validateRoot();
  await inspectManagedDirectory(files, canonicalFiles, create);
  await validateRoot();
  await inspectManagedDirectory(path, canonicalChild, create);
  const validate = async () => {
    await validateRoot();
    await inspectManagedDirectory(files, canonicalFiles);
    await inspectManagedDirectory(path, canonicalChild);
  };
  return validate;
}

function invalidManagedDirectory(): ApiError {
  return new ApiError(409, "file_assistant_directory_invalid", "文件助手目录必须是独立的受管目录，不能使用符号链接或目录联接");
}

function sameDirectory(actual: string, expected: string): boolean {
  return process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

/** mkdir 前后均 lstat；Windows junction 同样由 isSymbolicLink 拒绝。 */
async function inspectManagedDirectory(path: string, canonical: string, create = false): Promise<void> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // 不递归创建：父目录已经校验，写入固定 canonical 路径，避免跟随原路径的跳转。
    try { await mkdir(canonical); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory() || !sameDirectory(await realpath(path), canonical)) {
    throw invalidManagedDirectory();
  }
}

async function ensureManagedWorkspace(config: ServerConfig, root: string, name: string, validate?: () => Promise<void>): Promise<WorkspaceInfo> {
  const path = resolve(root), id = workspaceIdForPath(path);
  const existing = config.workspaces.find((workspace) => workspace.id === id && workspace.workspaceType !== "remote");
  if (validate && existing && resolve(existing.path) !== path) throw invalidManagedDirectory();
  await validate?.();
  await ensureWorkspaceFiles(path, "starter");
  await validate?.();
  await seedJuggleWorkWorkspaceConfigIfEmpty(config, id, defaultWorkspaceJuggleWorkConfig(path, "starter"));
  const workspace: WorkspaceInfo = existing ?? { id, path, name, preset: "starter", workspaceType: "local" };
  const marker = workspace.fileAssistantManaged;
  workspace.fileAssistantManaged = true;
  if (!existing) config.workspaces.push(workspace);
  const authorized = config.authorizedRoots.includes(path);
  if (!authorized) config.authorizedRoots.push(path);
  try {
    if (!existing || !authorized || marker !== true) await persistServerWorkspaceState(config);
  } catch (error) {
    // 仅撤销本次登记，保留既有工作区、授权及 DB 配置，确保重试仍会持久化。
    if (!existing) {
      const index = config.workspaces.indexOf(workspace);
      if (index !== -1) config.workspaces.splice(index, 1);
    }
    if (!authorized) {
      const index = config.authorizedRoots.indexOf(path);
      if (index !== -1) config.authorizedRoots.splice(index, 1);
    }
    if (marker === undefined) delete workspace.fileAssistantManaged;
    else workspace.fileAssistantManaged = marker;
    throw error;
  }
  return workspace;
}
