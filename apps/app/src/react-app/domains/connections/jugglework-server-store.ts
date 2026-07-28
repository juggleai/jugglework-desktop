import { useSyncExternalStore } from "react";

import { t } from "../../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../../../app/types";
import { isDesktopRuntime } from "../../../app/utils";
import {
  juggleworkServerInfo,
  juggleworkServerRestart,
  type JuggleWorkServerInfo,
} from "../../../app/lib/desktop";
import {
  clearJuggleWorkServerSettings,
  createJuggleWorkServerClient,
  isLoopbackJuggleWorkServerUrl,
  normalizeJuggleWorkServerUrl,
  readJuggleWorkServerSettings,
  writeJuggleWorkServerSettings,
  type JuggleWorkAuditEntry,
  type JuggleWorkServerCapabilities,
  type JuggleWorkServerClient,
  type JuggleWorkServerDiagnostics,
  type JuggleWorkServerError,
  type JuggleWorkServerSettings,
  type JuggleWorkServerStatus,
} from "../../../app/lib/jugglework-server";

type SetStateAction<T> = T | ((current: T) => T);

type RemoteWorkspaceInput = {
  juggleworkHostUrl: string;
  juggleworkToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type JuggleWorkServerStoreSnapshot = {
  juggleworkServerSettings: JuggleWorkServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  juggleworkServerUrl: string;
  juggleworkServerBaseUrl: string;
  juggleworkServerAuth: { token?: string; hostToken?: string };
  juggleworkServerClient: JuggleWorkServerClient | null;
  juggleworkServerStatus: JuggleWorkServerStatus;
  juggleworkServerCapabilities: JuggleWorkServerCapabilities | null;
  juggleworkServerReady: boolean;
  juggleworkServerWorkspaceReady: boolean;
  resolvedJuggleWorkCapabilities: JuggleWorkServerCapabilities | null;
  juggleworkServerCanWriteSkills: boolean;
  juggleworkServerCanWritePlugins: boolean;
  juggleworkServerHostInfo: JuggleWorkServerInfo | null;
  juggleworkServerDiagnostics: JuggleWorkServerDiagnostics | null;
  juggleworkReconnectBusy: boolean;
  juggleworkAuditEntries: JuggleWorkAuditEntry[];
  juggleworkAuditStatus: "idle" | "loading" | "error";
  juggleworkAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

export type JuggleWorkServerStore = ReturnType<typeof createJuggleWorkServerStore>;

type CreateJuggleWorkServerStoreOptions = {
  startupPreference: () => StartupPreference | null;
  documentVisible: () => boolean;
  developerMode: () => boolean;
  runtimeWorkspaceId: () => string | null;
  activeClient: () => unknown | null;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  restartLocalServer: () => Promise<boolean>;
  createRemoteWorkspaceFlow: (input: RemoteWorkspaceInput) => Promise<boolean>;
};

type MutableState = {
  juggleworkServerSettings: JuggleWorkServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  juggleworkServerUrl: string;
  juggleworkServerStatus: JuggleWorkServerStatus;
  juggleworkServerCapabilities: JuggleWorkServerCapabilities | null;
  juggleworkServerCheckedAt: number | null;
  juggleworkServerHostInfo: JuggleWorkServerInfo | null;
  juggleworkServerHostInfoReady: boolean;
  juggleworkServerDiagnostics: JuggleWorkServerDiagnostics | null;
  juggleworkReconnectBusy: boolean;
  juggleworkAuditEntries: JuggleWorkAuditEntry[];
  juggleworkAuditStatus: "idle" | "loading" | "error";
  juggleworkAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

export function createJuggleWorkServerStore(options: CreateJuggleWorkServerStoreOptions) {
  const bootStartedAt = Date.now();
  const listeners = new Set<() => void>();
  const intervals = new Map<string, number>();

  let clientCacheKey = "";
  let clientCacheValue: JuggleWorkServerClient | null = null;
  let started = false;
  let disposed = false;
  let healthTimeoutId: number | null = null;
  let healthBusy = false;
  let healthDelayMs = 10_000;
  let consecutiveHealthFailures = 0;
  let visibilityChangeHandler: (() => void) | null = null;
  let snapshot: JuggleWorkServerStoreSnapshot;

  let state: MutableState = {
    juggleworkServerSettings: readJuggleWorkServerSettings(),
    shareRemoteAccessBusy: false,
    shareRemoteAccessError: null,
    juggleworkServerUrl: "",
    juggleworkServerStatus: "disconnected",
    juggleworkServerCapabilities: null,
    juggleworkServerCheckedAt: null,
    juggleworkServerHostInfo: null,
    juggleworkServerHostInfoReady: !isDesktopRuntime(),
    juggleworkServerDiagnostics: null,
    juggleworkReconnectBusy: false,
    juggleworkAuditEntries: [],
    juggleworkAuditStatus: "idle",
    juggleworkAuditError: null,
    devtoolsWorkspaceId: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getBaseUrl = () => {
    const pref = options.startupPreference();
    const hostInfo = state.juggleworkServerHostInfo;
    const settingsUrl = normalizeJuggleWorkServerUrl(state.juggleworkServerSettings.urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server" && settingsUrl && isLoopbackJuggleWorkServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return hostInfo.baseUrl;
    }
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  };

  const getAuth = () => {
    const pref = options.startupPreference();
    const hostInfo = state.juggleworkServerHostInfo;
    const settingsUrl = normalizeJuggleWorkServerUrl(state.juggleworkServerSettings.urlOverride ?? "") ?? "";
    const settingsToken = state.juggleworkServerSettings.token?.trim() ?? "";
    const settingsHostToken = state.juggleworkServerSettings.hostToken?.trim() ?? "";
    const clientToken = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";

    if (pref === "local") {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    if (pref === "server" && settingsUrl && isLoopbackJuggleWorkServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return {
        token: clientToken || settingsToken || undefined,
        hostToken: hostToken || settingsHostToken || undefined,
      };
    }
    if (pref === "server") {
      return {
        token: settingsToken || undefined,
        hostToken: settingsUrl && isLoopbackJuggleWorkServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
      };
    }
    if (hostInfo?.baseUrl) {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    return {
      token: settingsToken || undefined,
      hostToken: settingsUrl && isLoopbackJuggleWorkServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
    };
  };

  const getClient = () => {
    const baseUrl = getBaseUrl().trim();
    if (!baseUrl) {
      clientCacheKey = "";
      clientCacheValue = null;
      return null;
    }

    const auth = getAuth();
    const key = `${baseUrl}::${auth.token ?? ""}::${auth.hostToken ?? ""}`;
    if (key !== clientCacheKey) {
      clientCacheKey = key;
      clientCacheValue = createJuggleWorkServerClient({
        baseUrl,
        token: auth.token,
        hostToken: auth.hostToken,
      });
    }
    return clientCacheValue;
  };

  const refreshSnapshot = () => {
    const juggleworkServerBaseUrl = getBaseUrl().trim();
    const juggleworkServerAuth = getAuth();
    const juggleworkServerClient = getClient();
    const juggleworkServerReady = state.juggleworkServerStatus === "connected";
    const juggleworkServerWorkspaceReady = Boolean(options.runtimeWorkspaceId());
    const resolvedJuggleWorkCapabilities = state.juggleworkServerCapabilities;

    const pref = options.startupPreference();
    const info = state.juggleworkServerHostInfo;
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeJuggleWorkServerUrl(state.juggleworkServerSettings.urlOverride ?? "") ?? "";

    let juggleworkServerUrl = hostUrl || settingsUrl;
    if (pref === "local") juggleworkServerUrl = hostUrl;
    if (pref === "server") juggleworkServerUrl = settingsUrl;
    state.juggleworkServerUrl = juggleworkServerUrl;

    snapshot = {
      juggleworkServerSettings: state.juggleworkServerSettings,
      shareRemoteAccessBusy: state.shareRemoteAccessBusy,
      shareRemoteAccessError: state.shareRemoteAccessError,
      juggleworkServerUrl,
      juggleworkServerBaseUrl,
      juggleworkServerAuth,
      juggleworkServerClient,
      juggleworkServerStatus: state.juggleworkServerStatus,
      juggleworkServerCapabilities: state.juggleworkServerCapabilities,
      juggleworkServerReady,
      juggleworkServerWorkspaceReady,
      resolvedJuggleWorkCapabilities,
      juggleworkServerCanWriteSkills:
        juggleworkServerReady &&
        (resolvedJuggleWorkCapabilities?.skills?.write ?? false),
      juggleworkServerCanWritePlugins:
        juggleworkServerReady &&
        (resolvedJuggleWorkCapabilities?.plugins?.write ?? false),
      juggleworkServerHostInfo: state.juggleworkServerHostInfo,
      juggleworkServerDiagnostics: state.juggleworkServerDiagnostics,
      juggleworkReconnectBusy: state.juggleworkReconnectBusy,
      juggleworkAuditEntries: state.juggleworkAuditEntries,
      juggleworkAuditStatus: state.juggleworkAuditStatus,
      juggleworkAuditError: state.juggleworkAuditError,
      devtoolsWorkspaceId: state.devtoolsWorkspaceId,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const setJuggleWorkServerSettings = (next: SetStateAction<JuggleWorkServerSettings>) => {
    const resolved = applyStateAction(state.juggleworkServerSettings, next);
    mutateState((current) => ({ ...current, juggleworkServerSettings: resolved }));
    queueHealthCheck(0);
  };

  const updateJuggleWorkServerSettings = (next: JuggleWorkServerSettings) => {
    const stored = writeJuggleWorkServerSettings(next);
    mutateState((current) => ({ ...current, juggleworkServerSettings: stored }));
    queueHealthCheck(0);
  };

  const resetJuggleWorkServerSettings = () => {
    clearJuggleWorkServerSettings();
    mutateState((current) => ({ ...current, juggleworkServerSettings: {} }));
    queueHealthCheck(0);
  };

  const shouldWaitForLocalHostInfo = () =>
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    !state.juggleworkServerHostInfoReady;

  const shouldRetryStartupCheck = (status: JuggleWorkServerStatus) =>
    status !== "connected" &&
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  const checkJuggleWorkServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createJuggleWorkServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      const resolved = error as JuggleWorkServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as JuggleWorkServerStatus, capabilities: null };
      }
      return { status: "disconnected" as JuggleWorkServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as JuggleWorkServerStatus, capabilities: null };
    }

    try {
      const capabilities = await client.capabilities();
      return { status: "connected" as JuggleWorkServerStatus, capabilities };
    } catch (error) {
      const resolved = error as JuggleWorkServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as JuggleWorkServerStatus, capabilities: null };
      }
      return { status: "disconnected" as JuggleWorkServerStatus, capabilities: null };
    }
  };

  const clearHealthTimeout = () => {
    if (healthTimeoutId !== null) {
      window.clearTimeout(healthTimeoutId);
      healthTimeoutId = null;
    }
  };

  const queueHealthCheck = (delayMs: number) => {
    if (disposed || typeof window === "undefined") return;
    clearHealthTimeout();
    healthTimeoutId = window.setTimeout(() => {
      healthTimeoutId = null;
      void runHealthCheck();
    }, Math.max(0, delayMs));
  };

  const runHealthCheck = async () => {
    if (disposed || typeof window === "undefined") return;
    if (!options.documentVisible()) {
      queueHealthCheck(healthDelayMs);
      return;
    }
    if (shouldWaitForLocalHostInfo()) {
      queueHealthCheck(250);
      return;
    }
    if (healthBusy) return;

    const url = getBaseUrl().trim();
    const auth = getAuth();
    if (!url) {
      consecutiveHealthFailures = 0;
      mutateState((current) => ({
        ...current,
        juggleworkServerStatus: "disconnected",
        juggleworkServerCapabilities: null,
        juggleworkServerCheckedAt: Date.now(),
      }));
      return;
    }

    healthBusy = true;
    try {
      let result = await checkJuggleWorkServer(url, auth.token, auth.hostToken);

      if (shouldRetryStartupCheck(result.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (disposed) return;

        try {
          const info = await juggleworkServerInfo() as JuggleWorkServerInfo;
          if (disposed) return;

          mutateState((current) => ({
            ...current,
            juggleworkServerHostInfo: info,
            juggleworkServerHostInfoReady: true,
          }));

          const retryUrl = info.baseUrl?.trim() ?? "";
          const retryToken = info.clientToken?.trim() || undefined;
          const retryHostToken = info.hostToken?.trim() || undefined;
          if (retryUrl) {
            result = await checkJuggleWorkServer(retryUrl, retryToken, retryHostToken);
          }
        } catch {
          // Preserve the original check result when the retry probe fails.
        }
      }

      if (disposed) return;
      const previousStatus = state.juggleworkServerStatus;
      const previousCapabilities = state.juggleworkServerCapabilities;
      const healthy = result.status === "connected" || result.status === "limited";
      if (healthy) {
        consecutiveHealthFailures = 0;
        healthDelayMs = 10_000;
      } else {
        consecutiveHealthFailures += 1;
        healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      }

      const preservePrevious =
        !healthy &&
        consecutiveHealthFailures < 3 &&
        (previousStatus === "connected" || previousStatus === "limited");

      mutateState((current) => ({
        ...current,
        juggleworkServerStatus: preservePrevious ? previousStatus : result.status,
        juggleworkServerCapabilities: preservePrevious ? previousCapabilities : result.capabilities,
        juggleworkServerCheckedAt: Date.now(),
      }));
    } catch {
      healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      mutateState((current) => ({
        ...current,
        juggleworkServerCheckedAt: Date.now(),
      }));
    } finally {
      healthBusy = false;
      if (!disposed) queueHealthCheck(healthDelayMs);
    }
  };

  const syncFromOptions = () => {
    refreshSnapshot();
    emitChange();

    if (!isDesktopRuntime()) return;
    const port = state.juggleworkServerHostInfo?.port;
    if (!port) return;
    if (state.juggleworkServerSettings.portOverride === port) return;

    updateJuggleWorkServerSettings({
      ...state.juggleworkServerSettings,
      portOverride: port,
    });
  };

  const startInterval = (key: string, fn: () => void, ms: number) => {
    if (typeof window === "undefined") return;
    if (intervals.has(key)) return;
    intervals.set(key, window.setInterval(fn, ms));
  };

  const stopInterval = (key: string) => {
    const id = intervals.get(key);
    if (id === undefined) return;
    window.clearInterval(id);
    intervals.delete(key);
  };

  const start = () => {
    if (typeof window === "undefined") return;
    if (started) return;
    // Allow restart after a prior dispose() (React 18 StrictMode double-mounts
    // each effect in dev: mount → dispose → re-mount). If we early-return when
    // `disposed` is true, the real mount never arms polling and the UI stays
    // on stale/empty state forever.
    disposed = false;
    started = true;

    syncFromOptions();
    queueHealthCheck(0);
    visibilityChangeHandler = () => {
      if (!options.documentVisible()) return;
      consecutiveHealthFailures = 0;
      queueHealthCheck(0);
    };
    window.addEventListener("visibilitychange", visibilityChangeHandler);

    const refreshHostInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      void (async () => {
        try {
          const info = await juggleworkServerInfo() as JuggleWorkServerInfo;
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            juggleworkServerHostInfo: info,
            juggleworkServerHostInfoReady: true,
          }));
        } catch {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            juggleworkServerHostInfo: null,
            juggleworkServerHostInfoReady: true,
          }));
        }
      })();
    };
    refreshHostInfo();
    startInterval("hostInfo", refreshHostInfo, 10_000);

    const refreshDiagnostics = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("juggleworkServerDiagnostics", null);
        return;
      }

      const client = getClient();
      if (!client || state.juggleworkServerStatus === "disconnected") {
        setStateField("juggleworkServerDiagnostics", null);
        return;
      }

      void (async () => {
        try {
          const status = await client.status();
          if (!disposed) setStateField("juggleworkServerDiagnostics", status);
        } catch {
          if (!disposed) setStateField("juggleworkServerDiagnostics", null);
        }
      })();
    };
    refreshDiagnostics();
    startInterval("diagnostics", refreshDiagnostics, 10_000);

    const refreshDevtoolsWorkspace = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      const client = getClient();
      if (!client) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      void (async () => {
        try {
          const response = await client.listWorkspaces();
          if (disposed) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const activeMatch = response.activeId
            ? items.find((item) => item.id === response.activeId)
            : null;
          setStateField("devtoolsWorkspaceId", activeMatch?.id ?? items[0]?.id ?? null);
        } catch {
          if (!disposed) setStateField("devtoolsWorkspaceId", null);
        }
      })();
    };
    refreshDevtoolsWorkspace();
    startInterval("devtoolsWorkspace", refreshDevtoolsWorkspace, 20_000);

    const refreshAudit = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        mutateState((current) => ({
          ...current,
          juggleworkAuditEntries: [],
          juggleworkAuditStatus: "idle",
          juggleworkAuditError: null,
        }));
        return;
      }

      const client = getClient();
      const workspaceId = state.devtoolsWorkspaceId;
      if (!client || !workspaceId) {
        mutateState((current) => ({
          ...current,
          juggleworkAuditEntries: [],
          juggleworkAuditStatus: "idle",
          juggleworkAuditError: null,
        }));
        return;
      }

      mutateState((current) => ({
        ...current,
        juggleworkAuditStatus: "loading",
        juggleworkAuditError: null,
      }));

      void (async () => {
        try {
          const result = await client.listAudit(workspaceId, 50);
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            juggleworkAuditEntries: Array.isArray(result.items) ? result.items : [],
            juggleworkAuditStatus: "idle",
          }));
        } catch (error) {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            juggleworkAuditEntries: [],
            juggleworkAuditStatus: "error",
            juggleworkAuditError:
              error instanceof Error
                ? error.message
                : t("app.error_audit_load"),
          }));
        }
      })();
    };
    refreshAudit();
    startInterval("audit", refreshAudit, 15_000);
  };

  const dispose = () => {
    disposed = true;
    started = false;
    clearHealthTimeout();
    if (visibilityChangeHandler && typeof window !== "undefined") {
      window.removeEventListener("visibilitychange", visibilityChangeHandler);
      visibilityChangeHandler = null;
    }
    for (const key of [...intervals.keys()]) stopInterval(key);
  };

  const testJuggleWorkServerConnection = async (next: JuggleWorkServerSettings) => {
    const derived = normalizeJuggleWorkServerUrl(next.urlOverride ?? "");
    if (!derived) {
      mutateState((current) => ({
        ...current,
        juggleworkServerStatus: "disconnected",
        juggleworkServerCapabilities: null,
        juggleworkServerCheckedAt: Date.now(),
      }));
      return false;
    }

    const result = await checkJuggleWorkServer(derived, next.token);
    consecutiveHealthFailures = result.status === "disconnected" ? consecutiveHealthFailures + 1 : 0;
    mutateState((current) => ({
      ...current,
      juggleworkServerStatus: result.status,
      juggleworkServerCapabilities: result.capabilities,
      juggleworkServerCheckedAt: Date.now(),
    }));

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isDesktopRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach =
        !options.activeClient() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "jugglework";
      if (shouldAttach) {
        await options
          .createRemoteWorkspaceFlow({
            juggleworkHostUrl: derived,
            juggleworkToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectJuggleWorkServer = async () => {
    if (state.juggleworkReconnectBusy) return false;
    setStateField("juggleworkReconnectBusy", true);

    try {
      let hostInfo = state.juggleworkServerHostInfo;
      if (isDesktopRuntime()) {
        try {
          hostInfo = await juggleworkServerInfo() as JuggleWorkServerInfo;
          mutateState((current) => ({ ...current, juggleworkServerHostInfo: hostInfo }));
        } catch {
          hostInfo = null;
          setStateField("juggleworkServerHostInfo", null);
        }
      }

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const settings = state.juggleworkServerSettings;
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateJuggleWorkServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = getBaseUrl().trim();
      const auth = getAuth();
      if (!url) {
        mutateState((current) => ({
          ...current,
          juggleworkServerStatus: "disconnected",
          juggleworkServerCapabilities: null,
          juggleworkServerCheckedAt: Date.now(),
        }));
        return false;
      }

      const result = await checkJuggleWorkServer(url, auth.token, auth.hostToken);
      mutateState((current) => ({
        ...current,
        juggleworkServerStatus: result.status,
        juggleworkServerCapabilities: result.capabilities,
        juggleworkServerCheckedAt: Date.now(),
      }));
      return result.status === "connected" || result.status === "limited";
    } finally {
      setStateField("juggleworkReconnectBusy", false);
    }
  };

  async function ensureLocalJuggleWorkServerClient(): Promise<JuggleWorkServerClient | null> {
    let hostInfo = state.juggleworkServerHostInfo;
    if (hostInfo?.baseUrl?.trim() && hostInfo.clientToken?.trim()) {
      const existing = createJuggleWorkServerClient({
        baseUrl: hostInfo.baseUrl.trim(),
        token: hostInfo.clientToken.trim(),
        hostToken: hostInfo.hostToken?.trim() || undefined,
      });
      try {
        await existing.health();
        if (options.startupPreference() !== "server") {
          await reconnectJuggleWorkServer();
        }
        return existing;
      } catch {
        // Fall through to a local restart.
      }
    }

    if (!isDesktopRuntime()) return null;

    try {
      hostInfo = await juggleworkServerRestart({
        remoteAccessEnabled: state.juggleworkServerSettings.remoteAccessEnabled === true,
      }) as JuggleWorkServerInfo;
      mutateState((current) => ({ ...current, juggleworkServerHostInfo: hostInfo }));
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) return null;

    if (options.startupPreference() !== "server") {
      await reconnectJuggleWorkServer();
    }

    return createJuggleWorkServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (state.shareRemoteAccessBusy) return;
    const previous = state.juggleworkServerSettings;
    const next: JuggleWorkServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    mutateState((current) => ({
      ...current,
      shareRemoteAccessBusy: true,
      shareRemoteAccessError: null,
    }));
    updateJuggleWorkServerSettings(next);

    try {
      if (isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker"));
        }
        await reconnectJuggleWorkServer();
      }
    } catch (error) {
      updateJuggleWorkServerSettings(previous);
      mutateState((current) => ({
        ...current,
        shareRemoteAccessError:
          error instanceof Error
            ? error.message
            : t("app.error_remote_access"),
      }));
      return;
    } finally {
      setStateField("shareRemoteAccessBusy", false);
    }
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => snapshot;

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    setJuggleWorkServerSettings,
    updateJuggleWorkServerSettings,
    resetJuggleWorkServerSettings,
    saveShareRemoteAccess,
    checkJuggleWorkServer,
    testJuggleWorkServerConnection,
    reconnectJuggleWorkServer,
    ensureLocalJuggleWorkServerClient,
  };
}

export function useJuggleWorkServerStoreSnapshot(store: JuggleWorkServerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
