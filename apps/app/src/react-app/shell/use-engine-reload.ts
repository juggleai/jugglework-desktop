// Engine reload wiring for the session route: UI-triggered engine reload,
// reload-coordinator registration, the post-org-onboarding reload latch,
// server reload-event polling, and desktop engine info. Extracted verbatim
// from session-route.tsx; reload events are now typed (JuggleWorkReloadEvent)
// instead of `any`.
import { useCallback, useEffect, useRef, useState } from "react";

import { engineInfo, engineRestart } from "@/app/lib/desktop";
import type { EngineInfo } from "@/app/lib/desktop-types";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { JuggleWorkServerError, type JuggleWorkReloadEvent, type JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { t } from "@/i18n";
import { useReloadCoordinator } from "./reload-coordinator";
import { refreshProviderListQueries } from "@/react-app/infra/provider-list-query";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import type { RouteWorkspace } from "./route-workspaces";
import { toast } from "@/components/ui/sonner";

const reloadAfterOrgOnboardingKey = "jugglework.reloadAfterOrgOnboarding";

function taskCreateUnavailableToastId(workspaceId: string) {
  return `opencode-unavailable:${workspaceId}`;
}

/**
 * After a workspace activation the server rewrites the shared runtime config
 * (and, in watched deployments, the file watcher echoes that write back as a
 * config reload event). The activation call already reloaded the engine
 * server-side — switch reloads stay (#870) — so that echo is redundant:
 * consuming it keeps the deferred poll → debounce → auto-reload path from
 * re-running an engine reload on every workspace switch.
 */
export const ACTIVATION_CONFIG_ECHO_GRACE_MS = 2500;

/**
 * Hard deadline for the best-effort refreshes that follow an engine reload
 * (provider list + route state). Neither react-query refetches nor the
 * OpenCode SDK carry a request timeout, so a single stalled active query
 * would otherwise leave `reloadBusy` true forever — which wedges the session
 * MCP maintenance loop in "checking" and the status bar in "Checking".
 */
export const ENGINE_RELOAD_REFRESH_DEADLINE_MS = 20_000;

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** True when a polled reload event is made redundant by our own recent
 * activation. Only config-reason events are suppressed: the activation's
 * inline engine reload already applied the current on-disk state, so both
 * the activation's own config echo and any still-unconsumed config event
 * from before the activation need no further reload. Skill/agent/command
 * mutations observed in the window still reload normally. */
export function isActivationConfigEcho(
  event: Pick<JuggleWorkReloadEvent, "reason" | "timestamp">,
  activationCompletedAt: number | null | undefined,
): boolean {
  if (!activationCompletedAt) return false;
  if (event.reason !== "config") return false;
  const timestamp = typeof event.timestamp === "number" ? event.timestamp : 0;
  return timestamp > 0 && timestamp <= activationCompletedAt + ACTIVATION_CONFIG_ECHO_GRACE_MS;
}

export type UseEngineReloadInput = {
  client: JuggleWorkServerClient | null;
  workspaceId: string;
  workspace: RouteWorkspace | null | undefined;
  endpointForWorkspace: (
    workspace: RouteWorkspace | null | undefined,
  ) => ResolvedWorkspaceEndpoint | null;
  activeReloadBlockingSessions: { id: string; title: string }[];
  onError: (message: string) => void;
  refreshRouteState: () => Promise<void>;
};

export function useEngineReload(input: UseEngineReloadInput) {
  const {
    client,
    workspaceId,
    workspace,
    endpointForWorkspace,
    activeReloadBlockingSessions,
    onError,
    refreshRouteState,
  } = input;
  const reloadCoordinator = useReloadCoordinator();
  const [engineReloadVersion, setEngineReloadVersion] = useState(0);
  const [routeEngineInfo, setRouteEngineInfo] = useState<EngineInfo | null>(null);
  const reloadEventCursorByWorkspaceRef = useRef<Record<string, number | null>>({});
  const activationConfigEchoByWorkspaceRef = useRef<Record<string, number>>({});

  /**
   * Called right after a successful workspace activation. The server already
   * reloaded the engine inline (switch reloads stay, #870) and rewrote the
   * shared runtime config, so:
   *  1. any pending reload state for the previous workspace is stale and
   *     must not fire on the newly activated one, and
   *  2. config-reason reload events arriving within the echo grace window
   *     are consumed instead of marking another reload required.
   * Skill/agent/command mutations in the window still reload normally.
   */
  const noteWorkspaceActivationCompleted = useCallback((activatedWorkspaceId: string, endpoint: ResolvedWorkspaceEndpoint) => {
    const activationCompletedAt = Date.now();
    activationConfigEchoByWorkspaceRef.current[activatedWorkspaceId] = activationCompletedAt;
    reloadCoordinator.clearReloadRequired();
    // Absorb the config echo immediately: the server may have recorded the
    // runtime-config write just before responding (its own 750 ms event
    // debounce can also delay the record past this point, so per-event grace
    // is checked again on every poll).
    const cursor = reloadEventCursorByWorkspaceRef.current[activatedWorkspaceId];
    if (typeof cursor !== "number") return;
    void endpoint.client
      .listReloadEvents(endpoint.workspaceId, { since: cursor })
      .then((response) => {
        for (const event of response.items ?? []) {
          if (isActivationConfigEcho(event, activationCompletedAt)) {
            reloadEventCursorByWorkspaceRef.current[activatedWorkspaceId] = Math.max(
              cursor,
              Number(event.seq) || 0,
            );
          }
        }
      })
      .catch(() => undefined);
  }, [reloadCoordinator]);

  const reloadWorkspaceEngineFromUi = useCallback(async () => {
    if (!client || !workspaceId) {
      onError(t("app.error_connect_first"));
      return false;
    }
    const endpoint = endpointForWorkspace(workspace);
    if (!endpoint) {
      onError(t("app.error_connect_first"));
      return false;
    }
    let restartedEngine = false;
    try {
      await endpoint.client.reloadEngine(endpoint.workspaceId);
    } catch (error) {
      const unreachable =
        error instanceof JuggleWorkServerError && error.code === "opencode_engine_unreachable";
      if (!unreachable || !isDesktopRuntime()) {
        throw error;
      }
      await engineRestart({});
      restartedEngine = true;
    }
    if (restartedEngine) {
      await withDeadline(refreshRouteState(), ENGINE_RELOAD_REFRESH_DEADLINE_MS);
      await withDeadline(refreshProviderListQueries(getReactQueryClient()), ENGINE_RELOAD_REFRESH_DEADLINE_MS);
    } else {
      await withDeadline(refreshProviderListQueries(getReactQueryClient()), ENGINE_RELOAD_REFRESH_DEADLINE_MS);
    }
    setEngineReloadVersion((v) => v + 1);
    try {
      window.dispatchEvent(new CustomEvent("jugglework-server-settings-changed"));
    } catch {
      // ignore browser event dispatch failures
    }
    if (!restartedEngine) {
      await withDeadline(refreshRouteState(), ENGINE_RELOAD_REFRESH_DEADLINE_MS);
    }
    toast.dismiss(taskCreateUnavailableToastId(workspaceId));
    toast.dismiss();
    return true;
  }, [client, endpointForWorkspace, onError, refreshRouteState, workspace, workspaceId]);

  useEffect(() => {
    return reloadCoordinator.registerWorkspaceReloadControls({
      canReloadWorkspaceEngine: () => Boolean(client && workspaceId),
      reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
      activeSessions: () => activeReloadBlockingSessions,
    });
  }, [activeReloadBlockingSessions, client, reloadCoordinator, reloadWorkspaceEngineFromUi, workspaceId]);

  useEffect(() => {
    if (!reloadCoordinator.canReloadWorkspaceEngine) return;
    try {
      if (window.localStorage.getItem(reloadAfterOrgOnboardingKey) !== "1") return;
      window.localStorage.removeItem(reloadAfterOrgOnboardingKey);
    } catch {
      return;
    }
    // Marking is enough: the reload coordinator auto-reloads once idle.
    reloadCoordinator.markReloadRequired("config", {
      type: "config",
      name: "opencode.json",
      action: "updated",
    });
  }, [reloadCoordinator, reloadCoordinator.canReloadWorkspaceEngine]);

  useEffect(() => {
    if (!client || !workspaceId) return;
    const endpoint = endpointForWorkspace(workspace);
    if (!endpoint) return;
    let cancelled = false;

    const pollReloadEvents = async () => {
      const currentCursor = reloadEventCursorByWorkspaceRef.current[workspaceId];
      try {
        const response = await endpoint.client.listReloadEvents(
          endpoint.workspaceId,
          typeof currentCursor === "number" ? { since: currentCursor } : undefined,
        );
        if (cancelled) return;
        reloadEventCursorByWorkspaceRef.current[workspaceId] =
          typeof response.cursor === "number"
            ? response.cursor
            : Math.max(currentCursor ?? 0, ...((response.items ?? []).map((item) => Number(item.seq) || 0)));
        // The first poll establishes the server cursor so historical reload
        // events don't show a stale toast on route entry. Subsequent polls mark
        // new filesystem/server-side mutations, including skills created by an
        // agent while the session page is open.
        if (currentCursor === undefined || currentCursor === null) return;
        const activationEchoAt = activationConfigEchoByWorkspaceRef.current[workspaceId];
        for (const event of response.items ?? []) {
          if (isActivationConfigEcho(event, activationEchoAt)) continue;
          reloadCoordinator.markReloadRequired(event.reason, event.trigger);
        }      } catch {
        // Reload-event polling is best-effort; normal route health checks still
        // surface connection failures.
      }
    };

    void pollReloadEvents();
    const interval = window.setInterval(() => void pollReloadEvents(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, endpointForWorkspace, reloadCoordinator, workspace, workspaceId]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void engineInfo()
      .then((info) => {
        // Pre-existing cast: the desktop bridge is a dynamic Proxy, so
        // engineInfo() returns unknown until the IPC surface is typed
        // (queued: DesktopCommandMap).
        if (!cancelled) setRouteEngineInfo(info as EngineInfo | null);
      })
      .catch(() => {
        if (!cancelled) setRouteEngineInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { engineReloadVersion, routeEngineInfo, reloadWorkspaceEngineFromUi, noteWorkspaceActivationCompleted };
}
