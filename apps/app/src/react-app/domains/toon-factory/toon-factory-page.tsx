/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";
import { useOptionalJuggleWorkServer } from "@/react-app/domains/connections/jugglework-server-provider";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { t } from "@/i18n";
import { createClient } from "@/app/lib/opencode";
import { useCheckDesktopRestriction, useDesktopAllowedModels } from "@/react-app/domains/cloud/desktop-config-provider";
import { getAllowedConnectedTextModels, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { ToonFactoryWorkbench } from "./toon-factory-workbench";
import { flushAllToonDrafts, toonQueryScope, toonWorkspaceKey } from "./toon-factory-state";

type ToonFactoryPageProps = {
  workspaceId: string;
  projectId: string | null;
  visible: boolean;
  onSelectProject: (projectId: string | null) => void;
  onScopeSwitchCancelled: (workspaceId: string, projectId: string | null) => void;
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
  const desiredScopeKey = `${endpoint}\u0000${props.workspaceId}`;
  const [activeScope, setActiveScope] = useState(() => ({ client, endpoint, workspaceId: props.workspaceId, projectId: props.projectId, key: desiredScopeKey }));
  const [blockedScopeKey, setBlockedScopeKey] = useState<string | null>(null);
  const [scopeRetry, setScopeRetry] = useState(0);
  const switchingScope = activeScope.key !== desiredScopeKey;
  useEffect(() => {
    if (!switchingScope) {
      if (activeScope.client !== client || activeScope.projectId !== props.projectId) setActiveScope((current) => ({ ...current, client, ...(current.key === desiredScopeKey ? { projectId: props.projectId } : {}) }));
      return;
    }
    let cancelled = false;
    void flushAllToonDrafts().then((flushed) => {
      if (cancelled) return;
      if (flushed) { setBlockedScopeKey(null); setActiveScope({ client, endpoint, workspaceId: props.workspaceId, projectId: props.projectId, key: desiredScopeKey }); }
      else setBlockedScopeKey(desiredScopeKey);
    });
    return () => { cancelled = true; };
  }, [activeScope.client, activeScope.projectId, client, desiredScopeKey, endpoint, props.projectId, props.workspaceId, switchingScope, scopeRetry]);
  const queryScope = toonQueryScope(activeScope.endpoint, activeScope.workspaceId);
  const workspaceQuery = useQuery({
    queryKey: toonWorkspaceKey(queryScope),
    queryFn: async () => (await activeScope.client!.listWorkspaces()).items.find((item) => item.id === activeScope.workspaceId) ?? null,
    enabled: props.visible && !switchingScope && Boolean(activeScope.client),
    staleTime: 30_000,
  });
  const workspaceRoot = workspaceQuery.data?.path ?? "";
  const opencodeBaseUrl = activeScope.client ? `${activeScope.client.baseUrl}/workspace/${encodeURIComponent(activeScope.workspaceId)}/opencode` : "";
  const opencodeClient = useMemo(() => activeScope.client && workspaceRoot
    ? createClient(opencodeBaseUrl, workspaceRoot, { token: activeScope.client.token, mode: "jugglework" })
    : null, [activeScope.client, opencodeBaseUrl, workspaceRoot]);
  const textModelsQuery = useProviderListQuery({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    directory: workspaceRoot,
    enabled: props.visible && !switchingScope && Boolean(opencodeClient),
  });
  const textModels = useMemo(() => getAllowedConnectedTextModels(textModelsQuery.data, {
    checkRestriction: checkDesktopRestriction,
    allowedModels,
  }), [allowedModels, checkDesktopRestriction, textModelsQuery.data]);
  const pending = Boolean(store && snapshot?.juggleworkServerCheckedAt === null);
  const reconnect = useCallback(async () => {
    if (!store) return;
    if (await store.reconnectJuggleWorkServer()) return;
    await store.ensureLocalJuggleWorkServerClient();
    await store.reconnectJuggleWorkServer();
  }, [store]);
  const afterDraftFlush = useCallback((action: () => void) => {
    void flushAllToonDrafts().then((flushed) => { if (flushed) action(); });
  }, []);

  return (
     <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag" data-testid="toon-factory-page" data-visible={props.visible ? "true" : "false"} data-workbench-suspended={props.visible ? undefined : "true"} data-workspace-id={activeScope.workspaceId}>
       <AppNavigationRail toonFactoryActive onOpenAccount={() => afterDraftFlush(props.onOpenAccount)} onOpenHome={() => afterDraftFlush(props.onOpenHome)} onOpenApps={() => afterDraftFlush(props.onOpenApps)} onOpenChat={() => afterDraftFlush(props.onOpenChat)} onOpenReviews={() => afterDraftFlush(props.onOpenReviews)} onOpenToonFactory={() => afterDraftFlush(() => props.onSelectProject(null))} onOpenSettings={() => afterDraftFlush(props.onOpenSettings)} onOpenTaskSearch={props.onOpenTaskSearch} onOpenCreateWorkspace={props.onOpenCreateWorkspace} />
      <AppInsetSurface className="relative bg-[var(--app-page-bg)]" testId="toon-factory-inset-surface">
         {pending ? <div className="flex h-full items-center justify-center text-xs text-dls-secondary">{t("toon_factory.connecting_server")}</div> : activeScope.client ? (
           <><div inert={switchingScope ? true : undefined} aria-disabled={switchingScope || undefined} className="flex min-h-0 min-w-0 flex-1"><ToonFactoryWorkbench client={activeScope.client} workspaceId={activeScope.workspaceId} workspaceRoot={workspaceRoot} projectId={activeScope.projectId} visible={props.visible} readOnly={switchingScope && blockedScopeKey === desiredScopeKey} sidebarOpen={false} textModels={textModels} textModelsPending={workspaceQuery.isPending || textModelsQuery.isPending || textModelsQuery.isFetching} onRefreshTextModels={() => textModelsQuery.refetch()} onOpenProviderSettings={() => afterDraftFlush(props.onOpenProviderSettings)} onSelectProject={(projectId) => afterDraftFlush(() => props.onSelectProject(projectId))} /></div>{switchingScope ? <div role="alert" data-testid="toon-scope-switch-blocked" className="absolute inset-0 z-[80] flex items-start justify-center bg-background/20 p-4"><div className="w-full rounded-xl border border-amber-500/40 bg-background p-3 text-xs text-amber-700 shadow-lg">{t("toon_factory.scope_switch_blocked")}{blockedScopeKey === desiredScopeKey ? <><button type="button" onClick={() => { setBlockedScopeKey(null); setScopeRetry((value) => value + 1); }} className="ml-2 rounded border px-2 py-1">{t("toon_factory.retry")}</button><button type="button" onClick={() => props.onScopeSwitchCancelled(activeScope.workspaceId, activeScope.projectId)} className="ml-2 rounded border px-2 py-1">{t("common.back")}</button></> : null}</div></div> : null}</>
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center"><h2 className="text-sm font-semibold text-dls-text">{t("toon_factory.server_unavailable")}</h2><p className="mt-1 max-w-sm text-xs leading-5 text-dls-secondary">{t("toon_factory.server_unavailable_hint")}</p><button type="button" onClick={() => void reconnect()} className="mt-4 rounded-lg bg-dls-accent px-4 py-2 text-xs font-semibold text-white">{t("toon_factory.retry")}</button></div>
        )}
      </AppInsetSurface>
    </div>
  );
}
