import { applyEdits, modify, parse } from "jsonc-parser";

import type { McpServerConfig } from "@/app/types";
import {
  EMPTY_OPENCODE_CONFIG,
  readGlobalOpencodeConfig,
  writeGlobalOpencodeConfig,
  type GlobalConfigTarget,
} from "./global-opencode-config";

/**
 * 全局连接器条目
 * @param name MCP 服务名，即全局配置 `mcp` 段下的键
 * @param config 该条目的 MCP 配置
 */
export type GlobalMcpEntry = {
  name: string;
  config: McpServerConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从全局配置内容解析 `mcp` 段。内容为空或格式非法时返回空列表。 */
export function parseGlobalMcpEntries(raw: string | null | undefined): GlobalMcpEntry[] {
  if (!raw?.trim()) return [];
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = parse(raw) as Record<string, unknown> | undefined;
  } catch {
    return [];
  }
  const mcp = parsed?.mcp;
  if (!isRecord(mcp)) return [];
  return Object.entries(mcp).flatMap(([name, value]) =>
    isRecord(value) ? [{ name, config: value as McpServerConfig }] : [],
  );
}

function withTrailingNewline(value: string) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function editConfig(raw: string, path: Array<string | number>, value: unknown) {
  const base = raw.trim() ? raw : EMPTY_OPENCODE_CONFIG;
  return withTrailingNewline(
    applyEdits(base, modify(base, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })),
  );
}

/** 写入或覆盖一个全局连接器，保留配置中的其余内容与 JSONC 注释。 */
export function formatConfigWithMcpEntry(
  raw: string,
  name: string,
  config: McpServerConfig,
): string {
  return editConfig(raw, ["mcp", name], config);
}

/** 移除一个全局连接器。目标不存在时原样返回。 */
export function formatConfigWithoutMcpEntry(raw: string, name: string): string {
  const entries = parseGlobalMcpEntries(raw);
  if (!entries.some((entry) => entry.name === name)) return withTrailingNewline(raw);
  return editConfig(raw, ["mcp", name], undefined);
}

/** 切换一个全局连接器的启用状态。目标不存在时原样返回。 */
export function formatConfigWithMcpEnabled(
  raw: string,
  name: string,
  enabled: boolean,
): string {
  const entries = parseGlobalMcpEntries(raw);
  if (!entries.some((entry) => entry.name === name)) return withTrailingNewline(raw);
  return editConfig(raw, ["mcp", name, "enabled"], enabled);
}

/** 读取全局配置中声明的连接器。 */
export async function readGlobalMcpEntries(
  target: GlobalConfigTarget,
): Promise<GlobalMcpEntry[]> {
  return parseGlobalMcpEntries(await readGlobalOpencodeConfig(target));
}

async function mutateGlobalMcpConfig(
  target: GlobalConfigTarget,
  mutate: (raw: string) => string,
): Promise<void> {
  const current = await readGlobalOpencodeConfig(target);
  if (current === null) {
    throw new Error("Global opencode config is not writable in this runtime.");
  }
  const next = mutate(current);
  if (withTrailingNewline(current) === next) return;
  await writeGlobalOpencodeConfig(target, next);
}

/** 新增或更新一个全局连接器。 */
export async function upsertGlobalMcp(
  target: GlobalConfigTarget,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  await mutateGlobalMcpConfig(target, (raw) => formatConfigWithMcpEntry(raw, name, config));
}

/** 移除一个全局连接器。 */
export async function removeGlobalMcp(
  target: GlobalConfigTarget,
  name: string,
): Promise<void> {
  await mutateGlobalMcpConfig(target, (raw) => formatConfigWithoutMcpEntry(raw, name));
}

/** 启用或停用一个全局连接器。 */
export async function setGlobalMcpEnabled(
  target: GlobalConfigTarget,
  name: string,
  enabled: boolean,
): Promise<void> {
  await mutateGlobalMcpConfig(target, (raw) => formatConfigWithMcpEnabled(raw, name, enabled));
}
