/**
 * 社区标准 MCP 配置片段（`mcpServers` JSON）的导入解析。
 *
 * TIPS: 几乎所有 MCP 服务器的 README 给的都是这段 JSON，用户的默认动作是复制粘贴而非逐字段誊抄。
 * 解析结果只回填表单、不直接落盘，用户仍需复核后提交。
 */

import { formatCommand } from "./mcp-command-lexer";

/**
 * 导入成功后用于回填表单的值。
 * @param name server 名称
 * @param type 传输类型
 * @param command 本地类型的启动命令文本（已按 shell 规则还原引号）
 * @param url 远程类型的服务地址
 * @param environment 环境变量键值对
 * @param headers 远程类型的请求头键值对
 * @param cwd 本地类型的工作目录
 * @param timeout 本地类型的请求超时（毫秒），未声明时为空字符串
 * @param placeholderKeys 值为占位符而被清空的键，UI 据此标记待填
 * @param ignoredCount 被忽略的其余 server 条目数量
 */
export type ImportedMcpConfig = {
  name: string;
  type: "remote" | "local";
  command: string;
  url: string;
  environment: Array<{ key: string; value: string }>;
  headers: Array<{ key: string; value: string }>;
  cwd: string;
  timeout: string;
  placeholderKeys: string[];
  ignoredCount: number;
};

/** 导入失败的原因。 */
export type ImportMcpError = "invalid_json" | "no_server" | "unsupported_shape";

export type ImportMcpResult =
  | { ok: true; config: ImportedMcpConfig }
  | { ok: false; error: ImportMcpError };

const REMOTE_TYPES = new Set(["remote", "sse", "http", "streamable-http", "streamableHttp"]);

/**
 * 判断环境变量值是否为 README 里的占位符而非真实凭据。
 * @param value 原始值
 *
 * TIPS: 把 `<YOUR_API_KEY>` 这类占位符当真值写进配置，会产生一个"看起来配好了但连不上"的条目，
 * 且用户很难意识到问题出在哪。保留键、清空值，让待填状态显式化。
 */
export function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^<.*>$/.test(trimmed)) return true;
  if (/^\{\{.*\}\}$/.test(trimmed)) return true;
  if (/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(trimmed)) return true;
  if (/^[*x]{3,}$/i.test(trimmed)) return true;
  if (/^(your|my|placeholder|example|sample|dummy|insert)[-_ ]/i.test(trimmed)) return true;
  if (/^(your|api|the)[-_]?(key|token|secret|value)$/i.test(trimmed)) return true;
  return false;
}

function toEntries(source: unknown): { entries: Array<{ key: string; value: string }>; placeholders: string[] } {
  const entries: Array<{ key: string; value: string }> = [];
  const placeholders: string[] = [];
  if (!source || typeof source !== "object" || Array.isArray(source)) return { entries, placeholders };
  for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
    if (typeof key !== "string" || !key.trim()) continue;
    const value = typeof raw === "string" ? raw : String(raw ?? "");
    if (isPlaceholderValue(value)) {
      entries.push({ key, value: "" });
      placeholders.push(key);
    } else {
      entries.push({ key, value });
    }
  }
  return { entries, placeholders };
}

/**
 * 从 server 配置对象判断传输类型。
 * @param config 单个 server 的配置对象
 */
function resolveType(config: Record<string, unknown>): "remote" | "local" {
  const declared = typeof config.type === "string" ? config.type : "";
  if (REMOTE_TYPES.has(declared)) return "remote";
  if (declared === "local" || declared === "stdio") return "local";
  if (typeof config.url === "string" || typeof config.serverUrl === "string") return "remote";
  return "local";
}

/**
 * 解析粘贴的 MCP 配置 JSON。
 * @param text 用户粘贴的原始文本
 * @returns 成功时返回首个 server 的表单回填值；含多个 server 时其余记入 ignoredCount
 *
 * TIPS: 兼容两种顶层形状——带 `mcpServers` 外层包裹（Claude Desktop / Cursor 及多数 README），
 * 以及省略外层的裸对象（少数 README）。
 */
export function parseMcpServersJson(text: string): ImportMcpResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "invalid_json" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "unsupported_shape" };
  }

  const root = parsed as Record<string, unknown>;
  const wrapped = root.mcpServers ?? root.servers;
  const container = wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
    ? (wrapped as Record<string, unknown>)
    : root;

  const candidates = Object.entries(container).filter(
    ([, value]) => value && typeof value === "object" && !Array.isArray(value),
  );
  if (candidates.length === 0) return { ok: false, error: "no_server" };

  const [name, rawConfig] = candidates[0]!;
  const config = rawConfig as Record<string, unknown>;
  const type = resolveType(config);

  const commandParts: string[] = [];
  if (typeof config.command === "string" && config.command.trim()) {
    commandParts.push(config.command.trim());
  } else if (Array.isArray(config.command)) {
    for (const part of config.command) {
      if (typeof part === "string") commandParts.push(part);
    }
  }
  if (Array.isArray(config.args)) {
    for (const part of config.args) {
      if (typeof part === "string") commandParts.push(part);
    }
  }

  const env = toEntries(config.env ?? config.environment);
  const headers = toEntries(config.headers);

  const url = typeof config.url === "string"
    ? config.url
    : typeof config.serverUrl === "string"
      ? config.serverUrl
      : "";

  return {
    ok: true,
    config: {
      name,
      type,
      command: formatCommand(commandParts),
      url,
      environment: env.entries,
      headers: headers.entries,
      cwd: typeof config.cwd === "string" ? config.cwd : "",
      timeout: typeof config.timeout === "number" && Number.isFinite(config.timeout) && config.timeout > 0
        ? String(Math.round(config.timeout))
        : "",
      placeholderKeys: [...env.placeholders, ...headers.placeholders],
      ignoredCount: candidates.length - 1,
    },
  };
}
