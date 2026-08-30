import { isAbsolute, relative, resolve } from "node:path";

import { automationSqliteAdapter } from "./automation/sqlite.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export type McpWorkspaceToolPolicy = {
  workspaceId: string;
  disabledServerNames: string[];
  revision: number;
  updatedAt: number | null;
  enforcementReady: boolean;
};

type PolicyRow = {
  disabledServerNamesJson: string;
  revision: number;
  updatedAt: number;
};

const GENERIC_RESOURCE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);
const policyCache = new Map<string, McpWorkspaceToolPolicy>();

function policyCacheKey(config: ServerConfig, workspaceId: string): string {
  return `${runtimeDbPath(config)}\0${workspaceId}`;
}

function normalizeServerNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []))]
    .sort((left, right) => left.localeCompare(right));
}

function parseServerNames(value: string): string[] {
  try {
    return normalizeServerNames(JSON.parse(value));
  } catch {
    return [];
  }
}

async function withPolicyDatabase<T>(config: ServerConfig, operation: (database: ReturnType<typeof automationSqliteAdapter>) => T): Promise<T> {
  const runtime = await openRuntimeSqliteDatabase(runtimeDbPath(config));
  const database = automationSqliteAdapter(runtime);
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS workspace_mcp_tool_policies (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      disabled_server_names_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    return operation(database);
  } finally {
    database.close();
  }
}

/** 读取工作区 MCP 工具软策略；缺省为全部开启。 */
export async function readMcpWorkspaceToolPolicy(config: ServerConfig, workspaceId: string): Promise<McpWorkspaceToolPolicy> {
  const key = policyCacheKey(config, workspaceId);
  const cached = policyCache.get(key);
  if (cached) return cached;
  const policy = await withPolicyDatabase(config, (database) => {
    const row = database.get<PolicyRow>(
      "SELECT disabled_server_names_json AS disabledServerNamesJson, revision, updated_at AS updatedAt FROM workspace_mcp_tool_policies WHERE workspace_id = ?",
      [workspaceId],
    );
    return {
      workspaceId,
      disabledServerNames: row ? parseServerNames(row.disabledServerNamesJson) : [],
      revision: row?.revision ?? 0,
      updatedAt: row?.updatedAt ?? null,
      enforcementReady: true,
    };
  });
  policyCache.set(key, policy);
  return policy;
}

/** 全量替换工作区 MCP 工具软策略，只持久化关闭项。 */
export async function writeMcpWorkspaceToolPolicy(
  config: ServerConfig,
  workspaceId: string,
  disabledServerNames: unknown,
): Promise<McpWorkspaceToolPolicy> {
  const normalized = normalizeServerNames(disabledServerNames);
  const now = Date.now();
  const policy = await withPolicyDatabase(config, (database) => {
    database.run(
      `INSERT INTO workspace_mcp_tool_policies (workspace_id, disabled_server_names_json, revision, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         disabled_server_names_json = excluded.disabled_server_names_json,
         revision = workspace_mcp_tool_policies.revision + 1,
         updated_at = excluded.updated_at`,
      [workspaceId, JSON.stringify(normalized), now],
    );
    const row = database.get<PolicyRow>(
      "SELECT disabled_server_names_json AS disabledServerNamesJson, revision, updated_at AS updatedAt FROM workspace_mcp_tool_policies WHERE workspace_id = ?",
      [workspaceId],
    );
    return {
      workspaceId,
      disabledServerNames: row ? parseServerNames(row.disabledServerNamesJson) : normalized,
      revision: row?.revision ?? 1,
      updatedAt: row?.updatedAt ?? now,
      enforcementReady: true,
    };
  });
  policyCache.set(policyCacheKey(config, workspaceId), policy);
  return policy;
}

/**
 * 将历史 `enabled=false` 迁移为软策略关闭项，并把 transport 配置恢复为可运行。
 * 返回更新后的关闭集合；无迁移时不写策略。
 */
export async function migrateLegacyDisabledRuntimeMcps(
  config: ServerConfig,
  workspaceId: string,
  runtimeEntries: Array<{ name: string; source: string; config: Record<string, unknown> }>,
): Promise<{ disabledServerNames: string[]; migratedServerNames: string[] }> {
  const legacy = runtimeEntries.filter((entry) => entry.source === "config.remote" && entry.config.enabled === false);
  if (!legacy.length) return {
    disabledServerNames: (await readMcpWorkspaceToolPolicy(config, workspaceId)).disabledServerNames,
    migratedServerNames: [],
  };
  const current = await readMcpWorkspaceToolPolicy(config, workspaceId);
  const disabled = [...new Set([...current.disabledServerNames, ...legacy.map((entry) => entry.name)])];
  const { setMcpEnabled } = await import("./mcp.js");
  for (const entry of legacy) await setMcpEnabled(config, workspaceId, entry.name, true);
  return {
    disabledServerNames: (await writeMcpWorkspaceToolPolicy(config, workspaceId, disabled)).disabledServerNames,
    migratedServerNames: legacy.map((entry) => entry.name),
  };
}

/** 测试隔离：清空进程内策略缓存。 */
export function resetMcpWorkspaceToolPolicyCacheForTests(): void {
  policyCache.clear();
}

/** 与 OpenCode MCP 工具命名保持一致。 */
export function sanitizeMcpToolSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 从完整候选 serverName 中解析扁平化 MCP tool id，最长前缀优先。 */
export function resolveMcpServerNameFromToolId(toolId: string, serverNames: string[]): string | null {
  const matches = serverNames
    .map((serverName) => ({ serverName, prefix: `${sanitizeMcpToolSegment(serverName)}_` }))
    .filter((candidate) => toolId.startsWith(candidate.prefix))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  if (!matches.length) return null;
  // 同一 sanitize namespace 无法从扁平 tool ID 安全反解，必须 fail closed。
  if (matches.length > 1 && matches[0]?.prefix === matches[1]?.prefix) return matches[0]?.serverName ?? null;
  return matches[0]?.serverName ?? null;
}

/** 判断一次已确认属于 MCP 的工具调用是否被工作区软策略拒绝。 */
export function checkMcpWorkspaceToolPolicy(input: {
  toolId: string;
  args?: unknown;
  serverNames?: string[];
  disabledServerNames: string[];
}): { allowed: boolean; serverName: string | null; code?: "mcp_disabled_in_workspace" | "mcp_resource_server_required" } {
  if (GENERIC_RESOURCE_TOOLS.has(input.toolId)) {
    const args = input.args && typeof input.args === "object" && !Array.isArray(input.args)
      ? input.args as Record<string, unknown>
      : {};
    const server = typeof args.server === "string" ? args.server.trim() : "";
    if (!server && input.disabledServerNames.length) {
      return { allowed: false, serverName: null, code: "mcp_resource_server_required" };
    }
    if (server && input.disabledServerNames.includes(server)) {
      return { allowed: false, serverName: server, code: "mcp_disabled_in_workspace" };
    }
    return { allowed: true, serverName: server || null };
  }
  const serverName = resolveMcpServerNameFromToolId(input.toolId, input.serverNames ?? []);
  if (!serverName) return { allowed: true, serverName: null };
  return input.disabledServerNames.includes(serverName)
    ? { allowed: false, serverName, code: "mcp_disabled_in_workspace" }
    : { allowed: true, serverName };
}

/** 按目录定位本机工作区，供常驻 OpenCode plugin 执行前检查。 */
export function findWorkspaceByDirectory(config: ServerConfig, directory: string): WorkspaceInfo | null {
  const target = resolve(directory);
  // OpenCode 的 plugin context 可能是工作区根目录，也可能是 session worktree、仓库
  // 子目录或同一项目下的实际执行目录。只做字符串全等会让策略端点返回 404，进而
  // 让未知 MCP 工具被当作普通工具放行。选择包含 target 的最长工作区根可避免嵌套
  // authorized root 误匹配，同时不允许 `../` 越界。
  return config.workspaces
    .filter((workspace) => workspace.workspaceType !== "remote")
    .flatMap((workspace) => {
      const roots = [workspace.path, workspace.directory, workspace.opencode?.directory]
        .flatMap((value) => typeof value === "string" && value.trim() ? [resolve(value)] : []);
      return [...new Set(roots)].map((root) => ({ workspace, root }));
    })
    .filter(({ root }) => {
      const child = relative(root, target);
      return child === "" || (!child.startsWith("..") && !isAbsolute(child));
    })
    .sort((left, right) => right.root.length - left.root.length)[0]?.workspace ?? null;
}

/** 返回工作区当前所有 MCP serverName，供执行检查确认工具来源。 */
export async function listWorkspaceMcpServerNames(config: ServerConfig, workspaceId: string): Promise<string[]> {
  const { listMcp } = await import("./mcp.js");
  const workspace = config.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return [];
  const items = await listMcp(config, workspace.id, workspace.path);
  return items.map((item) => item.name);
}

/** 编译完整 MCP tool 前缀集合。 */
export async function compileWorkspaceMcpToolPrefixes(config: ServerConfig, workspaceId: string): Promise<string[]> {
  return (await listWorkspaceMcpServerNames(config, workspaceId)).map((name) => `${sanitizeMcpToolSegment(name)}_`);
}

/** 将策略合并进 prompt tools，关闭项永远不能被调用方重新开启。 */
export function applyMcpWorkspacePolicyToPrompt(
  prompt: Record<string, unknown>,
  toolIds: string[],
  disabledServerNames: string[],
): Record<string, unknown> {
  if (!disabledServerNames.length) return prompt;
  const callerTools = prompt.tools && typeof prompt.tools === "object" && !Array.isArray(prompt.tools)
    ? prompt.tools as Record<string, boolean>
    : {};
  const tools = { ...callerTools };
  for (const toolId of toolIds) {
    if (resolveMcpServerNameFromToolId(toolId, disabledServerNames)) tools[toolId] = false;
  }
  // Generic resource 工具保留在目录中；执行时按 args.server 精确校验。无 server 的
  // 聚合 list 在存在关闭项时会被执行层拒绝，避免泄露关闭 server 的资源。
  return { ...prompt, tools };
}
