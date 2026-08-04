import {
  jsonRpcResult,
  listCloudMcpCandidates,
  mcpPost,
  openCloudMcpSession,
  type CloudMcpSession,
  type McpFetch,
} from "./connect-cloud-mcp-rpc.js";
import { externalFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";

const SEARCH_TOOL_NAME = "search_capabilities";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** JuggleWork Cloud 能力目录中的一条命中记录。 */
export type JuggleWorkConnectCapabilityMatch = {
  /** 可直接传给 execute_capability 的精确能力名称 */
  name: string;
  /** 能力描述，可能缺省 */
  description?: string;
};

/** 能力目录预检结果。 */
export type JuggleWorkConnectCapabilitySearch = {
  /**
   * 预检本身是否成功。
   *
   * TIPS：false 表示"问不到"（未登录 Cloud、配置失效、传输失败），
   * 与 true + 空 matches（"目录里确实没有"）是两种完全不同的结论，
   * 调用方必须区分：前者放行旧流程，后者才应拦截。
   */
  ok: boolean;
  matches: JuggleWorkConnectCapabilityMatch[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function toMatch(entry: unknown): JuggleWorkConnectCapabilityMatch | null {
  if (typeof entry === "string") return entry.trim() ? { name: entry.trim() } : null;
  if (!isRecord(entry)) return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return null;
  const description = typeof entry.description === "string" ? entry.description.trim() : "";
  return description ? { name, description } : { name };
}

function matchesFromPayload(payload: unknown): JuggleWorkConnectCapabilityMatch[] | null {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => {
      const match = toMatch(entry);
      return match ? [match] : [];
    });
  }
  if (!isRecord(payload)) return null;
  for (const key of ["matches", "capabilities", "results", "items"]) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        const match = toMatch(entry);
        return match ? [match] : [];
      });
    }
  }
  return null;
}

/**
 * 从 MCP tools/call 结果中提取能力命中列表。
 *
 * @param result JSON-RPC result 对象
 * @returns 命中列表；结果为错误或形状无法识别时返回 null
 */
function matchesFromToolResult(result: Record<string, unknown> | null): JuggleWorkConnectCapabilityMatch[] | null {
  if (!result || result.isError === true) return null;
  const direct = matchesFromPayload(result.structuredContent);
  if (direct) return direct;
  const content = result.content;
  if (!Array.isArray(content)) return matchesFromPayload(result);
  for (const item of content) {
    if (!isRecord(item) || typeof item.text !== "string") continue;
    const parsed = matchesFromPayload(parseJson(item.text));
    if (parsed) return parsed;
  }
  return matchesFromPayload(result);
}

async function callSearch(
  fetcher: McpFetch,
  session: CloudMcpSession,
  args: Record<string, unknown>,
): Promise<JuggleWorkConnectCapabilityMatch[] | null> {
  const response = await mcpPost(fetcher, session.url, session.headers, {
    id: 2,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: SEARCH_TOOL_NAME, arguments: args },
  });
  if (!response.response.ok) return null;
  return matchesFromToolResult(jsonRpcResult(response.payload));
}

/**
 * 在 JuggleWork Cloud 能力目录中搜索能力。
 *
 * TIPS：远端 search_capabilities 的入参只有 { query, limit } 且
 * additionalProperties 为 false —— 多传任何过滤字段都会被判为非法参数，
 * 反而把"可达"变成一次失败的调用。这里刻意只发这两个字段。
 *
 * @param config 服务端配置
 * @param input 搜索条件：query 关键词与可选条数上限
 * @param fetcher 外部请求实现，测试可替换
 * @returns 预检结果；ok 为 false 表示无法完成预检
 */
export async function searchJuggleWorkConnectCapabilities(
  config: ServerConfig,
  input: { query: string; limit?: number },
  fetcher: McpFetch = externalFetch,
): Promise<JuggleWorkConnectCapabilitySearch> {
  const query = input.query.trim();
  if (!query) return { ok: true, matches: [] };
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  try {
    for (const candidate of await listCloudMcpCandidates(config)) {
      const session = await openCloudMcpSession(candidate.cloud, fetcher, "jugglework-server-capability-search");
      if (!session) continue;
      const matches = await callSearch(fetcher, session, { query, limit });
      if (matches) return { ok: true, matches };
    }
    return { ok: false, matches: [] };
  } catch {
    return { ok: false, matches: [] };
  }
}
