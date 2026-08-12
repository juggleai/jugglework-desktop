/** @jsxImportSource react */
import { useEffect, useMemo, type ReactNode } from "react";

import { isLoopbackJuggleWorkServerUrl, readJuggleWorkServerSettings } from "@/app/lib/jugglework-server";
import type { WorkspaceDisplay } from "@/app/types";
import { isDesktopRuntime } from "@/app/utils";
import { JuggleWorkServerProvider } from "./jugglework-server-provider";
import { createJuggleWorkServerStore } from "./jugglework-server-store";

const emptyWorkspace: WorkspaceDisplay = {
  id: "",
  name: "",
  path: "",
  preset: "starter",
  workspaceType: "local",
};

/**
 * 为全局页面和后台协调器提供应用生命周期级本机服务连接。
 * @param props.children 需要读取本机服务状态的应用内容
 */
export function RootJuggleWorkServerProvider(props: { children: ReactNode }) {
  const store = useMemo(
    () => createJuggleWorkServerStore({
      startupPreference: () => {
        if (!isDesktopRuntime()) return "server";
        const storedUrl = readJuggleWorkServerSettings().urlOverride?.trim() ?? "";
        // TIPS: loopback 地址及令牌由 Desktop 每次启动重新分配，不能当成手工远程配置复用。
        return storedUrl && !isLoopbackJuggleWorkServerUrl(storedUrl) ? "server" : "local";
      },
      documentVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
      developerMode: () => typeof window !== "undefined" && window.localStorage.getItem("jugglework.developerMode") === "1",
      runtimeWorkspaceId: () => null,
      activeClient: () => null,
      selectedWorkspaceDisplay: () => emptyWorkspace,
      restartLocalServer: async () => false,
      createRemoteWorkspaceFlow: async () => false,
    }),
    [],
  );

  useEffect(() => {
    store.start();
    return () => store.dispose();
  }, [store]);

  return <JuggleWorkServerProvider store={store}>{props.children}</JuggleWorkServerProvider>;
}
