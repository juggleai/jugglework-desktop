import { readFile } from "node:fs/promises";
import { ApiError } from "../errors.js";
import { loopbackFetch } from "../server-fetch.js";
import type { NativeActionScope } from "./schema.js";

export type NativeReadOp = "product_tasks.list" | "contacts.search";

/**
 * Native requests go through the desktop main process to the renderer, which
 * holds the sign-in session. The local server never sees credentials.
 */
export type NativeActionRequester = (input: {
  op: NativeReadOp;
  scope: NativeActionScope;
  params: Record<string, unknown>;
}) => Promise<unknown>;

/** Sends a request over the desktop UI control channel; refuses when there is none. */
export const requestNativeActionViaDesktop: NativeActionRequester = async (input) => {
  const discovery = process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY?.trim();
  if (!discovery) throw new ApiError(409, "native_actions_unavailable", "原生能力仅在桌面端可用");
  const bridge = JSON.parse(await readFile(discovery, "utf8"));
  if (typeof bridge.baseUrl !== "string" || typeof bridge.token !== "string")
    throw new ApiError(409, "native_actions_unavailable", "桌面原生能力通道不可用");
  const response = await loopbackFetch(`${bridge.baseUrl}/native-actions/request`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(45_000),
  });
  const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string; result?: unknown };
  if (!response.ok || result.ok !== true)
    throw new ApiError(502, result.code ?? "native_action_failed", result.error ?? "原生能力请求失败");
  return result.result;
};
