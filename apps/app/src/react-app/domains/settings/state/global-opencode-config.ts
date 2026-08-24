import { readOpencodeConfig, writeOpencodeConfig } from "@/app/lib/desktop";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { isDesktopRuntime } from "@/app/utils";

/**
 * 全局 OpenCode 配置的读写目标
 * @param juggleworkClient JuggleWork Server 客户端，远程工作区与托管运行时走该链路
 * @param workspaceId 运行时工作区 ID，仅用于定位配置文件读写入口，不参与作用域划分
 * @param workspaceRoot 本地工作区根目录，桌面端直接读写文件时使用
 * @param isLocalWorkspace 当前工作区是否为本地工作区
 *
 * TIPS: "全局"的边界是当前运行环境的 `OPENCODE_CONFIG_DIR`，不是某个工作区。
 * 这里仍需要 workspaceId 只是因为服务端把配置文件读写挂在工作区路由下；对远程
 * 工作区而言，全局指的是服务端主机的全局目录，所以必须优先走服务端链路。
 */
export type GlobalConfigTarget = {
  juggleworkClient: JuggleWorkServerClient | null;
  workspaceId: string;
  workspaceRoot: string;
  isLocalWorkspace: boolean;
};

export const EMPTY_OPENCODE_CONFIG = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

/** 读取全局 OpenCode 配置内容。运行环境不支持读取时返回 null。 */
export async function readGlobalOpencodeConfig(
  target: GlobalConfigTarget,
): Promise<string | null> {
  const workspaceId = target.workspaceId.trim();
  if (target.juggleworkClient && workspaceId) {
    const file = await target.juggleworkClient.readOpencodeConfigFile(workspaceId, "global");
    return file?.content ?? "";
  }
  const root = target.workspaceRoot.trim();
  if (target.isLocalWorkspace && isDesktopRuntime() && root) {
    const file = await readOpencodeConfig("global", root);
    return file?.content ?? "";
  }
  return null;
}

/** 写入全局 OpenCode 配置内容。运行环境不支持写入时抛错。 */
export async function writeGlobalOpencodeConfig(
  target: GlobalConfigTarget,
  content: string,
): Promise<void> {
  const workspaceId = target.workspaceId.trim();
  if (target.juggleworkClient && workspaceId) {
    const result = await target.juggleworkClient.writeOpencodeConfigFile(
      workspaceId,
      "global",
      content,
    ) as { ok: boolean; stderr?: string; stdout?: string };
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "Failed to write global opencode config");
    }
    return;
  }
  const root = target.workspaceRoot.trim();
  if (target.isLocalWorkspace && isDesktopRuntime() && root) {
    const result = await writeOpencodeConfig("global", root, content) as {
      ok: boolean;
      stderr?: string;
      stdout?: string;
    };
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "Failed to write global opencode config");
    }
    return;
  }
  throw new Error("Global opencode config is not writable in this runtime.");
}
