import { useEffect } from "react";
import { isFileWindowRuntime } from "@/app/lib/runtime-env";
import { useJuggleWorkServer } from "../domains/connections/jugglework-server-provider";
import { installFileWindowSessionStopBridge } from "../domains/session/surface/file-window-session-stop";

/** 主窗口路由外保留单一停止监听；请求时读取根连接，输入草稿不受导航影响。 */
export function FileWindowSessionStopCoordinator() {
  const store = useJuggleWorkServer();
  useEffect(() => {
    if (isFileWindowRuntime()) return;
    return installFileWindowSessionStopBridge(() => store.getSnapshot().juggleworkServerClient);
  }, [store]);
  return null;
}
