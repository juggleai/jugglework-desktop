import { callBusserver } from "./api";
import { juggleChatRuntime } from "./runtime";
import type { SkillEnvelope, SkillResult } from "./types";

let disposeBridge: (() => void) | null = null;

async function routeSkillEvent(envelope: SkillEnvelope): Promise<SkillResult> {
  try {
    if (envelope.source === "jugglechat-busserver") {
      const data = await callBusserver(envelope.args ?? {});
      if (data && typeof data === "object" && "code" in data && data.code !== 0) {
        const response = data as { code: number; msg?: string };
        return {
          ok: false,
          error: { code: `BS_${response.code}`, message: response.msg ?? "Chat 服务调用失败", data },
        };
      }
      return { ok: true, data };
    }
    if (envelope.source === "jugglechat-im-sdk") {
      const data = await juggleChatRuntime.invoke(envelope.action, envelope.args ?? {});
      return { ok: true, data };
    }
    return { ok: false, error: { code: "NOT_ALLOWED", message: `不支持的来源：${envelope.source}` } };
  } catch (error) {
    const detail = error as { code?: string; message?: string };
    return {
      ok: false,
      error: { code: detail.code ?? "CHAT_INVOKE_FAILED", message: detail.message ?? String(error) },
    };
  }
}

export function startJuggleChatSkillBridge() {
  if (disposeBridge) return disposeBridge;
  const setSkillEvent = window.__JUGGLEWORK_ELECTRON__?.juggleChat?.setSkillEvent;
  if (!setSkillEvent) return () => {};
  const off = setSkillEvent(routeSkillEvent);
  let disposed = false;
  disposeBridge = () => {
    if (disposed) return;
    disposed = true;
    disposeBridge = null;
    off?.();
  };
  return disposeBridge;
}
