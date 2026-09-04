/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { desktopPolicyKeys } from "@jugglework/types/den/desktop-policies";
import { desktopRemoteDisabledFeatureGates } from "@jugglework/types/desktop-remote-control";
import type { DesktopRemoteControlPolicyScope } from "@jugglework/types/desktop-ipc";

import {
  checkDesktopAppRestriction,
  readDesktopAllowedModels,
  type DesktopAppRestrictionChecker,
} from "../../../app/cloud/desktop-app-restrictions";
import {
  createDenClient,
  DenApiError,
  denControlPlaneBaseUrl,
  ensureDenActiveOrganization,
  normalizeDenDesktopConfig,
  readDenBootstrapConfig,
  readDenSettings,
  setDenBootstrapConfig,
  type DenDesktopConfig,
} from "../../../app/lib/den";
import {
  applyBrandAppName,
  applyBrandIcon,
  desktopRemoteControlContextSync,
  mintAutomationAgentToken,
} from "../../../app/lib/desktop";
import { createJuggleWorkServerClient } from "../../../app/lib/jugglework-server";
import {
  denSessionUpdatedEvent,
  denSettingsChangedEvent,
} from "../../../app/lib/den-session-events";
import { isDesktopRuntime } from "../../../app/lib/runtime-env";
import { resolveJuggleWorkConnection } from "../../shell/jugglework-connection";
import { useDenAuth } from "./den-auth-provider";
import {
  bootstrapBrandingFromDesktopConfig,
  bootstrapBrandingNeedsSync,
} from "./workspace-branding-restart";

export type DesktopConfigStore = {
  config: DenDesktopConfig;
  loading: boolean;
  refresh: () => Promise<void>;
  refreshFresh: () => Promise<{ config: DenDesktopConfig; scope: DesktopRemoteControlPolicyScope }>;
  /**
   * Stable checker function that matches the `DesktopAppRestrictionChecker`
   * shape Solid passes to its stores. Useful when wiring restriction gates
   * from non-hook code paths.
   */
  checkRestriction: DesktopAppRestrictionChecker;
};

const DesktopConfigContext = createContext<DesktopConfigStore | undefined>(
  undefined,
);

const DEFAULT_DESKTOP_CONFIG: DenDesktopConfig = {};
// Remote-control authorization is short-lived and fail-closed. Refresh at the
// agent-token cadence instead of treating the one-hour presentation cache as
// sufficient authorization.
const DESKTOP_CONFIG_REFRESH_MS = 5 * 60 * 1000;
export const remoteControlPolicyRecoveryEvent = "jugglework:remote-control:policy-recovery";
const REMOTE_POLICY_RECOVERY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
const DESKTOP_CONFIG_CACHE_PREFIX = "jugglework.den.desktopConfig:";
const DESKTOP_CONFIG_ITEMS = [
  ...desktopPolicyKeys,
  "allowedDesktopVersions",
  "allowedModels",
  "brandAppName",
  "brandLogoUrl",
  "brandIconUrl",
  "brandAccentColor",
  "connectEnabled",
  "desktopRemoteFeatureGates",
  "desktopRemotePolicyVersion",
  "onboardingPrompts",
  "onboardingPromptDescriptions",
] as const satisfies readonly (keyof DenDesktopConfig)[];

type DesktopConfigItem = (typeof DESKTOP_CONFIG_ITEMS)[number];
type DesktopConfigAction = {
  item: DesktopConfigItem;
  nextValue: DenDesktopConfig[DesktopConfigItem];
  previousValue: DenDesktopConfig[DesktopConfigItem];
};

function isBootstrapBrandingActionItem(item: DesktopConfigItem): boolean {
  return item === "brandAppName" || item === "brandLogoUrl" || item === "brandIconUrl";
}

function getDesktopConfigCacheKey(): string {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl.trim();
  const activeOrgId = settings.activeOrgId?.trim() ?? "";
  if (!baseUrl) return "";
  return `${DESKTOP_CONFIG_CACHE_PREFIX}${baseUrl}::${activeOrgId}`;
}

function readCachedDesktopConfig(key: string): DenDesktopConfig | null {
  if (typeof window === "undefined" || !key) return null;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return normalizeDenDesktopConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCachedDesktopConfig(key: string, config: DenDesktopConfig) {
  if (typeof window === "undefined" || !key) return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify(normalizeDenDesktopConfig(config)),
    );
  } catch {
    // Quota / private-browsing failures are non-fatal — we just miss the cache next boot.
  }
}

function desktopConfigItemMatches(
  previousValue: DenDesktopConfig[DesktopConfigItem],
  nextValue: DenDesktopConfig[DesktopConfigItem],
) {
  if (Array.isArray(previousValue) || Array.isArray(nextValue)) {
    if (!Array.isArray(previousValue) || !Array.isArray(nextValue)) return false;
    if (previousValue.length !== nextValue.length) return false;
    return previousValue.every((value, index) => value === nextValue[index]);
  }

  return previousValue === nextValue;
}

function getDesktopConfigActions(input: {
  currentConfig: DenDesktopConfig;
  latestConfig: DenDesktopConfig;
}): DesktopConfigAction[] {
  return DESKTOP_CONFIG_ITEMS.flatMap((item) => {
    const previousValue = input.currentConfig[item];
    const nextValue = input.latestConfig[item];

    if (desktopConfigItemMatches(previousValue, nextValue)) return [];

    return [{ item, previousValue, nextValue }];
  });
}

type DesktopConfigProviderProps = {
  children: ReactNode;
};

type DesktopConfigState = {
  config: DenDesktopConfig;
  loading: boolean;
};

type RemotePolicyValidation = {
  contextKey: string;
  validatedAt: string;
};

function currentRemotePolicyContextKey(userId: string | null | undefined): string {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl.trim();
  const organizationId = settings.activeOrgId?.trim() ?? "";
  const normalizedUserId = userId?.trim() ?? "";
  return baseUrl && organizationId && normalizedUserId
    ? `${baseUrl}\u0000${organizationId}\u0000${normalizedUserId}`
    : "";
}

/**
 * React port of the Solid `DesktopConfigProvider`
 * (`apps/app/src/app/cloud/desktop-config-provider.tsx` on dev).
 *
 * Fetches the org-scoped desktop policy config
 * (`packages/types/den/desktop-policies.ts` shape) and caches it in
 * localStorage so gates like `allowZenModel` can apply immediately on the
 * next boot without waiting for the HTTP round-trip. Re-fetches on Den
 * session / settings events and on a five-minute interval; only a fresh
 * network result may authorize remote control.
 */
export function DesktopConfigProvider({ children }: DesktopConfigProviderProps) {
  const denAuth = useDenAuth();
  const [desktopConfigState, setDesktopConfigState] = useState<DesktopConfigState>({
    config: DEFAULT_DESKTOP_CONFIG,
    loading: true,
  });
  const [remotePolicyValidation, setRemotePolicyValidation] = useState<RemotePolicyValidation | null>(null);
  const { config, loading } = desktopConfigState;
  // Bumped whenever the browser tells us the Den session or settings changed.
  const [settingsVersion, bumpSettingsVersion] = useReducer((value: number) => value + 1, 0);
  // Monotonic run id — same guard-against-stale-resolution pattern as DenAuthProvider.
  const refreshRunRef = useRef(0);
  const remotePolicyRecoveryRef = useRef<Promise<void> | null>(null);
  const remotePolicyRecoveryWakeRef = useRef<(() => void) | null>(null);
  const lastPushedConnectEnabledRef = useRef<boolean | null>(null);
  // TIPS: 记的是"上一次真的推送成功的凭据摘要"（session token + 铸造出的 agent token），
  // 不是登录状态本身——避免同一份凭据在每次无关的重渲染里被重复 PUT 上去；一旦
  // (baseUrl, token, agentToken) 有一项变了或者退出登录了才需要再动一次。
  const lastPushedGithubEventAuthRef = useRef<string | null>(null);
  // Safe in-memory copy of the last config we actually applied. State drives
  // rendering, while this ref lets the handler compare without stale closures.
  const currentDesktopConfigRef = useRef<DenDesktopConfig>(DEFAULT_DESKTOP_CONFIG);
  const devRefreshDesktopConfigRef = useRef<DenDesktopConfig | null>(null);
  const isSignedIn = denAuth.isSignedIn;
  const currentAuthRef = useRef({ status: denAuth.status, userId: denAuth.user?.id?.trim() ?? "" });
  currentAuthRef.current = { status: denAuth.status, userId: denAuth.user?.id?.trim() ?? "" };

  const currentPolicyScope = useCallback((): DesktopRemoteControlPolicyScope | null => {
    const settings = readDenSettings();
    const scope = {
      controlPlaneBaseUrl: settings.baseUrl.trim(),
      userId: currentAuthRef.current.status === "signed_in" ? currentAuthRef.current.userId : "",
      organizationId: settings.activeOrgId?.trim() ?? "",
    };
    return scope.controlPlaneBaseUrl && scope.userId && scope.organizationId ? scope : null;
  }, []);

  const applyDesktopConfigActions = useCallback((latestConfig: DenDesktopConfig) => {
    const normalizedConfig = normalizeDenDesktopConfig(latestConfig);
    const actions = getDesktopConfigActions({
      currentConfig: currentDesktopConfigRef.current,
      latestConfig: normalizedConfig,
    });

    if (actions.length === 0) return false;

    const brandIconAction = actions.find((action) => action.item === "brandIconUrl");
    if (brandIconAction) {
      void applyBrandIcon(
        typeof brandIconAction.nextValue === "string" ? brandIconAction.nextValue : null,
      ).then((result) => {
        if (!result.ok) {
          console.warn(`[brand-icon] Desktop icon was not applied: ${result.reason ?? "unknown failure"}`);
        }
      }).catch((error: unknown) => {
        console.warn("[brand-icon] Desktop icon apply request failed", error);
      });
    }

    const brandAppNameAction = actions.find((action) => action.item === "brandAppName");
    if (brandAppNameAction) {
      const appName = typeof brandAppNameAction.nextValue === "string" ? brandAppNameAction.nextValue : null;
      document.title = appName ?? "JuggleWork";
      void applyBrandAppName(appName).catch(() => null);
    }

    // Keep desktop-bootstrap.json aligned so a cleared wordmark/icon cannot
    // resurrect from the install/connect snapshot on the next relaunch.
    const shouldSyncBootstrapBranding = actions.some((action) =>
      isBootstrapBrandingActionItem(action.item),
    );
    if (shouldSyncBootstrapBranding && isDesktopRuntime()) {
      const bootstrap = readDenBootstrapConfig();
      if (bootstrapBrandingNeedsSync(bootstrap, normalizedConfig)) {
        const branding = bootstrapBrandingFromDesktopConfig(normalizedConfig);
        void setDenBootstrapConfig(
          {
            ...bootstrap,
            brandAppName: branding.brandAppName,
            brandLogoUrl: branding.brandLogoUrl,
            brandIconUrl: branding.brandIconUrl,
          },
          { dispatchSettingsChanged: false },
        ).catch(() => undefined);
      }
    }

    currentDesktopConfigRef.current = normalizedConfig;
    setDesktopConfigState((current) => ({
      ...current,
      config: normalizedConfig,
    }));
    return true;
  }, []);

  const desktopConfigHandler = useCallback(async (requireFresh = false): Promise<DenDesktopConfig> => {
    if (import.meta.env.DEV && requireFresh && devRefreshDesktopConfigRef.current) {
      const nextConfig = devRefreshDesktopConfigRef.current;
      applyDesktopConfigActions(nextConfig);
      return nextConfig;
    }

    const currentRun = ++refreshRunRef.current;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const activeOrgId = settings.activeOrgId?.trim() ?? "";
    const cacheKey = getDesktopConfigCacheKey();
    const policyContextKey = currentRemotePolicyContextKey(denAuth.user?.id);
    const requestedScope = currentPolicyScope();

    if (!isSignedIn || !token || !activeOrgId) {
      applyDesktopConfigActions(DEFAULT_DESKTOP_CONFIG);
      setDesktopConfigState((current) => ({ ...current, loading: false }));
      return DEFAULT_DESKTOP_CONFIG;
    }

    const cached = readCachedDesktopConfig(cacheKey);
    if (cached) {
      applyDesktopConfigActions(cached);
    }

    if (!cached) {
      setDesktopConfigState((current) => ({ ...current, loading: true }));
    }

    try {
      const nextConfig = await createDenClient({
        baseUrl: settings.baseUrl,
        token,
      }).getDesktopConfig(activeOrgId);

      if (currentRun !== refreshRunRef.current) return nextConfig;
      const liveScope = currentPolicyScope();
      if (!requestedScope || !liveScope || requestedScope.controlPlaneBaseUrl !== liveScope.controlPlaneBaseUrl ||
          requestedScope.userId !== liveScope.userId || requestedScope.organizationId !== liveScope.organizationId) {
        if (requireFresh) throw new Error("Desktop policy scope changed during refresh.");
        return cached ?? DEFAULT_DESKTOP_CONFIG;
      }

      writeCachedDesktopConfig(cacheKey, nextConfig);
      applyDesktopConfigActions(nextConfig);
      if (policyContextKey) {
        setRemotePolicyValidation({
          contextKey: policyContextKey,
          validatedAt: new Date().toISOString(),
        });
      }
      return nextConfig;
    } catch (error) {
      if (currentRun !== refreshRunRef.current) {
        if (requireFresh) throw error;
        return cached ?? DEFAULT_DESKTOP_CONFIG;
      }

      // If the server says the active org doesn't exist, re-sync Better Auth
      // so the next refresh hits a valid org. Same recovery path as Solid.
      if (
        error instanceof DenApiError &&
        error.status === 404 &&
        error.code === "organization_not_found"
      ) {
        await ensureDenActiveOrganization({ forceServerSync: true }).catch(
          () => null,
        );
      }

      const fallbackConfig = cached ?? DEFAULT_DESKTOP_CONFIG;
      setRemotePolicyValidation(null);
      applyDesktopConfigActions(fallbackConfig);
      if (requireFresh) throw error;
      return fallbackConfig;
    } finally {
      if (currentRun === refreshRunRef.current) {
        setDesktopConfigState((current) => ({ ...current, loading: false }));
      }
    }
  }, [applyDesktopConfigActions, currentPolicyScope, denAuth.user?.id, isSignedIn]);

  const refresh = useCallback(
    async () => {
      await desktopConfigHandler();
    },
    [desktopConfigHandler],
  );
  const refreshFresh = useCallback(async () => {
    const capturedScope = currentPolicyScope();
    if (!capturedScope) {
      throw new Error("Remote-control policy scope is unavailable.");
    }
    const nextConfig = await desktopConfigHandler(true);
    const liveScope = currentPolicyScope();
    if (!liveScope || liveScope.controlPlaneBaseUrl !== capturedScope.controlPlaneBaseUrl || liveScope.userId !== capturedScope.userId ||
        liveScope.organizationId !== capturedScope.organizationId) {
      throw new Error("Remote-control policy scope changed during refresh.");
    }
    if (!isDesktopRuntime()) return { config: nextConfig, scope: capturedScope };
    await desktopRemoteControlContextSync({
      schemaVersion: 1,
      signedIn: true,
      ...capturedScope,
      policyFresh: true,
      featureGates: nextConfig.desktopRemoteFeatureGates ?? desktopRemoteDisabledFeatureGates,
      policyVersion: nextConfig.desktopRemotePolicyVersion ?? null,
      validatedAt: new Date().toISOString(),
    });
    const afterSyncScope = currentPolicyScope();
    if (!afterSyncScope || afterSyncScope.controlPlaneBaseUrl !== capturedScope.controlPlaneBaseUrl ||
        afterSyncScope.organizationId !== capturedScope.organizationId || afterSyncScope.userId !== capturedScope.userId) {
      throw new Error("Remote-control policy scope changed during synchronization.");
    }
    return { config: nextConfig, scope: capturedScope };
  }, [currentPolicyScope, desktopConfigHandler]);

  const recoverRemotePolicy = useCallback(() => {
    if (!isSignedIn) return Promise.resolve();
    if (remotePolicyRecoveryRef.current) {
      remotePolicyRecoveryWakeRef.current?.();
      return remotePolicyRecoveryRef.current;
    }
    // TIPS: resume 通常早于 Wi-Fi/DNS 恢复；串行退避避免并发请求互相用 run id 判旧。
    const recovery = (async () => {
      for (const delay of REMOTE_POLICY_RECOVERY_DELAYS_MS) {
        if (delay > 0) {
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, delay);
            remotePolicyRecoveryWakeRef.current = () => {
              window.clearTimeout(timer);
              remotePolicyRecoveryWakeRef.current = null;
              resolve();
            };
          });
          remotePolicyRecoveryWakeRef.current = null;
        }
        try {
          await desktopConfigHandler(true);
          return;
        } catch {
          // 下一档延迟继续；周期刷新仍是最终兜底。
        }
      }
    })().finally(() => {
      if (remotePolicyRecoveryRef.current === recovery) remotePolicyRecoveryRef.current = null;
      remotePolicyRecoveryWakeRef.current = null;
    });
    remotePolicyRecoveryRef.current = recovery;
    return recovery;
  }, [desktopConfigHandler, isSignedIn]);

  // Re-run whenever auth flips or Den settings change. Read the cache
  // synchronously so gated UI never flickers through "unrestricted" just
  // because we haven't finished the HTTP call yet.
  useEffect(() => {
    // settingsVersion is read to tie this effect to settings-change events.
    void settingsVersion;

    if (!isSignedIn) {
      setRemotePolicyValidation(null);
      applyDesktopConfigActions(DEFAULT_DESKTOP_CONFIG);
      setDesktopConfigState((current) => ({ ...current, loading: false }));
      return;
    }

    const cacheKey = getDesktopConfigCacheKey();
    const cached = readCachedDesktopConfig(cacheKey);
    applyDesktopConfigActions(cached ?? DEFAULT_DESKTOP_CONFIG);
    setDesktopConfigState((current) => ({ ...current, loading: !cached }));
    void desktopConfigHandler();
  }, [applyDesktopConfigActions, desktopConfigHandler, isSignedIn, settingsVersion]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleSettingsChanged = () => {
      bumpSettingsVersion();
    };

    window.addEventListener(denSessionUpdatedEvent, handleSettingsChanged);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);

    const interval = window.setInterval(() => {
      if (!isSignedIn) return;
      void desktopConfigHandler();
    }, DESKTOP_CONFIG_REFRESH_MS);

    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handleSettingsChanged);
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
      window.clearInterval(interval);
    };
  }, [desktopConfigHandler, isSignedIn]);

  useEffect(() => {
    if (typeof window === "undefined" || !isDesktopRuntime()) return;
    const handleRecovery = () => { void recoverRemotePolicy(); };
    window.addEventListener(remoteControlPolicyRecoveryEvent, handleRecovery);
    window.addEventListener("online", handleRecovery);
    return () => {
      window.removeEventListener(remoteControlPolicyRecoveryEvent, handleRecovery);
      window.removeEventListener("online", handleRecovery);
    };
  }, [recoverRemotePolicy]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const settings = readDenSettings();
    const userId = denAuth.status === "signed_in" ? denAuth.user?.id?.trim() ?? "" : "";
    const organizationId = settings.activeOrgId?.trim() ?? "";
    const controlPlaneBaseUrl = settings.baseUrl.trim();
    const contextKey = currentRemotePolicyContextKey(userId);
    const policyFresh = Boolean(
      userId &&
      organizationId &&
      controlPlaneBaseUrl &&
      remotePolicyValidation?.contextKey === contextKey,
    );
    const context = policyFresh
      ? {
          schemaVersion: 1 as const,
          signedIn: true,
          controlPlaneBaseUrl,
          userId,
          organizationId,
          policyFresh: true,
          featureGates: config.desktopRemoteFeatureGates ?? desktopRemoteDisabledFeatureGates,
          policyVersion: config.desktopRemotePolicyVersion ?? null,
          validatedAt: remotePolicyValidation?.validatedAt ?? null,
        }
      : {
          schemaVersion: 1 as const,
          signedIn: false,
          controlPlaneBaseUrl: null,
          userId: null,
          organizationId: null,
          policyFresh: false,
          featureGates: desktopRemoteDisabledFeatureGates,
          policyVersion: null,
          validatedAt: null,
        };
    void desktopRemoteControlContextSync(context).catch(() => undefined);
  }, [config.desktopRemoteFeatureGates, config.desktopRemotePolicyVersion, denAuth.status, denAuth.user?.id, remotePolicyValidation]);

  const connectEnabled = config.connectEnabled === true;

  useEffect(() => {
    if (loading) return;
    if (lastPushedConnectEnabledRef.current === connectEnabled) return;
    let cancelled = false;

    void (async () => {
      const connection = await resolveJuggleWorkConnection();
      if (cancelled || !connection.normalizedBaseUrl || !connection.resolvedHostToken) return;
      lastPushedConnectEnabledRef.current = connectEnabled;
      await createJuggleWorkServerClient({
        baseUrl: connection.normalizedBaseUrl,
        token: connection.resolvedToken,
        hostToken: connection.resolvedHostToken,
      }).setConnectState(connectEnabled);
    })().catch(() => null);

    return () => {
      cancelled = true;
    };
  }, [connectEnabled, loading]);

  // TIPS: 这是 GitHub 事件触发自动化 resolveAuth 的真实生产落点（见
  // apps/server/src/automation/github-event-auth-store.ts 和这次改动的 tasks.md 3.1）——
  // apps/server 自己从来没有登录态，渲染进程本来就持有真实的云端 session，登录/切换账号/
  // 登出时把它转发进 apps/server 的内存就行，不用另外给那个进程做一套登录。
  // 设备 agent token 复用远程控制现成的设备身份铸造（服务端只认一个 scope 常量
  // desktop-agent:connect，两个功能本来就是同一份设备身份，见
  // automation-agent-token.mjs）——这台设备从没做过远程控制 enrollment 时 mint 返回
  // null，不是错误，优雅省略 agentToken 就行，需要它的方法（轮询、认领、写回）继续
  // 优雅拒绝，不影响不需要它的方法已经能用真实凭据工作。
  useEffect(() => {
    if (loading) return;
    let cancelled = false;

    void (async () => {
      const connection = await resolveJuggleWorkConnection();
      if (cancelled || !connection.normalizedBaseUrl || !connection.resolvedHostToken) return;
      const client = createJuggleWorkServerClient({
        baseUrl: connection.normalizedBaseUrl,
        token: connection.resolvedToken,
        hostToken: connection.resolvedHostToken,
      });

      if (denAuth.status !== "signed_in") {
        if (lastPushedGithubEventAuthRef.current === null) return;
        lastPushedGithubEventAuthRef.current = null;
        await client.clearGithubEventAuth();
        return;
      }

      const settings = readDenSettings();
      const cloudToken = settings.authToken?.trim() ?? "";
      const cloudBaseUrl = settings.baseUrl?.trim() ?? "";
      if (!cloudToken || !cloudBaseUrl) return;

      const scope = currentPolicyScope();
      const minted = scope ? await mintAutomationAgentToken(scope).catch(() => null) : null;
      if (cancelled) return;

      const digest = `${cloudBaseUrl}::${cloudToken}::${minted?.accessToken ?? ""}`;
      if (lastPushedGithubEventAuthRef.current === digest) return;
      lastPushedGithubEventAuthRef.current = digest;
      await client.pushGithubEventAuth({
        cloudBaseUrl: denControlPlaneBaseUrl(cloudBaseUrl),
        cloudToken,
        ...(minted ? { agentToken: minted.accessToken } : {}),
      });
    })().catch(() => null);

    return () => {
      cancelled = true;
    };
  }, [denAuth.status, denAuth.user?.id, loading, settingsVersion]);

  // Dev-only: expose a bridge so evals can inject config directly without
  // requiring a cloud sign-in. This simply applies the config to React state.
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const bridge = (configPayload: unknown) => {
      applyDesktopConfigActions(
        normalizeDenDesktopConfig(configPayload),
      );
    };
    Object.defineProperty(window, "__juggleworkApplyDesktopConfig", { value: bridge, configurable: true });
    const refreshBridge = (configPayload: unknown) => {
      devRefreshDesktopConfigRef.current = normalizeDenDesktopConfig(configPayload);
    };
    Object.defineProperty(window, "__juggleworkSetDesktopConfigRefreshResult", {
      value: refreshBridge,
      configurable: true,
    });
    return () => {
      Object.defineProperty(window, "__juggleworkApplyDesktopConfig", { value: undefined, configurable: true });
      Object.defineProperty(window, "__juggleworkSetDesktopConfigRefreshResult", { value: undefined, configurable: true });
    };
  }, [applyDesktopConfigActions]);

  const value = useMemo<DesktopConfigStore>(() => {
    // Bind the checker to the latest `config` so callers see the most
    // recent org restrictions without having to recompute every render.
    const checkRestriction: DesktopAppRestrictionChecker = ({ restriction }) =>
      checkDesktopAppRestriction({ config, restriction });
    return { config, loading, refresh, refreshFresh, checkRestriction };
  }, [config, loading, refresh, refreshFresh]);

  return (
    <DesktopConfigContext.Provider value={value}>
      {children}
    </DesktopConfigContext.Provider>
  );
}

export function useDesktopConfig(): DesktopConfigStore {
  const context = use(DesktopConfigContext);
  if (!context) {
    throw new Error("useDesktopConfig must be used within a DesktopConfigProvider");
  }
  return context;
}

/**
 * Convenience hook that returns the raw desktop policy flags
 * (e.g. `{ allowZenModel: true }`). Callers usually just want the flags,
 * not the loading state — feature gates should read through this.
 */
export function useOrgRestrictions(): DenDesktopConfig {
  return useDesktopConfig().config;
}

export function useConnectEnabled(): boolean | undefined {
  return useDesktopConfig().config.connectEnabled;
}

/**
 * Hook variant that returns the stable `checkRestriction` function so
 * feature sites that already receive a "checker" (e.g. helpers ported
 * from Solid stores) can call it directly without reshaping.
 */
export function useCheckDesktopRestriction(): DesktopAppRestrictionChecker {
  return useDesktopConfig().checkRestriction;
}

/**
 * The connected cloud's model catalog as `<providerId>/<modelId>` entries.
 * Empty when the deployment does not restrict models (hosted cloud, older
 * private-cloud builds), so callers can pass it through unconditionally.
 */
export function useDesktopAllowedModels(): readonly string[] {
  return readDesktopAllowedModels(useDesktopConfig().config);
}

/**
 * Single-restriction hook — returns true/false for a specific key.
 * Use this at feature sites that only care about one flag
 * (e.g. `useDesktopRestriction("allowMultipleWorkspaces")`).
 */
export function useDesktopRestriction(
  restriction: Parameters<DesktopAppRestrictionChecker>[0]["restriction"],
): boolean {
  return useDesktopConfig().checkRestriction({ restriction });
}
