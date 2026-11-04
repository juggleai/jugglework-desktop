import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { clearQueuedSessionDrafts } from "./queued-draft-cleanup";

/** 主窗口常驻处理已由 Main 授权的停止目标；只清排队资源，保留输入栏。 */
export function installFileWindowSessionStopBridge(client: JuggleWorkServerClient | (() => JuggleWorkServerClient | null)) {
  return window.__JUGGLEWORK_ELECTRON__?.fileWindow?.onSessionStopRequest?.(async ({ workspaceId, sessionId }) => {
    clearQueuedSessionDrafts(typeof client === "function" ? client() : client, workspaceId, sessionId);
    return { ok: true };
  }) ?? (() => {});
}
