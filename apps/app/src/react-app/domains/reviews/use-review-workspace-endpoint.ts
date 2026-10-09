import { useEffect, useMemo, useState } from "react";

import { workspaceBootstrap, type WorkspaceList } from "@/app/lib/desktop";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { useOptionalJuggleWorkServer } from "@/react-app/domains/connections/jugglework-server-provider";
import { createWorkspaceServerClientResolver } from "@/react-app/infra/workspace-server-client";
import { mapDesktopWorkspace, mergeRouteWorkspaces, type RouteWorkspace } from "@/react-app/shell/route-workspaces";

export type ReviewWorkspaceEndpointState = {
  endpoint: ResolvedWorkspaceEndpoint | null;
  loading: boolean;
  error: string | null;
};

export function useReviewWorkspaceEndpoint(workspaceId: string, active: boolean): ReviewWorkspaceEndpointState {
  const store = useOptionalJuggleWorkServer();
  const snapshot = store?.getSnapshot() ?? null;
  const [workspace, setWorkspace] = useState<RouteWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const localServer = useMemo(() => ({
    baseUrl: snapshot?.juggleworkServerBaseUrl,
    token: snapshot?.juggleworkServerAuth.token,
    hostToken: snapshot?.juggleworkServerAuth.hostToken,
  }), [snapshot?.juggleworkServerAuth.hostToken, snapshot?.juggleworkServerAuth.token, snapshot?.juggleworkServerBaseUrl]);

  useEffect(() => {
    if (!active && workspace) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const desktopList = isDesktopRuntime() ? await workspaceBootstrap() as WorkspaceList : null;
        const desktopWorkspaces = (desktopList?.workspaces ?? []).map(mapDesktopWorkspace);
        const serverWorkspaces = snapshot?.juggleworkServerClient
          ? (await snapshot.juggleworkServerClient.listWorkspaces()).items
          : [];
        const found = mergeRouteWorkspaces(serverWorkspaces, desktopWorkspaces).find((item) => item.id === workspaceId) ?? null;
        if (!cancelled) {
          setWorkspace(found);
          setError(found ? null : "Workspace is unavailable.");
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Workspace is unavailable.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [active, snapshot?.juggleworkServerClient, workspaceId]);

  const endpoint = useMemo(() => createWorkspaceServerClientResolver(localServer)(workspace), [localServer, workspace]);
  return { endpoint, loading, error };
}
