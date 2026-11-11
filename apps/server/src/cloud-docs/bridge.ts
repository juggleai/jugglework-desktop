import { readFile } from "node:fs/promises";
import { loopbackFetch } from "../server-fetch.js";
import { ApiError } from "../errors.js";

export type CloudDocsOp = "search" | "read" | "edit" | "create" | "import";

/** Docs 请求经桌面主进程代理，会话凭据不进入本地 Server。 */
export type CloudDocsRequester = (input: {
  tenantId: string;
  op: CloudDocsOp;
  params: Record<string, unknown>;
}) => Promise<{ status: number; body: any }>;

/** 通过桌面 UI 控制通道发出请求；无桌面通道时拒绝。 */
export const requestCloudDocsViaDesktop: CloudDocsRequester = async input => {
  const discovery = process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY?.trim();
  if (!discovery) throw new ApiError(409, "cloud_docs_unavailable", "云文档仅在桌面端可用");
  const bridge = JSON.parse(await readFile(discovery, "utf8"));
  if (typeof bridge.baseUrl !== "string" || typeof bridge.token !== "string")
    throw new ApiError(409, "cloud_docs_unavailable", "桌面云文档通道不可用");
  const response = await loopbackFetch(`${bridge.baseUrl}/cloud-docs/request`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    // TIPS: 冷启动允许 30 秒，原生 API 自身允许 40 秒；外层必须覆盖完整链路。
    signal: AbortSignal.timeout(input.op === "import" ? 330_000 : 75_000),
  });
  const result = (await response.json()) as { ok?: boolean; error?: string; status?: number; body?: unknown };
  if (!response.ok || result.ok !== true)
    throw new ApiError(502, "cloud_docs_request_failed", result.error ?? "云文档请求失败");
  return { status: result.status ?? 200, body: result.body };
};
