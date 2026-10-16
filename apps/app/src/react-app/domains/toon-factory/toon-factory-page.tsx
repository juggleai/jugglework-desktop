/** @jsxImportSource react */
import { useCallback, useMemo, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";

import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";
import { useOptionalJuggleWorkServer } from "@/react-app/domains/connections/jugglework-server-provider";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { AppSecondarySidebarResizeHandle } from "@/react-app/shell/app-secondary-sidebar-resize-handle";
import { AppSecondarySidebarTopControls } from "@/react-app/shell/app-secondary-sidebar-top-controls";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { appInsetSidebarCssWidth, useWorkspaceShellLayout } from "@/react-app/shell/workspace-shell-layout";
import { t } from "@/i18n";
import { createClient } from "@/app/lib/opencode";
import { useCheckDesktopRestriction, useDesktopAllowedModels } from "@/react-app/domains/cloud/desktop-config-provider";
import { getAllowedConnectedTextModels, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { ToonFactoryWorkbench } from "./toon-factory-workbench";
import { flushToonTextDrafts, toonQueryScope, toonWorkspaceKey } from "./toon-factory-state";

type ToonFactoryPageProps = {
  workspaceId: string;
  projectId: string | null;
  visible: boolean;
  onSelectProject: (projectId: string | null) => void;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenReviews: () => void;
  onOpenSettings: () => void;
  onOpenProviderSettings: () => void;
  onOpenTaskSearch: () => void;
  onOpenCreateWorkspace: OpenCreateWorkspace;
};

export function ToonFactoryPage(props: ToonFactoryPageProps) {
  const store = useOptionalJuggleWorkServer();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const allowedModels = useDesktopAllowedModels();
  const snapshot = store?.getSnapshot() ?? null;
  const client = snapshot?.juggleworkServerReady ? snapshot.juggleworkServerClient : null;
  const endpoint = client?.baseUrl.trim().replace(/\/+$/, "") ?? "";
  const queryScope = toonQueryScope(endpoint, props.workspaceId);
  const workspaceQuery = useQuery({
    queryKey: toonWorkspaceKey(queryScope),
    queryFn: async () => (await client!.listWorkspaces()).items.find((item) => item.id === props.workspaceId) ?? null,
    enabled: props.visible && Boolean(client),
    staleTime: 30_000,
  });
  const workspaceRoot = workspaceQuery.data?.path ?? "";
  const opencodeBaseUrl = client ? `${client.baseUrl}/workspace/${encodeURIComponent(props.workspaceId)}/opencode` : "";
  const opencodeClient = useMemo(() => client && workspaceRoot
    ? createClient(opencodeBaseUrl, workspaceRoot, { token: client.token, mode: "jugglework" })
    : null, [client, opencodeBaseUrl, workspaceRoot]);
  const textModelsQuery = useProviderListQuery({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    directory: workspaceRoot,
    enabled: props.visible && Boolean(opencodeClient),
  });
  const textModels = useMemo(() => getAllowedConnectedTextModels(textModelsQuery.data, {
    checkRestriction: checkDesktopRestriction,
    allowedModels,
  }), [allowedModels, checkDesktopRestriction, textModelsQuery.data]);
  const pending = Boolean(store && snapshot?.juggleworkServerCheckedAt === null);
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const { leftSidebarResizing, leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  const pageStyle = { "--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth) } as CSSProperties;
  const reconnect = useCallback(async () => {
    if (!store) return;
    if (await store.reconnectJuggleWorkServer()) return;
    await store.ensureLocalJuggleWorkServerClient();
    await store.reconnectJuggleWorkServer();
  }, [store]);
  const afterDraftFlush = useCallback((action: () => void) => {
    void flushToonTextDrafts().then(action).catch(() => undefined);
  }, []);

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag" style={pageStyle} data-testid="toon-factory-page" data-visible={props.visible ? "true" : "false"} data-workbench-suspended={props.visible ? undefined : "true"} data-workspace-id={props.workspaceId}>
      <AppNavigationRail toonFactoryActive onOpenAccount={() => afterDraftFlush(props.onOpenAccount)} onOpenHome={() => afterDraftFlush(props.onOpenHome)} onOpenApps={() => afterDraftFlush(props.onOpenApps)} onOpenChat={() => afterDraftFlush(props.onOpenChat)} onOpenReviews={() => afterDraftFlush(props.onOpenReviews)} onOpenToonFactory={() => undefined} onOpenSettings={() => afterDraftFlush(props.onOpenSettings)} onOpenTaskSearch={props.onOpenTaskSearch} onOpenCreateWorkspace={props.onOpenCreateWorkspace} />
      <AppSecondarySidebarTopControls sidebarOpen={sidebarOpen} onOpenTaskSearch={props.onOpenTaskSearch} onToggleSidebar={toggleSidebar} />
      <AppInsetSurface className="relative bg-[var(--app-page-bg)]" testId="toon-factory-inset-surface">
        {pending ? <div className="flex h-full items-center justify-center text-xs text-dls-secondary">{t("toon_factory.connecting_server")}</div> : client ? (
          <ToonFactoryWorkbench client={client} workspaceId={props.workspaceId} workspaceRoot={workspaceRoot} projectId={props.projectId} visible={props.visible} sidebarOpen={sidebarOpen} textModels={textModels} textModelsPending={workspaceQuery.isPending || textModelsQuery.isPending || textModelsQuery.isFetching} onRefreshTextModels={() => textModelsQuery.refetch()} onOpenProviderSettings={() => afterDraftFlush(props.onOpenProviderSettings)} onSelectProject={(projectId) => afterDraftFlush(() => props.onSelectProject(projectId))} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center"><h2 className="text-sm font-semibold text-dls-text">{t("toon_factory.server_unavailable")}</h2><p className="mt-1 max-w-sm text-xs leading-5 text-dls-secondary">{t("toon_factory.server_unavailable_hint")}</p><button type="button" onClick={() => void reconnect()} className="mt-4 rounded-lg bg-dls-accent px-4 py-2 text-xs font-semibold text-white">{t("toon_factory.retry")}</button></div>
        )}
        {sidebarOpen ? <AppSecondarySidebarResizeHandle resizing={leftSidebarResizing} onPointerDown={startLeftSidebarResize} /> : null}
      </AppInsetSurface>
    </div>
  );
}
