import { useEffect, useState } from "react";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";

/** 探测实际目标的语音配置；旧服务不支持探测时保持现有兼容行为。 */
export async function checkVoiceServiceAvailability(getStatus: JuggleWorkServerClient["getVoiceRealtimeStatus"] | null | undefined): Promise<"available" | "unavailable"> {
  if (!getStatus) return "unavailable";
  try { return (await getStatus()).configured ? "available" : "unavailable"; }
  catch { return "available"; }
}

/** 会话输入栏与宠物共用语音服务可用性；未配置/检查中禁用，旧服务探测失败保持兼容。 */
export function useVoiceService(getStatus: JuggleWorkServerClient["getVoiceRealtimeStatus"] | null | undefined, enabled: boolean) {
  const [availability, setAvailability] = useState<"checking" | "available" | "unavailable">("checking");
  useEffect(() => {
    if (!getStatus || !enabled) { setAvailability("unavailable"); return; }
    let disposed = false;
    const refresh = async () => {
      const result = await checkVoiceServiceAvailability(getStatus);
      if (!disposed) setAvailability(result);
    };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    setAvailability("checking"); void refresh();
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [getStatus, enabled]);
  return availability;
}
