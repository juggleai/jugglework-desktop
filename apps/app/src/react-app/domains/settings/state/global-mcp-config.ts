import { applyEdits, findNodeAtLocation, modify, parse, parseTree } from "jsonc-parser";

import { getMcpServerName, type McpDirectoryInfo } from "@/app/constants";
import type { McpServerConfig, McpServerEntry } from "@/app/types";
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
  catalogSource?: GlobalMcpProvenance["source"];
  catalogId?: string;
};

export type GlobalMcpProvenance = {
  source: "public" | "personal";
  catalogId?: string;
};

type StoredProvenance = GlobalMcpProvenance & { identity: string };

// Only a dedicated leading, single-line comment is metadata, never a config key.
const SOURCES_HEADER = /^(\uFEFF?[ \t\r\n]*)\/\/ jugglework-connector-sources: ([^\r\n]*)(?:\r?\n|$)/;

function readProvenance(raw: string): Map<string, StoredProvenance> {
  const header = SOURCES_HEADER.exec(raw);
  if (!header) return new Map();
  try {
    const sources: unknown = JSON.parse(header[2]!);
    if (!isRecord(sources)) return new Map();
    const result = new Map<string, StoredProvenance>();
    for (const [name, value] of Object.entries(sources)) {
      if (!isRecord(value)
        || (value.source !== "public" && value.source !== "personal")
        || (value.catalogId !== undefined && typeof value.catalogId !== "string")
        || typeof value.identity !== "string"
        || !/^fnv1a32:[0-9a-f]{8}$/.test(value.identity)
        || Object.keys(value).some((key) => !["source", "catalogId", "identity"].includes(key))) {
        return new Map();
      }
      result.set(name, {
        source: value.source,
        ...(value.catalogId !== undefined ? { catalogId: value.catalogId } : {}),
        identity: value.identity,
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

function mcpIdentity(config: McpServerConfig): string | undefined {
  let identity: string;
  if (config.type === "remote" && typeof config.url === "string") {
    identity = JSON.stringify(["remote", config.url.trim()]);
  } else if (config.type === "local" && Array.isArray(config.command)
    && config.command.every((argument) => typeof argument === "string")) {
    identity = JSON.stringify(["local", config.command]);
  } else {
    return undefined;
  }
  // FNV-1a is a consistency fingerprint, not authentication or secret protection.
  // Never duplicate URLs, commands, or auth fields in the provenance comment.
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(identity)) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function withProvenance(raw: string, name: string, provenance?: StoredProvenance): string {
  const sources = readProvenance(raw);
  if (provenance) sources.set(name, provenance);
  else sources.delete(name);
  const body = raw.replace(SOURCES_HEADER, "$1");
  if (!sources.size) return withTrailingNewline(body);
  const json = JSON.stringify(Object.fromEntries(sources))
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return withTrailingNewline(`// jugglework-connector-sources: ${json}\n${body}`);
}

/**
 * 合并全局配置文件与引擎已识别的全局 MCP。
 *
 * TIPS: 配置文件读取与运行快照短暂不一致时，不能把已经被引擎识别为
 * `config.global` 的连接器从列表中隐藏。同名时以配置文件为准，因为页面写回该文件。
 *
 * @param configuredEntries 全局配置文件中的 MCP
 * @param runtimeEntries 当前引擎快照中的 MCP
 */
export function mergeGlobalMcpEntries(
  configuredEntries: GlobalMcpEntry[],
  runtimeEntries: McpServerEntry[],
): GlobalMcpEntry[] {
  const merged = new Map(configuredEntries.map((entry) => [entry.name, entry]));
  for (const entry of runtimeEntries) {
    if (entry.source !== "config.global" || merged.has(entry.name)) continue;
    merged.set(entry.name, { name: entry.name, config: entry.config });
  }
  return [...merged.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * 从快速连接目录生成可持久化的全局 MCP 配置。
 *
 * @param entry MCP 目录条目
 */
export function globalMcpConfigFromDirectory(entry: McpDirectoryInfo): GlobalMcpEntry {
  const name = getMcpServerName(entry);
  const enabled = true;
  if ((entry.type ?? "remote") === "local") {
    if (!entry.command?.length) throw new Error("Missing MCP command.");
    return {
      name,
      config: {
        type: "local",
        command: [...entry.command],
        enabled,
        ...(entry.environment ? { environment: { ...entry.environment } } : {}),
        ...(entry.cwd?.trim() ? { cwd: entry.cwd.trim() } : {}),
        ...(typeof entry.timeout === "number" && Number.isFinite(entry.timeout) && entry.timeout > 0
          ? { timeout: Math.round(entry.timeout) }
          : {}),
      },
    };
  }
  if (!entry.url?.trim()) throw new Error("Missing MCP URL.");
  const headers = entry.headers && Object.keys(entry.headers).length ? { ...entry.headers } : undefined;
  return {
    name,
    config: {
      type: "remote",
      url: entry.url.trim(),
      enabled,
      ...(headers ? { headers, oauth: false as const } : {}),
      ...(!headers && entry.oauthConfig ? { oauth: { ...entry.oauthConfig } } : {}),
      ...(!headers && !entry.oauthConfig && entry.oauth ? { oauth: {} } : {}),
    },
  };
}

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
  const sources = readProvenance(raw);
  return Object.entries(mcp).flatMap(([name, value]) => {
    if (!isRecord(value)) return [];
    const config = value as McpServerConfig;
    const provenance = sources.get(name);
    return [{
      name,
      config,
      ...(provenance && provenance.identity === mcpIdentity(config) ? {
        catalogSource: provenance.source,
        ...(provenance.catalogId !== undefined ? { catalogId: provenance.catalogId } : {}),
      } : {}),
    }];
  });
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
  provenance?: GlobalMcpProvenance,
): string {
  const previous = parseGlobalMcpEntries(raw).find((entry) => entry.name === name);
  const source = provenance ?? (previous?.catalogSource ? {
    source: previous.catalogSource,
    ...(previous.catalogId !== undefined ? { catalogId: previous.catalogId } : {}),
  } : undefined);
  const identity = mcpIdentity(config);
  return withProvenance(editConfig(raw, ["mcp", name], config), name,
    source && identity ? {
      source: source.source,
      ...(source.catalogId !== undefined ? { catalogId: source.catalogId } : {}),
      identity,
    } : undefined);
}

/** 移除一个全局连接器。目标不存在时原样返回。 */
export function formatConfigWithoutMcpEntry(raw: string, name: string): string {
  const entries = parseGlobalMcpEntries(raw);
  const next = entries.some((entry) => entry.name === name)
    ? editConfig(raw, ["mcp", name], undefined)
    : raw;
  return withProvenance(next, name);
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

// Serialize this module's read-modify-write calls, including create collision checks.
// External writers still require transport-level locking/CAS for full atomicity.
let pendingMutation: Promise<void> = Promise.resolve();

async function mutateGlobalMcpConfig(
  target: GlobalConfigTarget,
  mutate: (raw: string) => string,
): Promise<void> {
  const mutation = pendingMutation.then(async () => {
    const current = await readGlobalOpencodeConfig(target);
    if (current === null) {
      throw new Error("Global opencode config is not writable in this runtime.");
    }
    const next = mutate(current);
    if (withTrailingNewline(current) === next) return;
    await writeGlobalOpencodeConfig(target, next);
  });
  pendingMutation = mutation.catch(() => {});
  await mutation;
}

/** Create only: check the freshly read config, not a potentially stale UI list. */
export async function createGlobalMcp(
  target: GlobalConfigTarget,
  name: string,
  config: McpServerConfig,
  provenance?: GlobalMcpProvenance,
): Promise<void> {
  await mutateGlobalMcpConfig(target, (raw) => {
    const tree = parseTree(raw);
    if (tree && findNodeAtLocation(tree, ["mcp", name])) {
      throw new Error(`Global MCP connector "${name}" already exists.`);
    }
    return formatConfigWithMcpEntry(raw, name, config, provenance);
  });
}

/** 新增或更新一个全局连接器。 */
export async function upsertGlobalMcp(
  target: GlobalConfigTarget,
  name: string,
  config: McpServerConfig,
  provenance?: GlobalMcpProvenance,
): Promise<void> {
  await mutateGlobalMcpConfig(target, (raw) => formatConfigWithMcpEntry(raw, name, config, provenance));
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
