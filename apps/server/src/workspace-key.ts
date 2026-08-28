/**
 * 工作区键（workspaceKey）：发给 JuggleWork Cloud 的稳定、不透明的工作区标识。
 *
 * 云端用它把「哪些组织 MCP 连接在这个工作区生效」的策略挂到成员身上，并写进
 * 每个 MCP 令牌。对云端而言这个值没有结构，只做等值匹配。
 *
 * 设计约束：
 * - 用 workspace.id 而非目录路径派生：移动目录不应重置该工作区的策略。
 * - 混入本机 install id：不同机器上的同名工作区互不干扰，也避免把本地路径信息带上云。
 * - 一次生成后持久化：重算规则变化不会让已有策略失配。
 */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { runtimeStorageDir } from "./runtime-db.js";
import {
  readJuggleWorkWorkspaceConfig,
  writeJuggleWorkWorkspaceConfig,
} from "./jugglework-workspace-config-store.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

const INSTALL_ID_FILE = "install-id";
const WORKSPACE_KEY_FIELD = "workspaceKey";
/** 与云端 `mcp_access_tokens.workspace_key` / `external_mcp_workspace_policies.workspace_key` 的列宽对齐。 */
export const MAX_WORKSPACE_KEY_LENGTH = 128;

const installIdByPath = new Map<string, Promise<string>>();

function installIdPath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), INSTALL_ID_FILE);
}

function normalizeInstallId(value: string): string {
  const trimmed = value.trim();
  return /^[0-9a-zA-Z-]{8,64}$/.test(trimmed) ? trimmed : "";
}

async function loadInstallId(path: string): Promise<string> {
  try {
    const existing = normalizeInstallId(await readFile(path, "utf8"));
    if (existing) return existing;
  } catch {
    // Missing or unreadable — fall through and mint a fresh id.
  }
  const created = randomUUID();
  try {
    await ensureDir(join(path, ".."));
    await writeFile(path, created, "utf8");
  } catch {
    // A read-only runtime dir still yields a usable (process-lifetime) id; the
    // workspace key it derives is persisted per workspace anyway.
  }
  return created;
}

/**
 * 本机安装标识，首次调用时生成并落盘。
 *
 * @param config 服务端配置
 * @returns 稳定的安装标识
 */
export async function readInstallId(config: ServerConfig): Promise<string> {
  const path = installIdPath(config);
  const existing = installIdByPath.get(path);
  if (existing) return existing;
  const pending = loadInstallId(path);
  installIdByPath.set(path, pending);
  return pending;
}

export function resetInstallIdCacheForTests(): void {
  installIdByPath.clear();
}

/**
 * 从工作区 id 与安装标识派生工作区键。
 *
 * @param workspaceId 工作区 id
 * @param installId 本机安装标识
 * @returns `ws_` 前缀的 32 位十六进制标识
 */
export function deriveWorkspaceKey(workspaceId: string, installId: string): string {
  const digest = createHash("sha256").update(`${workspaceId}\0${installId}`).digest("hex");
  return `ws_${digest.slice(0, 32)}`;
}

function storedWorkspaceKey(config: Record<string, unknown>): string {
  const value = config[WORKSPACE_KEY_FIELD];
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WORKSPACE_KEY_LENGTH) return "";
  // 控制字符会被云端拒绝；出现即视为损坏，重新生成。
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : "";
}

/**
 * 读取一个工作区的 workspaceKey，不存在时生成并持久化。
 *
 * TIPS：持久化在 jugglework 工作区配置里（与该工作区同生命周期），删除工作区
 * 即连同策略键一起消失，云端侧的孤儿策略行由服务端清扫回收。
 *
 * @param config 服务端配置
 * @param workspaceId 工作区 id
 * @returns 该工作区稳定的 workspaceKey
 */
export async function ensureWorkspaceKey(config: ServerConfig, workspaceId: string): Promise<string> {
  const id = workspaceId.trim();
  if (!id) return "";
  const existing = storedWorkspaceKey(await readJuggleWorkWorkspaceConfig(config, id));
  if (existing) return existing;
  const created = deriveWorkspaceKey(id, await readInstallId(config));
  try {
    await writeJuggleWorkWorkspaceConfig(config, id, (current) => ({
      ...current,
      [WORKSPACE_KEY_FIELD]: created,
    }));
  } catch {
    // 只读部署无法落盘，但派生是确定性的：同一 install id 下每次都得到同一个键。
  }
  return created;
}
