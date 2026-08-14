// The session route's data + navigation core: workspace/session loading
// (refreshRouteState + background session fetch), endpoint and opencode
// client resolution, URL-derived selection, redirects (fallback workspace,
// last-session restore, welcome), desktop local-server reconnect, remote
// connection checks, and the route inspector slice. Extracted verbatim from
// session-route.tsx as the final step of its decomposition; the route keeps
// composition, handlers, and JSX.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Session } from "@opencode-ai/sdk/v2/client";

import {
  publishInspectorOpencodeClient,
  publishInspectorSlice,
  recordInspectorEvent,
} from "@/app/lib/app-inspector";
import {
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  type JuggleWorkServerInfo,
  type WorkspaceList,
} from "@/app/lib/desktop";
import { createClient } from "@/app/lib/opencode";
import { createJuggleWorkServerClient, type JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { readDenBootstrapConfig } from "@/app/lib/den";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { WorkspaceConnectionState } from "@/app/types";
import { normalizeDirectoryPath } from "@/app/utils";
import { t } from "@/i18n";
import {
  createWorkspaceServerClientResolver,
  useWorkspaceServerClient,
} from "@/react-app/infra/workspace-server-client";
import { serializeWorkspaceActivation } from "./workspace-activation-coordinator";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "@/react-app/domains/workspace/remote-workspace-diagnostics";
import { useLocal } from "@/react-app/kernel/local-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useBootState } from "./boot-state";
import { ensureDesktopLocalJuggleWorkConnection } from "./desktop-local-jugglework";
import { resolveJuggleWorkConnection } from "./jugglework-connection";
import {
  classifyRouteSessionReadError,
  describeRouteError,
  isTransientStartupError,
  mapDesktopWorkspace,
  mergeRouteWorkspaces,
  orderRouteWorkspaces,
  resolveWorkspaceRefreshOrderIds,
  type RouteSession,
  type RouteWorkspace,
} from "./route-workspaces";
import {
  readActiveWorkspaceId,
  readLastSessionFor,
  readWorkspaceOrderIds,
  writeActiveWorkspaceId,
  writeWorkspaceOrderIds,
} from "./session-memory";
import {
  legacySessionRoute,
  mergeWorkspaceRouteSession,
  preserveWorkspaceRouteSession,
  removeWorkspaceRouteSession,
  sessionIdForLegacyWorkspaceInference,
  workspaceSessionRoute,
} from "./workspace-routes";
import {
  beginWorkspaceSessionLoad,
  completeWorkspaceSessionLoad,
  createWorkspaceSessionEndpointKey,
  failWorkspaceSessionLoad,
  shouldReloadWorkspaceSessions,
  type WorkspaceSessionLoadState,
} from "./workspace-session-load-state";

export type UseWorkspaceRouteStateInput = {
  developerMode: boolean;
  routeWorkspaceId?: string;
  routeSessionId?: string | null;
  /** Invoked when the jugglework-server settings-changed event fires (the route bumps its settings version). */
  onServerSettingsChanged: () => void;
  /** Receives the local jugglework-server host info discovered during refresh. */
  onHostInfo: (info: JuggleWorkServerInfo | null) => void;
};

type ModernRouteSessionResolution =
  | { key: string; status: "loading" }
  | { key: string; status: "not-found" | "error"; message: string };

export function useWorkspaceRouteState(input: UseWorkspaceRouteStateInput) {
  const { developerMode, onServerSettingsChanged, onHostInfo } = input;
  const navigate = useNavigate();
  const local = useLocal();
  const denAuth = useDenAuth();
  const params = useParams<{ workspaceId?: string; sessionId?: string }>();
  const routeWorkspaceId = input.routeWorkspaceId !== undefined
    ? input.routeWorkspaceId.trim()
    : params.workspaceId?.trim() || "";
  const selectedSessionId = input.routeSessionId !== undefined
    ? input.routeSessionId?.trim() || null
    : params.sessionId?.trim() || null;
  const workspaceInferenceSessionId = sessionIdForLegacyWorkspaceInference(routeWorkspaceId, selectedSessionId);
  const navigateToWorkspaceSession = useCallback((workspaceId: string, sessionId?: string | null, options?: { replace?: boolean }) => {
    const id = workspaceId.trim();
    if (!id) {
      navigate(legacySessionRoute(sessionId), options);
      return;
    }
    navigate(workspaceSessionRoute(id, sessionId), options);
  }, [navigate]);

  const { markRouteReady: markBootRouteReady } = useBootState();
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState<JuggleWorkServerClient | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [workspaceOrderIds, setWorkspaceOrderIds] = useState<string[]>(() => readWorkspaceOrderIds());
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, RouteSession[]>>({});
  const [workspaceSessionLoadStateById, setWorkspaceSessionLoadStateById] = useState<Record<string, WorkspaceSessionLoadState>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [workspaceConnectionOverrides, setWorkspaceConnectionOverrides] = useState<Record<string, WorkspaceConnectionState>>({});
  const [routeError, setRouteError] = useState<string | null>(null);
  const [modernRouteSessionResolution, setModernRouteSessionResolution] = useState<ModernRouteSessionResolution | null>(null);
  const [routeRefreshVersion, setRouteRefreshVersion] = useState(0);
  const [legacySelectedWorkspaceId, setLegacySelectedWorkspaceId] = useState<string>(() => readActiveWorkspaceId() ?? "");
  const selectedWorkspaceId = routeWorkspaceId || legacySelectedWorkspaceId;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? (selectedWorkspaceId ? null : workspaces[0] ?? null),
    [selectedWorkspaceId, workspaces],
  );
  // Workspace-scoped API calls (sessions, events, activate, opencode/*) must
  // hit the worker that owns the workspace, not the user's local server. The
  // single source of truth for that routing is `resolveWorkspaceEndpoint`.
  //
  // We refresh the memoized endpoint resolver behind a ref so the
  // `endpointForWorkspace` callback stays permanently stable. Otherwise it
  // would change on every `setBaseUrl`/`setToken`, which used to cascade up
  // through `loadWorkspaceSessionsInBackground` and `refreshRouteState` and
  // produce a tight render-refresh-setWorkspaces loop.
  const currentWorkspaceServerClientResolver = useMemo(
    () => createWorkspaceServerClientResolver({ baseUrl, token }),
    [baseUrl, token],
  );
  const workspaceServerClientResolverRef = useRef(currentWorkspaceServerClientResolver);
  workspaceServerClientResolverRef.current = currentWorkspaceServerClientResolver;
  const updateLocalServer = useCallback((next: { baseUrl: string; token: string }) => {
    const resolver = createWorkspaceServerClientResolver(next);
    workspaceServerClientResolverRef.current = resolver;
    return resolver;
  }, []);
  const endpointForWorkspace = useCallback(
    (workspace: RouteWorkspace | null | undefined): ResolvedWorkspaceEndpoint | null =>
      workspaceServerClientResolverRef.current(workspace),
    [],
  );
  const refreshInFlightRef = useRef(false);
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const workspaceOrderIdsRef = useRef(workspaceOrderIds);
  const remoteWorkspaceCheckRunRef = useRef<Record<string, string>>({});
  const remoteWorkspaceCheckRunCounterRef = useRef(0);
  const sessionsByWorkspaceIdRef = useRef<Record<string, RouteSession[]>>({});
  const workspaceSessionLoadStateByIdRef = useRef<Record<string, WorkspaceSessionLoadState>>({});
  const pendingCreatedSessionIdsRef = useRef<Record<string, Record<string, number>>>({});
  const hydratedRouteSessionIdsRef = useRef<Record<string, string>>({});
  const startupRetryTimerRef = useRef<number | null>(null);
  const [retryingWorkspaceIds, setRetryingWorkspaceIds] = useState<string[]>([]);
  const stabilizeWorkspaceOrder = useCallback((candidates: RouteWorkspace[]) => {
    const orderIds = resolveWorkspaceRefreshOrderIds(
      workspaceOrderIdsRef.current,
      workspacesRef.current,
    );
    const ordered = orderRouteWorkspaces(candidates, orderIds);

    // Seed a durable baseline after the first successful load and append newly
    // discovered workspaces without disturbing existing positions.
    const stableOrderIds = ordered.map((workspace) => workspace.id);
    const currentOrderIds = workspaceOrderIdsRef.current;
    if (
      stableOrderIds.length > 0
      && (stableOrderIds.length !== currentOrderIds.length
        || stableOrderIds.some((id, index) => id !== currentOrderIds[index]))
    ) {
      workspaceOrderIdsRef.current = stableOrderIds;
      setWorkspaceOrderIds(stableOrderIds);
      writeWorkspaceOrderIds(stableOrderIds);
    }

    return ordered;
  }, []);
  const launchActivatedWorkspaceIdsRef = useRef(new Set<string>());
  const reconnectAttemptedWorkspaceIdRef = useRef("");
  const backgroundSessionLoadInFlight = useRef<Map<string, { startedAt: number; endpointKey: string }>>(new Map());
  const updateWorkspaceSessionLoadState = useCallback((workspaceId: string, state: WorkspaceSessionLoadState) => {
    const next = { ...workspaceSessionLoadStateByIdRef.current, [workspaceId]: state };
    workspaceSessionLoadStateByIdRef.current = next;
    setWorkspaceSessionLoadStateById(next);
  }, []);
  const rememberPendingCreatedSession = useCallback((workspaceId: string, sessionId: string) => {
    const id = sessionId.trim();
    if (!workspaceId || !id) return;
    pendingCreatedSessionIdsRef.current[workspaceId] = {
      ...(pendingCreatedSessionIdsRef.current[workspaceId] ?? {}),
      [id]: Date.now(),
    };
  }, []);
  const mergeFetchedSessionsWithPending = useCallback((workspaceId: string, fetched: RouteSession[], current: RouteSession[]) => {
    const pending = pendingCreatedSessionIdsRef.current[workspaceId];
    let merged = fetched;
    if (pending) {
      const now = Date.now();
      const fetchedIds = new Set(fetched.flatMap((session) => session?.id ? [String(session.id)] : []));
      const pendingIds = Object.keys(pending);

      for (const id of pendingIds) {
        if (fetchedIds.has(id)) {
          delete pending[id];
        }
      }

      const preserved = current.filter((session) => {
        const id = String(session?.id ?? "");
        if (!id || fetchedIds.has(id)) return false;
        const createdAt = pending[id];
        if (typeof createdAt !== "number") return false;
        if (now - createdAt > 30_000) {
          delete pending[id];
          return false;
        }
        return true;
      });

      if (Object.keys(pending).length === 0) {
        delete pendingCreatedSessionIdsRef.current[workspaceId];
      }

      if (preserved.length > 0) merged = [...preserved, ...fetched];
    }

    const hydratedSessionId = hydratedRouteSessionIdsRef.current[workspaceId];
    if (hydratedSessionId && fetched.some((session) => session.id === hydratedSessionId)) {
      delete hydratedRouteSessionIdsRef.current[workspaceId];
      return merged;
    }
    return preserveWorkspaceRouteSession(
      merged,
      current,
      hydratedSessionId,
    );
  }, []);
  const loadWorkspaceSessionsInBackground = useCallback(
    async (
      workspaces: RouteWorkspace[],
      options: { force?: boolean; selectedWorkspaceId?: string } = {},
    ) => {
      const MAX_ATTEMPTS = 6;
      const backoffMs = (attempt: number) => Math.min(500 * Math.pow(2, attempt), 4_000);

      const fetchOnce = async (workspace: RouteWorkspace, attempt: number): Promise<void> => {
        const isRemoteJuggleWorkWorkspace = workspace.workspaceType === "remote" && workspace.remoteType !== "opencode";
        const endpoint = endpointForWorkspace(workspace);
        const endpointKey = createWorkspaceSessionEndpointKey(workspace, endpoint);
        if (!endpoint || !endpointKey) {
          const message = workspace.workspaceType === "remote"
            ? "Remote worker URL is missing. Edit connection and add a server URL."
            : "The local workspace server is not connected.";
          updateWorkspaceSessionLoadState(
            workspace.id,
            failWorkspaceSessionLoad(workspaceSessionLoadStateByIdRef.current[workspace.id], endpointKey, message),
          );
          if (workspace.workspaceType === "remote") {
            setErrorsByWorkspaceId((current) => ({ ...current, [workspace.id]: message }));
            setWorkspaceConnectionOverrides((current) => ({
              ...current,
              [workspace.id]: {
                status: "error",
                message,
                checkedAt: Date.now(),
              },
            }));
          }
          setRetryingWorkspaceIds((current) => current.filter((id) => id !== workspace.id));
          return;
        }

        const inFlight = backgroundSessionLoadInFlight.current.get(workspace.id);
        if (inFlight && inFlight.endpointKey === endpointKey && Date.now() - inFlight.startedAt < 5_000) return;
        const requestStartedAt = Date.now();
        backgroundSessionLoadInFlight.current.set(workspace.id, { startedAt: requestStartedAt, endpointKey });
        updateWorkspaceSessionLoadState(
          workspace.id,
          beginWorkspaceSessionLoad(workspaceSessionLoadStateByIdRef.current[workspace.id], endpointKey),
        );
        if (isRemoteJuggleWorkWorkspace) {
          setWorkspaceConnectionOverrides((current) => ({
            ...current,
            [workspace.id]: {
              status: "connecting",
              message: t("workspace_list.loading_remote_tasks"),
              checkedAt: null,
            },
          }));
        }

        try {
          const response = await endpoint.client.listSessions(endpoint.workspaceId, { limit: 200 });
          const fetchedItems = response.items ?? [];
          const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
          const items = workspaceRoot && !isRemoteJuggleWorkWorkspace
            ? fetchedItems.filter((session) =>
                normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
              )
            : fetchedItems;
          const currentEndpointKey = createWorkspaceSessionEndpointKey(workspace, endpointForWorkspace(workspace));
          if (currentEndpointKey !== endpointKey) return;

          setSessionsByWorkspaceId((current) => {
            const nextItems = mergeFetchedSessionsWithPending(workspace.id, items, current[workspace.id] ?? []);
            const next = { ...current, [workspace.id]: nextItems };
            sessionsByWorkspaceIdRef.current = next;
            return next;
          });
          updateWorkspaceSessionLoadState(workspace.id, completeWorkspaceSessionLoad(endpointKey));
          setErrorsByWorkspaceId((current) => ({ ...current, [workspace.id]: null }));
          setWorkspaceConnectionOverrides((current) => {
            if (isRemoteJuggleWorkWorkspace) {
              return {
                ...current,
                [workspace.id]: {
                  status: "connected",
                  message: items.length > 0
                    ? t("workspace_list.connected_loaded_tasks", { count: items.length })
                    : t("workspace.connected_no_tasks"),
                  checkedAt: Date.now(),
                },
              };
            }
            if (current[workspace.id]?.status !== "error") return current;
            const next = { ...current };
            delete next[workspace.id];
            return next;
          });
          setRetryingWorkspaceIds((current) => current.filter((id) => id !== workspace.id));

          // A successful empty response is authoritative, but one delayed
          // validation catches OpenCode while its cold-start index is warming.
          if (items.length === 0 && attempt === 0) {
            window.setTimeout(() => {
              if (backgroundSessionLoadInFlight.current.get(workspace.id)) return;
              void fetchOnce(workspace, 1);
            }, 3_000);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : t("app.unknown_error");
          if (attempt + 1 < MAX_ATTEMPTS && isTransientStartupError(message)) {
            const activeRequest = backgroundSessionLoadInFlight.current.get(workspace.id);
            if (activeRequest?.startedAt === requestStartedAt && activeRequest.endpointKey === endpointKey) {
              backgroundSessionLoadInFlight.current.delete(workspace.id);
            }
            await new Promise((resolve) => window.setTimeout(resolve, backoffMs(attempt)));
            await fetchOnce(workspace, attempt + 1);
            return;
          }

          const currentEndpointKey = createWorkspaceSessionEndpointKey(workspace, endpointForWorkspace(workspace));
          if (currentEndpointKey === endpointKey) {
            updateWorkspaceSessionLoadState(
              workspace.id,
              failWorkspaceSessionLoad(
                workspaceSessionLoadStateByIdRef.current[workspace.id],
                endpointKey,
                message,
              ),
            );
          }
          // Do not clear sessions here: a failed refresh keeps the last known
          // good list visible instead of making the workspace look data-less.
          if (workspace.workspaceType === "remote") {
            const connectionState = await diagnoseRemoteWorkspaceTaskLoadFailure(workspace, message);
            setErrorsByWorkspaceId((current) => ({
              ...current,
              [workspace.id]: connectionState.message ?? "Remote worker connection failed.",
            }));
            setWorkspaceConnectionOverrides((current) => ({
              ...current,
              [workspace.id]: connectionState,
            }));
          } else {
            setErrorsByWorkspaceId((current) => ({
              ...current,
              [workspace.id]: message,
            }));
          }
          setRetryingWorkspaceIds((current) => current.filter((id) => id !== workspace.id));
        } finally {
          const activeRequest = backgroundSessionLoadInFlight.current.get(workspace.id);
          if (activeRequest?.startedAt === requestStartedAt && activeRequest.endpointKey === endpointKey) {
            backgroundSessionLoadInFlight.current.delete(workspace.id);
          }
        }
      };

      const candidates = workspaces.filter((workspace) => {
        const endpointKey = createWorkspaceSessionEndpointKey(workspace, endpointForWorkspace(workspace));
        return shouldReloadWorkspaceSessions({
          state: workspaceSessionLoadStateByIdRef.current[workspace.id],
          endpointKey,
          force: options.force,
          selected: workspace.id === options.selectedWorkspaceId,
        });
      });
      if (candidates.length === 0) return;
      setRetryingWorkspaceIds((current) => Array.from(new Set([
        ...current,
        ...candidates.map((workspace) => workspace.id),
      ])));
      await Promise.all(candidates.map((workspace) => fetchOnce(workspace, 0)));
    },
    [endpointForWorkspace, mergeFetchedSessionsWithPending, updateWorkspaceSessionLoadState],
  );

  const refreshRouteState = useCallback(async () => {
    // Dedupe: if a refresh is already running, skip this call. Fast workspace
    // switches used to fire 5-6 overlapping refreshRouteState() calls which
    // each fetched workspaces + sessions for every workspace. That workload
    // multiplied quickly on the event loop and caused the UI to freeze.
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoading(true);
    setRouteError(null);
    let desktopList: WorkspaceList | null = null;
    let desktopWorkspaces = workspacesRef.current;
    let routeReadyAfterRefresh = true;
    try {
      if (isDesktopRuntime()) {
        try {
          desktopList = await workspaceBootstrap() as WorkspaceList;
          desktopWorkspaces = (desktopList.workspaces ?? []).map(mapDesktopWorkspace);
        } catch (error) {
          const message = describeRouteError(error);
          console.error("[session-route] workspaceBootstrap failed", error);
          recordInspectorEvent("route.workspace_bootstrap.error", {
            route: "session",
            message,
            preservedWorkspaceCount: workspacesRef.current.length,
          });
          desktopWorkspaces = workspacesRef.current;
        }
      }

      const { normalizedBaseUrl, resolvedToken, resolvedHostToken, hostInfo } = await resolveJuggleWorkConnection();
      onHostInfo(hostInfo);
      if (!normalizedBaseUrl || !resolvedToken) {
        // Keep the workspace endpoint resolver in lockstep with the disconnected state.
        // Otherwise a previously-cached baseUrl/token would still resolve a
        // (now invalid) endpoint for any callback that consults the resolver ref.
        updateLocalServer({ baseUrl: "", token: "" });
        setClient(null);
        setBaseUrl("");
        setToken("");
        const orderedDesktopWorkspaces = stabilizeWorkspaceOrder(desktopWorkspaces);
        setWorkspaces(orderedDesktopWorkspaces);
        sessionsByWorkspaceIdRef.current = {};
        setSessionsByWorkspaceId({});
        workspaceSessionLoadStateByIdRef.current = {};
        setWorkspaceSessionLoadStateById({});
        setErrorsByWorkspaceId({});
        setLegacySelectedWorkspaceId(resolveWorkspaceListSelectedId(desktopList) || orderedDesktopWorkspaces[0]?.id || "");
        return;
      }

      // Update the local-server resolver synchronously, BEFORE we kick off any
      // workspace-scoped requests below. `endpointForWorkspace` reads from
      // this resolver synchronously; the render that mirrors `[baseUrl,
      // token]` into the resolver doesn't run until after the next React commit,
      // which is too late for the `activateWorkspace` and
      // `loadWorkspaceSessionsInBackground` calls that fire later in this
      // function. Stale ref => `resolveWorkspaceEndpoint` returns null for
      // local workspaces => sidebar gets stuck in "loading" forever.
      const routeWorkspaceServerClientResolver = updateLocalServer({ baseUrl: normalizedBaseUrl, token: resolvedToken });

      const juggleworkClient = createJuggleWorkServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken || undefined,
      });
      const list = await juggleworkClient.listWorkspaces();
      const nextWorkspaces = stabilizeWorkspaceOrder(
        mergeRouteWorkspaces(list.items, desktopWorkspaces),
      );

      // Preserve any sessions we already have cached so switching routes
      // doesn't erase the sidebar while we refetch.
      const cachedEntries = nextWorkspaces.map((workspace) => ({
        workspaceId: workspace.id,
        sessions: sessionsByWorkspaceIdRef.current[workspace.id] ?? [],
      }));
      // Prefer, in order: the URL-selected workspace (if it owns the session),
      // the user's last-active workspace from localStorage, the desktop's
      // activeId, the server's activeId, then the first known workspace.
      const persistedActiveId = readActiveWorkspaceId();
      let nextWorkspaceId =
        (routeWorkspaceId && nextWorkspaces.some((w) => w.id === routeWorkspaceId)
          ? routeWorkspaceId
          : "") ||
        (persistedActiveId && nextWorkspaces.some((w) => w.id === persistedActiveId)
          ? persistedActiveId
          : "") ||
        resolveWorkspaceListSelectedId(desktopList) ||
        list.activeId?.trim() ||
        nextWorkspaces[0]?.id ||
        "";
      if (workspaceInferenceSessionId) {
        const match = cachedEntries.find((entry) =>
          entry.sessions.some((session) => session?.id === workspaceInferenceSessionId),
        );
        if (match?.workspaceId) nextWorkspaceId = match.workspaceId;
      }

      updateLocalServer({ baseUrl: normalizedBaseUrl, token: resolvedToken });

      setClient(juggleworkClient);
      setBaseUrl(normalizedBaseUrl);
      setToken(resolvedToken);
      setWorkspaces(nextWorkspaces);
      const nextSessionsByWorkspaceId = Object.fromEntries(cachedEntries.map((entry) => [entry.workspaceId, entry.sessions]));
      sessionsByWorkspaceIdRef.current = nextSessionsByWorkspaceId;
      setSessionsByWorkspaceId(nextSessionsByWorkspaceId);
      setErrorsByWorkspaceId((previous) => {
        const next: Record<string, string | null> = {};
        for (const workspace of nextWorkspaces) {
          next[workspace.id] = previous[workspace.id] ?? null;
        }
        return next;
      });
      setRetryingWorkspaceIds([]);
      setLegacySelectedWorkspaceId(nextWorkspaceId);
      writeActiveWorkspaceId(nextWorkspaceId || null);
      // Mark the chosen workspace as active on the server so that the
      // OpenCode engine bound to it re-reads opencode.jsonc and applies
      // permissions. TIPS: activation may dispose/rebuild the workspace
      // engine, so route readiness must not be released until it completes;
      // otherwise the first prompt can race /instance/dispose and abort.
      if (nextWorkspaceId && list.activeId !== nextWorkspaceId && !launchActivatedWorkspaceIdsRef.current.has(nextWorkspaceId)) {
        const nextWorkspace = nextWorkspaces.find((workspace) => workspace.id === nextWorkspaceId) ?? null;
        const nextEndpoint = routeWorkspaceServerClientResolver(nextWorkspace);
        if (nextEndpoint) {
          try {
            await serializeWorkspaceActivation(() => (
              nextEndpoint.client.activateWorkspace(nextEndpoint.workspaceId)
            ));
          } catch (error) {
            throw new Error(
              `[workspace_activation:${nextWorkspaceId}] ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          launchActivatedWorkspaceIdsRef.current.add(nextWorkspaceId);
        }
      }
      recordInspectorEvent("route.refresh.complete", {
        workspaces: nextWorkspaces.length,
        selectedWorkspaceId: nextWorkspaceId,
        errors: {},
      });

      // Session list comes from OpenCode's index and can be slow on cold
      // boot. Kick it off in the background instead of blocking the route
      // so the UI is interactive immediately; the sidebar shows a
      // loading state per-workspace until the list arrives.
      const selectedWorkspace = nextWorkspaces.find((workspace) => workspace.id === nextWorkspaceId);
      const backgroundWorkspaces = nextWorkspaces;
      if (backgroundWorkspaces.length > 0) {
        const orderedWorkspaces = selectedWorkspace
          ? [selectedWorkspace, ...backgroundWorkspaces.filter((workspace) => workspace.id !== selectedWorkspace.id)]
          : backgroundWorkspaces;
        void loadWorkspaceSessionsInBackground(orderedWorkspaces, {
          selectedWorkspaceId: nextWorkspaceId,
        });
      }
    } catch (error) {
      const message = describeRouteError(error);
      console.error("[session-route] refreshRouteState failed", error);
      recordInspectorEvent("route.refresh.error", {
        route: "session",
        message,
        preservedWorkspaceCount: desktopWorkspaces.length,
      });
      setRouteError(message);
      if (desktopWorkspaces.length > 0) {
        const orderedDesktopWorkspaces = stabilizeWorkspaceOrder(desktopWorkspaces);
        setWorkspaces(orderedDesktopWorkspaces);
        setLegacySelectedWorkspaceId((current) =>
          current || resolveWorkspaceListSelectedId(desktopList) || orderedDesktopWorkspaces[0]?.id || "",
        );
      }
    } finally {
      setLoading(false);
      refreshInFlightRef.current = false;
      setRouteRefreshVersion((current) => current + 1);
      // Tell the boot overlay the first route data load has completed so
      // the overlay dismisses after BOTH the desktop boot and the workspace
      // list/sessions are ready.
      if (routeReadyAfterRefresh) {
        markBootRouteReady();
      }
    }
  }, [loadWorkspaceSessionsInBackground, markBootRouteReady, routeWorkspaceId, stabilizeWorkspaceOrder, updateLocalServer, workspaceInferenceSessionId]);
  const handleRuntimeSessionUpdated = useCallback((update: { sessionId: string; info: Record<string, unknown> }) => {
    if (!selectedWorkspaceId) return;
    setSessionsByWorkspaceId((current) => {
      const list = current[selectedWorkspaceId] ?? [];
      const index = list.findIndex((session) => session?.id === update.sessionId);
      if (index < 0) return current;
      const nextSession = { ...list[index], ...update.info, id: update.sessionId };
      if (JSON.stringify(nextSession) === JSON.stringify(list[index])) return current;
      const nextList = [...list];
      nextList[index] = nextSession;
      const next = { ...current, [selectedWorkspaceId]: nextList };
      sessionsByWorkspaceIdRef.current = next;
      return next;
    });
  }, [selectedWorkspaceId]);
  const handleRuntimeSessionCreated = useCallback((session: Session) => {
    if (!selectedWorkspaceId) return;
    rememberPendingCreatedSession(selectedWorkspaceId, session.id);
    setSessionsByWorkspaceId((current) => {
      const list = current[selectedWorkspaceId] ?? [];
      const nextList = mergeWorkspaceRouteSession(list, session);
      if (nextList === list) return current;
      const next = { ...current, [selectedWorkspaceId]: nextList };
      sessionsByWorkspaceIdRef.current = next;
      return next;
    });
  }, [rememberPendingCreatedSession, selectedWorkspaceId]);
  const handleRuntimeSessionDeleted = useCallback((sessionId: string) => {
    if (!selectedWorkspaceId) return;
    setSessionsByWorkspaceId((current) => {
      const list = current[selectedWorkspaceId] ?? [];
      const nextList = removeWorkspaceRouteSession(list, sessionId);
      if (nextList === list) return current;
      const next = { ...current, [selectedWorkspaceId]: nextList };
      sessionsByWorkspaceIdRef.current = next;
      return next;
    });
  }, [selectedWorkspaceId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    workspaceOrderIdsRef.current = workspaceOrderIds;
  }, [workspaceOrderIds]);

  useEffect(() => {
    const activeWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setWorkspaceConnectionOverrides((current) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [workspaceId, state] of Object.entries(current)) {
        if (activeWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
    const nextLoadStates = Object.fromEntries(
      Object.entries(workspaceSessionLoadStateByIdRef.current).filter(([workspaceId]) => activeWorkspaceIds.has(workspaceId)),
    );
    if (Object.keys(nextLoadStates).length !== Object.keys(workspaceSessionLoadStateByIdRef.current).length) {
      workspaceSessionLoadStateByIdRef.current = nextLoadStates;
      setWorkspaceSessionLoadStateById(nextLoadStates);
    }
  }, [workspaces]);

  useEffect(() => {
    sessionsByWorkspaceIdRef.current = sessionsByWorkspaceId;
  }, [sessionsByWorkspaceId]);

  useEffect(() => {
    workspaceSessionLoadStateByIdRef.current = workspaceSessionLoadStateById;
  }, [workspaceSessionLoadStateById]);

  const handleRemoteWorkspaceConnectionSaved = useCallback(
    async (workspaceId: string) => {
      delete remoteWorkspaceCheckRunRef.current[workspaceId];
      setWorkspaceConnectionOverrides((current) => {
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      setRetryingWorkspaceIds((current) => current.filter((id) => id !== workspaceId));
      await refreshRouteState();
    },
    [refreshRouteState],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (cancelled) return;
        await refreshRouteState();
      } finally {
        if (cancelled) return;
      }
    })();

    const handleSettingsChange = () => {
      onServerSettingsChanged();
      // Self-heal: if the previous refresh got stuck mid-flight (e.g. macOS
      // backgrounded the webview and never let a fetch resolve), clear the
      // guard so a re-entry after resume actually goes through.
      refreshInFlightRef.current = false;
      void refreshRouteState();
    };
    window.addEventListener("jugglework-server-settings-changed", handleSettingsChange);

    // Also retry on visibility flip independently — even when nobody else
    // dispatches the settings event.
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      refreshInFlightRef.current = false;
      void refreshRouteState();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelled = true;
      if (startupRetryTimerRef.current !== null) {
        window.clearTimeout(startupRetryTimerRef.current);
        startupRetryTimerRef.current = null;
      }
      window.removeEventListener("jugglework-server-settings-changed", handleSettingsChange);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [refreshRouteState]);

  // Inspector wiring: publish the route's current state so an external
  // operator (or an AI driver using browser tools) can call
  // `window.__jugglework.snapshot()` or `window.__jugglework.slice("route")` and
  // see workspaces / sessions / connection info without walking the DOM.
  useEffect(() => {
    const dispose = publishInspectorSlice("route", () => ({
      loading,
      retryingWorkspaceIds,
      baseUrl,
      tokenPresent: token.length > 0,
      connected: Boolean(client),
      routeError,
      selectedSessionId,
      selectedWorkspaceId,
      persistedActiveWorkspaceId: readActiveWorkspaceId(),
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        displayNameResolved: workspace.displayNameResolved,
        workspaceType: workspace.workspaceType,
        path: workspace.path,
        sessionCount: (sessionsByWorkspaceId[workspace.id] ?? []).length,
        loading: retryingWorkspaceIds.includes(workspace.id),
        error: errorsByWorkspaceId[workspace.id] ?? null,
        sessionLoadState: workspaceSessionLoadStateById[workspace.id]
          ? {
              status: workspaceSessionLoadStateById[workspace.id].status,
              loadedAt: workspaceSessionLoadStateById[workspace.id].loadedAt,
              error: workspaceSessionLoadStateById[workspace.id].error,
            }
          : null,
      })),
      sessionsByWorkspaceId: Object.fromEntries(
        Object.entries(sessionsByWorkspaceId).map(([wsId, items]) => [
          wsId,
          (items ?? []).map((session) => ({
            id: session?.id ?? null,
            title: session?.title ?? null,
            directory: session?.directory ?? null,
          })),
        ]),
      ),
    }));
    return dispose;
  }, [
    baseUrl,
    client,
    errorsByWorkspaceId,
    loading,
    retryingWorkspaceIds,
    selectedSessionId,
    selectedWorkspaceId,
    routeError,
    sessionsByWorkspaceId,
    workspaceSessionLoadStateById,
    token,
    workspaces,
  ]);

  // Once workspaces + sessions are loaded and the URL has no sessionId, try to
  // restore the last session the user opened in the active workspace.
  useEffect(() => {
    if (loading) return;
    if (routeWorkspaceId && workspaces.length > 0 && !workspaces.some((workspace) => workspace.id === routeWorkspaceId)) {
      const fallbackWorkspaceId = workspaces.some((workspace) => workspace.id === legacySelectedWorkspaceId)
        ? legacySelectedWorkspaceId
        : workspaces[0]?.id || "";
      if (fallbackWorkspaceId) {
        navigateToWorkspaceSession(fallbackWorkspaceId, selectedSessionId, { replace: true });
      }
      return;
    }
    if (!routeWorkspaceId && selectedWorkspaceId) {
      navigateToWorkspaceSession(selectedWorkspaceId, selectedSessionId, { replace: true });
      return;
    }
    if (selectedSessionId) return;
    if (!selectedWorkspaceId) return;
    const remembered = readLastSessionFor(selectedWorkspaceId);
    if (!remembered) return;
    const sessions = sessionsByWorkspaceId[selectedWorkspaceId] ?? [];
    if (!sessions.some((session) => session?.id === remembered)) return;
    navigateToWorkspaceSession(selectedWorkspaceId, remembered, { replace: true });
  }, [
    loading,
    legacySelectedWorkspaceId,
    navigateToWorkspaceSession,
    routeWorkspaceId,
    selectedSessionId,
    selectedWorkspaceId,
    sessionsByWorkspaceId,
    workspaces,
  ]);

  // Redirect to /welcome when no workspaces exist and the user hasn't
  // completed onboarding. Desktop only does this for the default hosted
  // bootstrap; org-bound desktops should keep their sign-in gate instead.
  useEffect(() => {
    if (loading) return;
    if (workspaces.length > 0) return;
    if (local.prefs.hasCompletedOnboarding) return;
    if (isDesktopRuntime()) {
      if (denAuth.status === "checking") return;
      if (denAuth.isSignedIn) return;
      if (readDenBootstrapConfig().source !== "default") return;
    }
    navigate("/welcome", { replace: true });
  }, [denAuth.isSignedIn, denAuth.status, loading, local.prefs.hasCompletedOnboarding, navigate, workspaces.length]);

  // NOTE: Blueprint seeding was removed from the route.
  // It was firing `materializeBlueprintSessions` + a session re-fetch on every
  // workspace change, which cascaded setState updates and froze the UI after
  // a few rapid switches. Empty workspaces now simply show "No tasks yet." and
  // the user creates their first session explicitly via "New task". Seeding
  // can be reintroduced later as a one-shot triggered from a button or from
  // the onboarding flow, not from the route effect loop.
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    if (loading) return;
    if (client) {
      reconnectAttemptedWorkspaceIdRef.current = "";
      return;
    }
    if (!selectedWorkspace || selectedWorkspace.workspaceType !== "local") return;
    const workspaceId = selectedWorkspace.id?.trim() ?? "";
    if (!workspaceId || reconnectAttemptedWorkspaceIdRef.current === workspaceId) return;
    reconnectAttemptedWorkspaceIdRef.current = workspaceId;

    void ensureDesktopLocalJuggleWorkConnection({
      route: "session",
      workspace: selectedWorkspace,
      allWorkspaces: workspaces,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : describeRouteError(error);
      setRouteError(message);
    });
  }, [client, loading, selectedWorkspace, workspaces]);

  const selectedWorkspaceRoot = selectedWorkspace?.path?.trim() || "";
  // Single source of truth for the selected workspace's server URL/token/id.
  // For remote workspaces this is the worker that owns the workspace; for
  // local workspaces it's the user's local JuggleWork server.
  const selectedWorkspaceEndpoint = useWorkspaceServerClient(selectedWorkspace, { baseUrl, token });
  const selectedWorkspaceServerToken = selectedWorkspaceEndpoint?.token ?? "";
  const opencodeBaseUrl = selectedWorkspaceEndpoint?.opencodeBaseUrl ?? "";
  const selectedWorkspaceError = errorsByWorkspaceId[selectedWorkspaceId] ?? null;
  const selectedSessionKnown = Boolean(
    selectedSessionId &&
      (sessionsByWorkspaceId[selectedWorkspaceId] ?? []).some((session) => session?.id === selectedSessionId),
  );
  const modernRouteSessionLoadKey = routeWorkspaceId && selectedSessionId && selectedWorkspace && selectedWorkspaceEndpoint
    ? JSON.stringify([
        routeWorkspaceId,
        selectedSessionId,
        selectedWorkspaceEndpoint.baseUrl,
        selectedWorkspaceEndpoint.workspaceId,
        selectedWorkspaceEndpoint.token,
        routeRefreshVersion,
      ])
    : "";
  const modernRouteSessionLoadPending = Boolean(
    modernRouteSessionLoadKey &&
      !selectedSessionKnown &&
      (modernRouteSessionResolution?.key !== modernRouteSessionLoadKey || modernRouteSessionResolution.status === "loading"),
  );
  const activeModernRouteSessionResolution = modernRouteSessionResolution?.key === modernRouteSessionLoadKey
    ? modernRouteSessionResolution
    : null;
  const selectedWorkspaceIsLoading = retryingWorkspaceIds.includes(selectedWorkspaceId) || modernRouteSessionLoadPending;
  useEffect(() => {
    const stale = Object.entries(hydratedRouteSessionIdsRef.current).filter(
      ([workspaceId, sessionId]) => workspaceId !== selectedWorkspaceId || sessionId !== selectedSessionId,
    );
    if (stale.length === 0) return;
    for (const [workspaceId] of stale) delete hydratedRouteSessionIdsRef.current[workspaceId];
    setSessionsByWorkspaceId((current) => {
      let next = current;
      for (const [workspaceId, sessionId] of stale) {
        const items = current[workspaceId] ?? [];
        const filtered = removeWorkspaceRouteSession(items, sessionId);
        if (filtered === items) continue;
        if (next === current) next = { ...current };
        next[workspaceId] = filtered;
      }
      if (next !== current) sessionsByWorkspaceIdRef.current = next;
      return next;
    });
  }, [selectedSessionId, selectedWorkspaceId]);
  useEffect(() => {
    if (!modernRouteSessionLoadKey || !selectedWorkspaceEndpoint || !selectedSessionId) {
      setModernRouteSessionResolution(null);
      return;
    }
    if (selectedSessionKnown) {
      setModernRouteSessionResolution(null);
      return;
    }
    let cancelled = false;
    setModernRouteSessionResolution({ key: modernRouteSessionLoadKey, status: "loading" });

    const hydrateSelectedSession = async () => {
      const maxAttempts = 6;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (cancelled) return;
        try {
          const response = await selectedWorkspaceEndpoint.client.getSession(
            selectedWorkspaceEndpoint.workspaceId,
            selectedSessionId,
          );
          if (cancelled) return;
          if (response.item.id !== selectedSessionId) {
            setModernRouteSessionResolution({
              key: modernRouteSessionLoadKey,
              status: "error",
              message: "The server returned a different session.",
            });
            return;
          }
          setSessionsByWorkspaceId((current) => {
            const currentItems = current[selectedWorkspaceId] ?? [];
            if (currentItems.some((session) => session.id === selectedSessionId)) {
              delete hydratedRouteSessionIdsRef.current[selectedWorkspaceId];
              return current;
            }
            hydratedRouteSessionIdsRef.current[selectedWorkspaceId] = selectedSessionId;
            const nextItems = mergeWorkspaceRouteSession(currentItems, response.item);
            const next = { ...current, [selectedWorkspaceId]: nextItems };
            sessionsByWorkspaceIdRef.current = next;
            return next;
          });
          setErrorsByWorkspaceId((current) => ({ ...current, [selectedWorkspaceId]: null }));
          setModernRouteSessionResolution(null);
          return;
        } catch (error) {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : describeRouteError(error);
          const kind = classifyRouteSessionReadError(error);
          if (kind !== "retryable" || attempt + 1 >= maxAttempts) {
            setModernRouteSessionResolution({
              key: modernRouteSessionLoadKey,
              status: kind === "not-found" ? "not-found" : "error",
              message,
            });
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(500 * Math.pow(2, attempt), 4_000)));
          if (cancelled) return;
        }
      }
    };

    void hydrateSelectedSession();

    return () => {
      cancelled = true;
    };
  }, [modernRouteSessionLoadKey, selectedSessionId, selectedSessionKnown, selectedWorkspaceId]);
  const routeNotFoundMessage = (() => {
    if (loading) return null;
    if (routeWorkspaceId && !selectedWorkspace) {
      return "Workspace was not found. Select a new workspace from the sidebar.";
    }
    if (selectedSessionId && !selectedSessionKnown && activeModernRouteSessionResolution?.status === "not-found") {
      return "Session was not found. Select a new session from the sidebar.";
    }
    if (selectedSessionId && !selectedSessionKnown && activeModernRouteSessionResolution?.status === "error") {
      return `Session could not be loaded. ${activeModernRouteSessionResolution.message}`;
    }
    return null;
  })();
  // Boot-level loading blocks the whole UI. Session-list retries only fill the
  // sidebar; they must not gate the composer/New task.
  const effectiveLoading = loading;

  const opencodeClient = useMemo(
    () =>
      opencodeBaseUrl && selectedWorkspaceServerToken && !selectedWorkspaceError
        ? createClient(opencodeBaseUrl, selectedWorkspaceRoot || undefined, {
            token: selectedWorkspaceServerToken,
            mode: "jugglework",
          })
        : null,
    [opencodeBaseUrl, selectedWorkspaceError, selectedWorkspaceRoot, selectedWorkspaceServerToken],
  );
  useEffect(() => {
    if (!developerMode || !opencodeClient) return;
    return publishInspectorOpencodeClient(opencodeClient);
  }, [developerMode, opencodeClient]);
  const runRemoteWorkspaceConnectionCheck = useCallback(
    async (workspaceId: string, mode: "test" | "recover") => {
      const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (!workspace || workspace.workspaceType !== "remote") return false;
      const connectionKey = getRemoteWorkspaceConnectionKey(workspace);
      remoteWorkspaceCheckRunCounterRef.current += 1;
      const runId = String(remoteWorkspaceCheckRunCounterRef.current);
      remoteWorkspaceCheckRunRef.current[workspaceId] = runId;

      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: {
          status: "connecting",
          message: t("config.testing_connection"),
          checkedAt: null,
        },
      }));

      const result = await testRemoteWorkspaceConnection(workspace);
      const currentWorkspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (
        remoteWorkspaceCheckRunRef.current[workspaceId] !== runId ||
        !currentWorkspace ||
        getRemoteWorkspaceConnectionKey(currentWorkspace) !== connectionKey
      ) {
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }
      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: result.state,
      }));

      if (!result.ok) {
        setErrorsByWorkspaceId((current) => ({
          ...current,
          [workspaceId]: result.state.message ?? "Remote worker connection failed.",
        }));
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }

      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      setRetryingWorkspaceIds((current) => current.filter((id) => id !== workspaceId));
      if (mode === "recover") {
        await refreshRouteState();
      }
      if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
        delete remoteWorkspaceCheckRunRef.current[workspaceId];
      }
      return true;
    },
    [refreshRouteState],
  );

  return {
    navigateToWorkspaceSession,
    routeWorkspaceId,
    selectedSessionId,
    loading,
    effectiveLoading,
    client,
    baseUrl,
    token,
    workspaces,
    setWorkspaces,
    workspacesRef,
    workspaceOrderIds,
    setWorkspaceOrderIds,
    workspaceOrderIdsRef,
    sessionsByWorkspaceId,
    workspaceSessionLoadStateById,
    setSessionsByWorkspaceId,
    sessionsByWorkspaceIdRef,
    errorsByWorkspaceId,
    setErrorsByWorkspaceId,
    workspaceConnectionOverrides,
    routeError,
    setRouteError,
    legacySelectedWorkspaceId,
    setLegacySelectedWorkspaceId,
    retryingWorkspaceIds,
    setRetryingWorkspaceIds,
    refreshInFlightRef,
    startupRetryTimerRef,
    selectedWorkspaceId,
    selectedWorkspace,
    selectedWorkspaceRoot,
    selectedWorkspaceEndpoint,
    selectedWorkspaceServerToken,
    opencodeBaseUrl,
    opencodeClient,
    selectedWorkspaceIsLoading,
    selectedWorkspaceError,
    routeNotFoundMessage,
    endpointForWorkspace,
    refreshRouteState,
    loadWorkspaceSessionsInBackground,
    rememberPendingCreatedSession,
    handleRuntimeSessionCreated,
    handleRuntimeSessionUpdated,
    handleRuntimeSessionDeleted,
    handleRemoteWorkspaceConnectionSaved,
    runRemoteWorkspaceConnectionCheck,
  };
}
