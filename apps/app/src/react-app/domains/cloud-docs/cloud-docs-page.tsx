import { rememberCloudDocsOrigin } from "./product-view";
/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useCloudDocsBounds } from "./use-cloud-docs-bounds";
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
  useEffect(() => {
    // TIPS: 同一个 settings 事件还用于 IM 刷新；不能因此中断原生编辑和待保存增量。
    const changed = () => setCredentialScope(currentCredentialScope());
    window.addEventListener(denSettingsChangedEvent, changed);
    return () => window.removeEventListener(denSettingsChangedEvent, changed);
  }, []);

  useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    const settings = readDenSettings();
    const instanceId = crypto.randomUUID();
    let disposed = false;
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
          ? t("cloud_docs.enter_organization")
          : t("cloud_docs.desktop_required"),
      );
      return;
    }
    const scope = `${settings.baseUrl}\0${auth.user.id}\0${props.tenantId}\0${denCredentialFingerprint(settings.authToken)}`;
    const stillCurrent = () => {
      const current = readDenSettings();
      return (
        !disposed &&
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
          locale: currentLocale(),
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
    const unsubscribe = bridge.onState((value) => {
      if (!stillCurrent() || value.instanceId !== instanceId) return;
      ready = value.status === "ready";
      failed = value.status === "error" || value.status === "unauthorized";
      setState(value.status);
      if (value.status !== "ready") setError(t(value.status === "unauthorized" ? "cloud_docs.no_access" : "cloud_docs.connection_failed"));
      updateBounds();
      updateAppearance();
      if (ready) bridge.layoutCommand({ instanceId, action: "request-state" });
    });
    const unsubscribeLayout = bridge.onLayout((value) => {
      if (stillCurrent() && value.instanceId === instanceId) setLayout(value.layout);
    });
    const unsubscribeTheme = subscribeToTheme(updateAppearance);
    const unsubscribeLocale = subscribeLocale(updateAppearance);
    const appearanceObserver = new MutationObserver(updateAppearance);
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-brand-accent"],
    });
    const resize = new ResizeObserver(updateBounds);
    if (host.current) resize.observe(host.current);
    const overlays = new MutationObserver(updateBounds);
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state", "hidden"],
    });
    window.addEventListener("resize", updateBounds);
    document.addEventListener("visibilitychange", updateBounds);
    const timeout = window.setTimeout(() => {
      if (stillCurrent() && !ready && !failed) {
        setState("error");
        setError(t("cloud_docs.connection_failed"));
        void bridge.close(instanceId);
      }
    }, 15000);
    void (async () => {
      try {
        const launch = await createDenClient({
          baseUrl: settings.baseUrl,
          token: settings.authToken,
        }).launchCloudDocs({
          tenantId: props.tenantId,
          target: target!,
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
          sourceServerOrigin: settings.baseUrl,
          sourceUserId: auth.user!.id,
          retain: true,
        });
        updateBounds();
      } catch (e) {
        if (stillCurrent()) {
          setState("error");
          setError(
            e instanceof Error ? e.message : t("cloud_docs.connection_failed"),
          );
          void bridge.close(instanceId);
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
      if (activeInstance.current === instanceId) activeInstance.current = null;
      window.removeEventListener("resize", updateBounds);
      document.removeEventListener("visibilitychange", updateBounds);
      void bridge.close(instanceId);
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
          className="relative min-h-0 flex-1"
          data-testid="cloud-docs-native-host"
        >
          {nativeBounds.snapshot && <img src={nativeBounds.snapshot} onLoad={nativeBounds.loaded} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />}
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
                      onClick={() => setAttempt((v) => v + 1)}
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
