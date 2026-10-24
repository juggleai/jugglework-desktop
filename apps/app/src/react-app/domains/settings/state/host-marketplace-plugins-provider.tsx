/** @jsxImportSource react */
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { WorkspaceKind, WorkspaceRemoteKind } from "@jugglework/types/workspace";

import { useCloudSession } from "../cloud/cloud-session-provider";
import {
  HostMarketplacePluginsController,
  hostMarketplacePluginsKey,
  supportsHostMarketplaceWorkspace,
  type HostMarketplaceClient,
  type HostMarketplacePluginsSnapshot,
} from "./host-marketplace-plugins";

const EMPTY_SNAPSHOT: HostMarketplacePluginsSnapshot = {
  key: null,
  scope: null,
  environment: null,
  registry: null,
  writable: false,
  status: "idle",
  operation: null,
  error: null,
};

type ExecutionTarget = {
  client: HostMarketplaceClient;
  token: string;
  hostToken: string;
  workspaceType: WorkspaceKind;
  remoteType?: WorkspaceRemoteKind | null;
};

type HostMarketplacePluginsContextValue = {
  controller: HostMarketplacePluginsController | null;
  snapshot: HostMarketplacePluginsSnapshot;
  requestedKey: string | null;
  hostBaseUrl: string;
  hasCredential: boolean;
  supported: boolean;
  readiness: "idle" | "activating" | "ready" | "unavailable";
  ensureReady: () => Promise<HostMarketplacePluginsSnapshot>;
  ensureReadyForTarget: (target: ExecutionTarget) => Promise<void>;
  setExecutionTarget: (target: ExecutionTarget | null) => void;
};

const HostMarketplacePluginsContext = createContext<HostMarketplacePluginsContextValue | null>(null);

export function HostMarketplacePluginsProvider(props: { children: ReactNode }) {
  const cloudSession = useCloudSession();
  const [target, setTarget] = useState<ExecutionTarget | null>(null);
  const controllersRef = useRef(new Map<string, HostMarketplacePluginsController>());
  const supported = supportsHostMarketplaceWorkspace(target);
  const supportedRef = useRef(supported);
  supportedRef.current = supported;
  const hostBaseUrl = supported ? target?.client.baseUrl.replace(/\/+$/, "") ?? "" : "";
  const hasCredential = Boolean(target?.hostToken.trim() || target?.token.trim());
  const scope = useMemo(() => {
    const userId = cloudSession.user?.id?.trim() ?? "";
    const organizationId = cloudSession.activeOrganization?.id?.trim() ?? "";
    if (!cloudSession.isSignedIn || !userId || !organizationId || !cloudSession.baseUrl.trim()) return null;
    try {
      return { controlPlaneOrigin: new URL(cloudSession.baseUrl).origin, userId, organizationId };
    } catch {
      return null;
    }
  }, [cloudSession.activeOrganization?.id, cloudSession.baseUrl, cloudSession.isSignedIn, cloudSession.user?.id]);
  const controllerContext = scope
    ? [hostBaseUrl, target?.token ?? "", target?.hostToken ?? "", scope.controlPlaneOrigin, scope.userId, scope.organizationId].join("\0")
    : "";
  const controller = useMemo(() => {
    if (!target || !supported || !hostBaseUrl || !scope) return null;
    const cached = controllersRef.current.get(controllerContext);
    if (cached) return cached;
    const next = new HostMarketplacePluginsController(target.client);
    controllersRef.current.set(controllerContext, next);
    return next;
  }, [controllerContext, hostBaseUrl, scope, supported, target]);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    controller?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  );
  const requestedKey = controller && scope
    ? hostMarketplacePluginsKey(hostBaseUrl, scope)
    : null;
  const ensureReady = useCallback(() => {
    if (!controller || !scope || !hasCredential) {
      return Promise.reject(new Error("Host Marketplace identity or execution-host credentials are unavailable."));
    }
    return controller.ensureScope(scope);
  }, [controller, hasCredential, scope]);

  useEffect(() => {
    if (!controller || !scope || !hasCredential || !requestedKey) {
      if (controller?.getSnapshot().scope) void controller.clear().catch(() => {});
      return;
    }
    void controller.loadScope(scope).then((loaded) => {
      // Registry routes prove host/owner authority. Host-wide capabilities do
      // not, so activation remains behind this writable registry read.
      if (loaded.key !== requestedKey || !loaded.writable || loaded.registry?.active !== false) return;
      return controller.ensureScope(scope);
    }).catch(() => {});
    return () => {
      // A direct OpenCode remote is not an execution host. Never use its
      // selection as a reason to contact the previously selected host.
      if (!supportedRef.current) {
        controller.abandon();
        return;
      }
      if (controller.getSnapshot().key === requestedKey) {
        void controller.clear().catch(() => {});
      }
    };
  }, [controller, hasCredential, requestedKey, scope]);

  useEffect(() => {
    if (typeof window === "undefined" || !controller || !scope || !hasCredential) return;
    const revalidate = () => { void ensureReady().catch(() => {}); };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [controller, ensureReady, hasCredential, scope]);

  const setExecutionTarget = useCallback((next: ExecutionTarget | null) => {
    setTarget((current) => {
      if (!current || !next) return current === next ? current : next;
      if (
        current.client === next.client
        && current.token === next.token
        && current.hostToken === next.hostToken
        && current.workspaceType === next.workspaceType
        && current.remoteType === next.remoteType
      ) return current;
      return next;
    });
  }, []);
  /** 为后台任务准备同一身份的目标宿主插件，不切换当前页面的执行目标。 */
  const ensureReadyForTarget = useCallback(async (next: ExecutionTarget) => {
    if (!scope || !supportsHostMarketplaceWorkspace(next)) return;
    const key = [next.client.baseUrl.replace(/\/+$/, ""), next.token, next.hostToken, scope.controlPlaneOrigin, scope.userId, scope.organizationId].join("\0");
    let targetController = controllersRef.current.get(key);
    if (!targetController) {
      targetController = new HostMarketplacePluginsController(next.client);
      controllersRef.current.set(key, targetController);
    }
    const prepared = await targetController.ensureScope(scope);
    if (prepared.registry?.installations.length && !prepared.registry.active) throw prepared.error ?? new Error("Host Marketplace plugins are not active.");
  }, [scope]);
  const readiness = !controller || !scope || !hasCredential
    ? "idle"
    : snapshot.status === "loading"
      ? "activating"
      : snapshot.status === "ready" && snapshot.registry?.active
        ? "ready"
        : snapshot.status === "ready" && snapshot.writable
          ? "activating"
          : snapshot.status === "error" || snapshot.status === "ready"
          ? "unavailable"
          : "activating";
  const value = useMemo<HostMarketplacePluginsContextValue>(() => ({
    controller,
    snapshot,
    requestedKey,
    hostBaseUrl,
    hasCredential,
    supported,
    readiness,
    ensureReady,
    ensureReadyForTarget,
    setExecutionTarget,
  }), [controller, ensureReady, ensureReadyForTarget, hasCredential, hostBaseUrl, readiness, requestedKey, setExecutionTarget, snapshot, supported]);

  return <HostMarketplacePluginsContext.Provider value={value}>{props.children}</HostMarketplacePluginsContext.Provider>;
}

export function useHostMarketplacePlugins() {
  const context = use(HostMarketplacePluginsContext);
  if (!context) throw new Error("useHostMarketplacePlugins must be used within HostMarketplacePluginsProvider");
  return context;
}

export function useHostMarketplaceExecutionTarget(target: ExecutionTarget | null): void {
  const { setExecutionTarget } = useHostMarketplacePlugins();
  useLayoutEffect(() => {
    setExecutionTarget(target);
    return () => setExecutionTarget(null);
  }, [setExecutionTarget, target]);
}
