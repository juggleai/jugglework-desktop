import {
  resolveWorkspaceListSelectedId,
  workspaceCreate,
  type WorkspaceInfo,
  type WorkspaceList,
} from "./desktop";
import type { JuggleWorkServerClient } from "./jugglework-server";
import { isDesktopRuntime } from "../utils";

export type LocalWorkspaceCreateInput = {
  folderPath: string;
  name: string;
  preset: string;
};

export type LocalWorkspaceCreateResult = {
  workspaceId: string;
  workspace: WorkspaceInfo;
  list: WorkspaceList;
};

type LocalWorkspaceCreateDependencies = {
  isDesktopRuntime: () => boolean;
  workspaceCreate: typeof workspaceCreate;
};

const defaultDependencies: LocalWorkspaceCreateDependencies = {
  isDesktopRuntime,
  workspaceCreate,
};

/**
 * 创建本地工作区，并在桌面运行时同步 Electron 工作区注册表。
 * @param client JuggleWork Server 客户端，负责创建权威工作区记录
 * @param input 本地工作区路径、名称和预设
 * @param dependencies 可替换的桌面依赖，仅用于隔离测试
 * @returns 服务端返回的权威工作区、工作区 ID 和列表
 */
export async function createLocalWorkspaceForRuntime(
  client: Pick<JuggleWorkServerClient, "createLocalWorkspace">,
  input: LocalWorkspaceCreateInput,
  dependencies: LocalWorkspaceCreateDependencies = defaultDependencies,
): Promise<LocalWorkspaceCreateResult> {
  const list = await client.createLocalWorkspace(input);
  const workspaceId =
    resolveWorkspaceListSelectedId(list) ||
    list.workspaces[list.workspaces.length - 1]?.id ||
    "";
  const workspace = list.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;

  if (!workspaceId || !workspace) {
    throw new Error("JuggleWork server did not return the created workspace.");
  }

  if (dependencies.isDesktopRuntime()) {
    // TIPS: Server-first 可确保 Electron 使用完全相同的 ID；桌面同步失败时
    // 不发布选择状态，重试会通过两侧现有的 path/ID upsert 安全收敛。
    const desktopList = await dependencies.workspaceCreate({
      ...input,
      workspaceId,
    });
    if (!desktopList.workspaces.some((candidate) => candidate.id === workspaceId)) {
      throw new Error("Desktop workspace registration did not preserve the server workspace ID.");
    }
  }

  return { workspaceId, workspace, list };
}
