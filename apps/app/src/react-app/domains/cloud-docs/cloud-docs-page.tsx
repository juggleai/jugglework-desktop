import { rememberCloudDocsOrigin } from "./product-view";
import type { CloudDocsAiReference } from "@/app/lib/cloud-docs-types";
/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useCloudDocsBounds } from "./use-cloud-docs-bounds";
import { CloudDocsPlaceholder } from "./cloud-docs-placeholder";
import { LoaderCircle, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t, currentLocale, subscribeLocale } from "@/i18n";
import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";
import {
  createDenClient,
  readDenSettings,
  denCredentialFingerprint,
} from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import {
  AppNavigationRail,
  APP_NAVIGATION_RAIL_WIDTH,
} from "@/react-app/shell/app-navigation-rail";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppSecondarySidebarTopControls } from "@/react-app/shell/app-secondary-sidebar-top-controls";
import { parseCloudDocsTarget } from "./docs-card-navigation";

type Props = {
  tenantId: string;
  targetSearch: string;
  active: boolean;
  workspaceId: string;
  onAiReference?: (reference: CloudDocsAiReference) => void;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenReviews: () => void;
  onOpenSettings: () => void;
};

/** 仅身份边界变化重建视图，忽略 IM 凭据及组织展示资料的刷新。 */
function currentCredentialScope(): string {
  const settings = readDenSettings();
  return `${settings.baseUrl}\0${settings.activeOrgId}\0${denCredentialFingerprint(settings.authToken ?? "")}`;
}

/** 当前组织内的原生云文档页面，账号或组织变动会释放旧原生视图。 */
export function CloudDocsPage(props: Props) {
  const auth = useDenAuth();
  const navigate = useNavigate();
  const target = useMemo(() => parseCloudDocsTarget(props.targetSearch), [props.targetSearch]);
  const host = useRef<HTMLDivElement>(null);
  const nativeBounds = useCloudDocsBounds(host);
  const active = useRef(props.active);
  active.current = props.active;
  const referenceHandler = useRef(props.onAiReference);
  referenceHandler.current = props.onAiReference;
  const updateLayout = useRef<() => void>(() => {});
  useLayoutEffect(() => { updateLayout.current(); }, [props.active]);
  const activeInstance = useRef<string | null>(null);
  const [layout, setLayout] = useState<{ leftOpen: boolean; leftWidth: number; rightOpen: boolean } | null>(null);
  const layoutCommand = (action: "toggle-left" | "toggle-right" | "search") => {
    if (activeInstance.current) window.__JUGGLEWORK_ELECTRON__?.cloudDocs?.layoutCommand({ instanceId: activeInstance.current, action });
  };
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    "loading" | "ready" | "error" | "unauthorized"
  >("loading");
  const [error, setError] = useState("");
  const [credentialScope, setCredentialScope] = useState(currentCredentialScope);
  /** 授权已切换时重开当前空间首页，不重放旧空间的文档／评论定位。 */
  const retry = () => {
    const tenantId = auth.activeOrganization?.id;
    const settings = readDenSettings();
    if (auth.isSignedIn && tenantId && settings.activeOrgId === tenantId && tenantId !== props.tenantId) {
      navigate(`/cloud-docs/${encodeURIComponent(tenantId)}`, { replace: true });
    } else {
      setAttempt(value => value + 1);
    }
  };
  useEffect(() => {
    // TIPS: 同一个 settings 事件还用于 IM 刷新；不能因此中断原生编辑和待保存增量。
    const changed = () => setCredentialScope(currentCredentialScope());
    window.addEventListener(denSettingsChangedEvent, changed);
    return () => window.removeEventListener(denSettingsChangedEvent, changed);
  }, []);

  useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    const settings = readDenSettings();
    const newInstanceId = crypto.randomUUID();
    let instanceId: string = newInstanceId;
    let disposed = false;
    let expired = false;
    let ready = false;
    let failed = false;
    activeInstance.current = instanceId;
    setLayout(null);
    setState("loading");
    setError("");
    if (
      !bridge ||
      !target ||
      !auth.user ||
      !auth.isSignedIn ||
      !settings.authToken ||
      props.tenantId !== auth.activeOrganization?.id ||
      settings.activeOrgId !== props.tenantId
    ) {
      setState("error");
      setError(
        bridge
          ? t(auth.isSignedIn && auth.activeOrganization && props.tenantId !== auth.activeOrganization.id ? "cloud_docs.context_changed" : "cloud_docs.enter_organization")
          : t("cloud_docs.desktop_required"),
      );
      return;
    }
    const scope = `${settings.baseUrl}\0${auth.user.id}\0${props.tenantId}\0${denCredentialFingerprint(settings.authToken)}`;
    const stillCurrent = () => {
      const current = readDenSettings();
      return (
        !disposed && !expired &&
        scope ===
          `${current.baseUrl}\0${auth.user?.id}\0${current.activeOrgId}\0${denCredentialFingerprint(current.authToken ?? "")}`
      );
    };
    const updateAppearance = () => {
      if (!ready || !stillCurrent() || !host.current) return;
      const styles = getComputedStyle(host.current);
      const color = (token: string, fallback: string) => {
        const value = styles.getPropertyValue(token).trim();
        return CSS.supports("color", value) ? value : fallback;
      };
      const dark = getResolvedThemeMode() === "dark";
      bridge.setAppearance({
        instanceId,
        appearance: {
          theme: dark ? "dark" : "light",
          locale: document.documentElement.lang || currentLocale(),
          fontFamily: styles.fontFamily,
          colors: {
            background: color("--background", dark ? "#111113" : "#ffffff"),
            foreground: color("--foreground", dark ? "#edeef0" : "#1c2024"),
            sidebar: color("--dls-sidebar", dark ? "#18191b" : "#f7f7f7"),
            border: color("--dls-border", dark ? "#303136" : "#e5e7eb"),
            muted: color("--muted-foreground", dark ? "#a0a0a0" : "#6b7280"),
            accent: color("--dls-accent", dark ? "#e5e7eb" : "#011627"),
            accentForeground: color(
              "--dls-accent-fg",
              dark ? "#111113" : "#ffffff",
            ),
          },
        },
      });
    };
    const updateBounds = () => {
      nativeBounds.sync(instanceId, ready, active.current);
    };
    updateLayout.current = () => {
      updateBounds();
      if (active.current && ready) {
        updateAppearance();
        bridge.layoutCommand({ instanceId, action: "request-state" });
      }
    };
    const applyState: Parameters<typeof bridge.onState>[0] = (value) => {
      if (!stillCurrent() || value.instanceId !== instanceId) return;
      ready = value.status === "ready";
      failed = value.status === "error" || value.status === "unauthorized";
      setState(value.status);
      if (value.status !== "ready") setError(t(value.status === "unauthorized" ? "cloud_docs.no_access" : "cloud_docs.connection_failed"));
      updateAppearance();
      updateBounds();
      if (ready) bridge.layoutCommand({ instanceId, action: "request-state" });
    };
    const unsubscribe = bridge.onState(applyState);
    const unsubscribeLayout = bridge.onLayout((value) => {
      if (stillCurrent() && value.instanceId === instanceId) setLayout(value.layout);
    });
    const unsubscribeReference = bridge.onAiReference(reference => {
      if (active.current && stillCurrent() && reference.instanceId === instanceId && reference.tenantId === props.tenantId)
        referenceHandler.current?.(reference);
    });
    const unsubscribeTheme = subscribeToTheme(updateAppearance);
    const unsubscribeLocale = subscribeLocale(updateAppearance);
    const appearanceObserver = new MutationObserver(updateAppearance);
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "lang", "data-theme", "data-brand-accent"],
    });
    const resize = new ResizeObserver(updateBounds);
    if (host.current) resize.observe(host.current);
    const overlays = new MutationObserver(updateBounds);
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state", "data-open", "data-closed", "hidden", "class", "style", "aria-modal", "data-session-list-preview"],
    });
    window.addEventListener("resize", updateBounds);
    document.addEventListener("visibilitychange", updateBounds);
    // TIPS: 远端 AFFiNE 首次打开需要下载较大的按需分包；15 秒会在页面即将就绪时误判失败。
    const timeout = window.setTimeout(() => {
      if (stillCurrent() && !ready && !failed) {
        expired = true;
        setState("error");
        setError(t("cloud_docs.connection_failed"));
        void bridge.close(instanceId).catch(() => {});
      }
    }, 60_000);
    void (async () => {
      try {
        // TIPS: 等待本轮挂载确认，避免 StrictMode 的预检先认领唯一预热视图，随后又将它关闭。
        await Promise.resolve();
        if (!stillCurrent()) return;
        const client = createDenClient({
          baseUrl: settings.baseUrl,
          token: settings.authToken,
        });
        const identity = {
          sourceServerOrigin: settings.baseUrl,
          sourceUserId: auth.user!.id,
          tenantId: props.tenantId,
        };
        if (bridge.warmupClaim && bridge.status) {
          const warmed = await bridge.warmupClaim({
            ...identity, target, authFingerprint: denCredentialFingerprint(settings.authToken ?? ""),
          });
          if (!stillCurrent()) {
            if (warmed) void bridge.close(warmed).catch(() => {});
            return;
          }
          if (warmed) {
            instanceId = warmed;
            activeInstance.current = warmed;
            const status = await bridge.status(warmed);
            if (!stillCurrent()) return;
            applyState({ instanceId: warmed, status: status.status ?? (status.ready ? "ready" : "loading") });
            return;
          }
        }
        if (bridge.resumeCandidate && bridge.resume) {
          const candidate = await bridge.resumeCandidate({ ...identity, target });
          if (!stillCurrent()) return;
          if (candidate) {
            const started = performance.now();
            const grant = await client.launchCloudDocs({
              tenantId: identity.tenantId,
              target: candidate.target,
              presentation: { instanceId: candidate.instanceId, mode: "product" },
            });
            if (!stillCurrent()) return;
            if (grant.tenantId !== identity.tenantId || grant.presentation.instanceId !== candidate.instanceId)
              throw new Error(t("cloud_docs.connection_failed"));
            // TIPS: 先绑定本轮订阅，随后才请求 Main 接管；既有 ready 状态可立刻重发。
            instanceId = candidate.instanceId;
            activeInstance.current = instanceId;
            const outcome = await bridge.resume({
              ...grant, ...identity, instanceId, target,
              startupLaunchMs: performance.now() - started,
            });
            if (!stillCurrent()) {
              if (outcome === "resumed") void bridge.close(instanceId).catch(() => {});
              return;
            }
            if (outcome === "resumed") {
              rememberCloudDocsOrigin(identity.tenantId, grant.bootstrapUrl);
              updateBounds();
              return;
            }
            instanceId = newInstanceId;
            activeInstance.current = instanceId;
            if (outcome === "denied") {
              failed = true;
              setState("unauthorized");
              setError(t("cloud_docs.no_access"));
              return;
            }
            if (outcome !== "fallback") throw new Error(t("cloud_docs.connection_failed"));
          }
        }
        const launchStarted = performance.now();
        const launch = await client.launchCloudDocs({
          tenantId: identity.tenantId,
          target,
          presentation: { instanceId, mode: "product" },
        });
        if (!stillCurrent()) return;
        if (
          launch.tenantId !== props.tenantId ||
          launch.presentation.instanceId !== instanceId
        )
          throw new Error(t("cloud_docs.connection_failed"));
        rememberCloudDocsOrigin(props.tenantId, launch.bootstrapUrl);
        await bridge.open({
          ...launch,
          instanceId,
          ...identity,
          retain: true,
          fullPage: true,
          startupLaunchMs: performance.now() - launchStarted,
        });
        if (!stillCurrent()) {
          void bridge.close(instanceId).catch(() => {});
          return;
        }
        updateBounds();
      } catch (e) {
        if (stillCurrent()) {
          failed = true;
          setState("error");
          const message = e instanceof Error ? e.message : t("cloud_docs.connection_failed");
          setError(message.includes("docs_local_save_pending") ? t("cloud_docs.close_save_pending") : message);
          void bridge.close(instanceId).catch(() => {});
        }
      }
    })();
    return () => {
      disposed = true;
      nativeBounds.sync(instanceId, false, false);
      updateLayout.current = () => {};
      clearTimeout(timeout);
      resize.disconnect();
      overlays.disconnect();
      appearanceObserver.disconnect();
      unsubscribeTheme();
      unsubscribeLocale();
      unsubscribe();
      unsubscribeLayout();
      unsubscribeReference();
      if (activeInstance.current === instanceId) activeInstance.current = null;
      window.removeEventListener("resize", updateBounds);
      document.removeEventListener("visibilitychange", updateBounds);
      void bridge.close(instanceId).catch(() => {});
    };
  }, [
    props.tenantId,
    auth.user?.id,
    auth.isSignedIn,
    auth.activeOrganization?.id,
    attempt,
    credentialScope,
    target,
  ]);


  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag"
      style={{ "--jugglework-left-sidebar-width": `${layout?.leftWidth ?? 248}px` } as CSSProperties}>
      {state === "ready" && layout ? <>
        <AppSecondarySidebarTopControls
          sidebarOpen={layout.leftOpen}
          searchLabel={t("cloud_docs.search")}
          onOpenTaskSearch={() => layoutCommand("search")}
          onToggleSidebar={() => layoutCommand("toggle-left")}
        />
        <Button variant="ghost" size="icon-sm"
          className="absolute right-3 top-1.5 z-50 border-none text-dls-secondary mac:titlebar-no-drag"
          title={t(layout.rightOpen ? "sidebar.collapse_right" : "sidebar.expand_right")}
          aria-label={t(layout.rightOpen ? "sidebar.collapse_right" : "sidebar.expand_right")}
          aria-expanded={layout.rightOpen}
          onClick={() => layoutCommand("toggle-right")}
          data-testid="cloud-docs-right-sidebar-toggle">
          <PanelRight className="size-3.5" />
        </Button>
      </> : null}
      <div
        style={{ width: APP_NAVIGATION_RAIL_WIDTH }}
        className="h-full shrink-0"
      >
        <AppNavigationRail {...props} />
      </div>
      <AppInsetSurface className="flex flex-col" testId="cloud-docs-surface">
        <div
          ref={host}
          className="relative min-h-0 flex-1 overflow-hidden rounded-[inherit]"
          data-testid="cloud-docs-native-host"
        >
          {nativeBounds.snapshot && <img src={nativeBounds.snapshot} onLoad={nativeBounds.loaded} onError={nativeBounds.failed} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />}
          {nativeBounds.fallback && <CloudDocsPlaceholder />}
          {state !== "ready" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center text-sm text-muted-foreground">
              {state === "loading" ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  {t("cloud_docs.loading")}
                </>
              ) : (
                <>
                  <p>{error}</p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={retry}
                    >
                      {t("cloud_docs.retry")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => navigate("/session")}
                    >
                      {t("cloud_docs.back")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      </AppInsetSurface>
    </div>
  );
}
