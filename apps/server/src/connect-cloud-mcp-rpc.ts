import { readConnectCloudMcp } from "./connect-state.js";
import { readRuntimeMcpConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

export const JUGGLEWORK_CLOUD_MCP_NAME = "jugglework-cloud";

export type McpFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 一个已完成握手的 jugglework-cloud MCP 会话。 */
export type CloudMcpSession = {
  /** MCP HTTP 端点 */
  url: string;
  /** 后续请求必须携带的请求头（含鉴权与会话标识） */
  headers: Record<string, string>;
};

/** 一个候选的 jugglework-cloud MCP 配置及其来源作用域。 */
export type CloudMcpCandidate = {
  cloud: Record<string, unknown>;
  source: "server" | "workspace";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function parseJsonOrText(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * 读取 MCP 响应体，兼容 JSON 与 SSE 两种传输形态。
 *
 * @param response MCP HTTP 响应
 * @returns 解析后的载荷，空响应返回 null
 */
export async function readMcpPayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) return null;
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return parseJsonOrText(raw);
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data) return parseJsonOrText(data);
  }
  return null;
}

/**
 * 提取 JSON-RPC 成功结果。
 *
 * @param payload 已解析的响应载荷
 * @returns result 对象；出错或形状不符时返回 null
 */
export function jsonRpcResult(payload: unknown): Record<string, unknown> | null {
  const record = Array.isArray(payload) ? payload.find(isRecord) : payload;
  if (!isRecord(record) || record.error !== undefined || !isRecord(record.result)) return null;
  return record.result;
}

/**
 * 向 MCP 端点发送一次 JSON-RPC 请求。
 *
 * @param fetcher 外部请求实现
 * @param url MCP 端点
 * @param headers 请求头
 * @param body JSON-RPC 请求体
 */
export async function mcpPost(fetcher: McpFetch, url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetcher(url, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  return { response, payload: await readMcpPayload(response) };
}

/**
 * 与一份 jugglework-cloud 配置完成 MCP 握手。
 *
 * TIPS：配置不可用（URL 非法、被禁用、鉴权失败、协议错误）时返回 null，
 * 调用方据此跳到下一个候选配置，而不是把这次失败当成"目录为空"。
 *
 * @param config 一份 jugglework-cloud MCP 配置
 * @param fetcher 外部请求实现
 * @param clientName 握手时上报的客户端名称
 * @returns 可用于后续调用的会话；配置不可用时返回 null
 */
export async function openCloudMcpSession(
  config: Record<string, unknown>,
  fetcher: McpFetch,
  clientName: string,
): Promise<CloudMcpSession | null> {
  const url = typeof config.url === "string" ? config.url : "";
  if (!/^https?:\/\//.test(url) || config.enabled === false) return null;
  const baseHeaders = stringHeaders(config.headers);
  const initialized = await mcpPost(fetcher, url, baseHeaders, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
      protocolVersion: "2025-06-18",
    },
  });
  if (!initialized.response.ok || !jsonRpcResult(initialized.payload)) return null;
  const sessionId = initialized.response.headers.get("mcp-session-id");
  const protocolVersion = initialized.response.headers.get("mcp-protocol-version");
  const headers = {
    ...baseHeaders,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
  };
  await mcpPost(fetcher, url, headers, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  return { url, headers };
}

/**
 * 收集本机所有 jugglework-cloud 候选配置，去重后按作用域优先级排序。
 *
 * TIPS：先用服务端（账号级）副本，再回落到工作区运行时副本 —— 后者是旧版本
 * 留下的遗留作用域，可能已经吊销，所以只能作为候选而不是唯一来源。
 *
 * @param config 服务端配置
 * @returns 去重后的候选配置列表
 */
export async function listCloudMcpCandidates(config: ServerConfig): Promise<CloudMcpCandidate[]> {
  const candidates: CloudMcpCandidate[] = [];
  const serverCloud = await readConnectCloudMcp(config);
  if (serverCloud) candidates.push({ cloud: serverCloud, source: "server" });
  for (const workspace of config.workspaces) {
    const cloud = await readRuntimeMcpConfig(config, workspace.id, JUGGLEWORK_CLOUD_MCP_NAME);
    if (cloud) candidates.push({ cloud, source: "workspace" });
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate.cloud);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
