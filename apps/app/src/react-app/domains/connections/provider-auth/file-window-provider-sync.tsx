import { useEffect } from "react";
import type { ProviderListItem, WorkspaceDisplay } from "@/app/types";
import { createClient } from "@/app/lib/opencode";
import { buildJuggleWorkWorkspaceBaseUrl } from "@/app/lib/jugglework-server";
import { notifyFileWindowProviderCatalogChanged } from "@/app/lib/managed-provider-scope";
import { isFileWindowRuntime } from "@/app/lib/runtime-env";
import { useCheckDesktopRestriction, useDesktopAllowedModels } from "@/react-app/domains/cloud/desktop-config-provider";
import { useJuggleWorkServer } from "../jugglework-server-provider";
import { createProviderAuthStore } from "./store";

type SyncRequest = { workspaceId: string; workspaceRoot: string };

/**
 * 文件助手子工作区是按需新建的独立引擎，只有主窗口持有登录态。
 * 收到请求后用主窗口的身份为该子工作区做一次云模型同步，完成后通知文件窗口刷新模型目录。
 */
export function FileWindowProviderSyncCoordinator() {
  const server = useJuggleWorkServer();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const allowedModels = useDesktopAllowedModels();

  useEffect(() => {
    if (isFileWindowRuntime()) return;
    const inFlight = new Set<string>();
    const sync = async ({ workspaceId, workspaceRoot }: SyncRequest) => {
      const snapshot = server.getSnapshot();
      const host = snapshot.juggleworkServerClient;
      if (!host || snapshot.juggleworkServerStatus !== "connected" || inFlight.has(workspaceId)) return;
      inFlight.add(workspaceId);
      try {
        const mountedBaseUrl = buildJuggleWorkWorkspaceBaseUrl(host.baseUrl, workspaceId);
        if (!mountedBaseUrl) return;
        const opencodeBaseUrl = `${mountedBaseUrl}/opencode`;
        const client = createClient(opencodeBaseUrl, workspaceRoot, { mode: "jugglework" });
        let providers: ProviderListItem[] = [];
        let defaults: Record<string, string> = {};
        let connected: string[] = [];
        let disabled: string[] = [];
        const workspace: WorkspaceDisplay = { id: workspaceId, name: "", path: workspaceRoot, preset: "starter", workspaceType: "local" };
        const store = createProviderAuthStore({
          client: () => client,
          providers: () => providers,
          providerDefaults: () => defaults,
          providerConnectedIds: () => connected,
          disabledProviders: () => disabled,
          checkDesktopAppRestriction: checkDesktopRestriction,
          desktopAllowedModels: () => allowedModels,
          selectedWorkspaceDisplay: () => workspace,
          providerBaseUrl: () => opencodeBaseUrl,
          selectedWorkspaceRoot: () => workspaceRoot,
          runtimeWorkspaceId: () => workspaceId,
          juggleworkServer: {
            getSnapshot: () => ({
              juggleworkServerStatus: "connected",
              juggleworkServerClient: host,
              juggleworkServerCapabilities: { config: { read: true, write: true } },
            }),
          },
          setProviders: (value) => { providers = value; },
          setProviderDefaults: (value) => { defaults = value; },
          setProviderConnectedIds: (value) => { connected = value; },
          setDisabledProviders: (value) => { disabled = value; },
          // 子工作区没有"需要重载"的横幅；引擎重载已在同步内部完成。
          markOpencodeConfigReloadRequired: () => {},
        });
        // 不调用 start()：它会注册全局的组织切换清理钩子，临时 store 不应成为清理者。
        const synced = await store.runCloudProviderSyncForReadiness("app_launch");
        if (!synced) return;
        notifyFileWindowProviderCatalogChanged();
      } catch (error) {
        console.warn("[file-window-provider-sync] failed", error);
      } finally {
        inFlight.delete(workspaceId);
      }
    };
    return window.__JUGGLEWORK_ELECTRON__?.fileWindow?.onProviderSyncRequest?.((input) => void sync(input));
  }, [allowedModels, checkDesktopRestriction, server]);

  return null;
}
