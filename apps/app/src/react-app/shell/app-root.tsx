/** @jsxImportSource react */

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { captureAnalyticsEvent, initAnalytics } from "../../app/lib/analytics";
import {
  createDenClient,
  readDenBootstrapConfig,
  readDenSettings,
  setDenBootstrapConfig,
} from "../../app/lib/den";
import { exchangeHandoffAndSignIn } from "../../app/lib/den-handoff";
import {
  denSettingsChangedEvent,
  denSessionUpdatedEvent,
} from "../../app/lib/den-session-events";
import { evalRelaunchDesktopApp } from "../../app/lib/desktop";
import { Button } from "../../components/ui/button";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/use-locale";
import { useDenAuth } from "../domains/cloud/den-auth-provider";
import { ForcedSigninPage } from "../domains/cloud/forced-signin-page";
import { OrgOnboardingPage } from "../domains/cloud/org-onboarding-page";
import { NewProvidersListener } from "./new-providers-listener";
import { useDesktopFontZoomBehavior } from "./font-zoom";
import { LoadingOverlay } from "./loading-overlay";
import { DevProfiler, DevProfilerOverlay } from "./dev-profiler";
import { ReactRenderWatchdogOverlay } from "./react-render-watchdog-overlay";
import { AppMenuProvider } from "./app-menu";
import {
  JuggleWorkControlProvider,
  JuggleWorkRouteControlActions,
  useControlAction,
  type JuggleWorkControlAction,
} from "./control/control-provider";
import { JuggleWorkContextPublisher } from "./jugglework-context-publisher";
import { WorkspaceAppRoute } from "./workspace-app-route";
import { ShellConfigProvider } from "./shell-config";
import { resolveSigninGateDecision } from "./signin-gate";
import { WelcomeRoute } from "./welcome-route";
import { NotificationCenterController } from "./notification-center";
import { RootJuggleWorkServerProvider } from "../domains/connections/root-jugglework-server-provider";
import { AutomationRunNotificationCoordinator } from "../domains/automations/automation-run-notification-coordinator";

type DenSigninGateProps = {
  children: ReactNode;
};

const readDenBootstrapSnapshot = () => readDenBootstrapConfig();

const subscribeToDenBootstrap = (onStoreChange: () => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => {
    window.removeEventListener(denSettingsChangedEvent, onStoreChange);
  };
};

/**
 * Sign-in gate.
 *
 * Sign-in is mandatory: no app route renders without a Den session. Anyone
 * without one is held at `/signin`, and signing out drops the session, which
 * lands them right back here. This is deliberately independent of
 * `bootstrap.requireSignin` — a desktop bootstrap file must never be able to
 * unlock the app for an anonymous user.
 *
 * `resolveSigninGateDecision` owns the routing/render rules; this component
 * only wires them to the router. Note that `isSignedIn` still covers the
 * `unavailable` status, so an offline user with a valid token keeps working.
 */
function DenSigninGate({ children }: DenSigninGateProps) {
  const denAuth = useDenAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const bootstrap = useSyncExternalStore(
    subscribeToDenBootstrap,
    readDenBootstrapSnapshot,
    readDenBootstrapSnapshot,
  );
  const decision = resolveSigninGateDecision({
    status: denAuth.status,
    isSignedIn: denAuth.isSignedIn,
    path: location.pathname,
    hasPreparedBootstrap: Boolean(bootstrap.prepared),
  });
  const redirectTo = decision.redirectTo;

  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true });
  }, [navigate, redirectTo]);

  // After a fresh sign-in, navigate to the onboarding page so the
  // user sees what their org provides.
  // Poll for activeOrgId (set asynchronously by refreshOrgs) rather
  // than using a fixed delay — handles both fast and slow org lookups.
  useEffect(() => {
    const handler = (event: WindowEventMap[typeof denSessionUpdatedEvent]) => {
      if (event.detail?.status !== "success") return;
      let attempts = 0;
      const check = () => {
        attempts++;
        const settings = readDenSettings();
        if (settings.authToken?.trim() && settings.activeOrgId?.trim()) {
          navigate("/onboarding", { replace: true });
        } else if (attempts < 10) {
          // Org not selected yet — retry (max ~5 seconds)
          setTimeout(check, 500);
        }
      };
      // First check after a short delay for the auth to settle
      setTimeout(check, 500);
    };
    window.addEventListener(denSessionUpdatedEvent, handler);
    return () => window.removeEventListener(denSessionUpdatedEvent, handler);
  }, [navigate]);

  // Keep the boot overlay up until the first session check settles.
  if (decision.render === "pending") return null;

  if (decision.render === "signin") {
    return <ForcedSigninPage developerMode={false} />;
  }

  return (
    <>
      {denAuth.status === "unavailable" ? (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl border border-amber-7/50 bg-popover/95 px-4 py-3 text-popover-foreground shadow-md backdrop-blur-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("den.cloud_unavailable_title")}</p>
              <p className="text-xs text-muted-foreground">{t("den.cloud_unavailable_body")}</p>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void denAuth.refresh()}
            >
              {t("den.refresh")}
            </Button>
          </div>
        </div>
      ) : null}
      {children}
    </>
  );
}

/**
 * Control actions for cloud auth. Placed inside JuggleWorkControlProvider so
 * the actions are available on every route (including /welcome and /signin).
 */
function DenAuthControlActions() {
  const denAuth = useDenAuth();

  const exchangeGrantAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "auth.exchange-grant",
    label: "Sign in with a handoff grant",
    description: "Exchange a desktop handoff grant string to sign in without the browser flow.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "grant", type: "string", required: true, description: "The raw handoff grant string." },
      { name: "baseUrl", type: "string", required: false, description: "Optional Den base URL." },
    ],
    execute: async (args) => {
      const { grant, baseUrl: argBaseUrl } = (args ?? {}) as { grant?: string; baseUrl?: string };
      if (!grant?.trim()) return { ok: false, error: "grant is required" };
      const settings = readDenSettings();
      const targetBaseUrl = argBaseUrl?.trim() || settings.baseUrl;
      const client = createDenClient({ baseUrl: targetBaseUrl });
      const result = await exchangeHandoffAndSignIn(grant.trim(), {
        baseUrl: targetBaseUrl,
        client,
        fallbackErrorMessage: "No token returned",
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { email: result.exchange.user?.email };
    },
  }), []);
  useControlAction(exchangeGrantAction);

  const authStatusAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "auth.status",
    label: "Get auth status",
    description: "Return the current cloud sign-in status and user.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => ({
      status: denAuth.status,
      user: denAuth.user ? { email: denAuth.user.email, name: denAuth.user.name } : null,
    }),
  }), [denAuth.status, denAuth.user]);
  useControlAction(authStatusAction);

  const setEvalBaseUrlAction = useMemo<JuggleWorkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.auth.set-base-url",
      label: "Set the eval Cloud URL",
      description: "Point the live auth provider at an eval control plane and refresh its session state.",
      sideEffect: "mutation",
      requiresArgs: true,
      args: [
        { name: "baseUrl", type: "string", required: true, description: "Temporary Den base URL." },
      ],
      execute: async (args) => {
        if (
          !args ||
          typeof args !== "object" ||
          !("baseUrl" in args) ||
          typeof args.baseUrl !== "string" ||
          !args.baseUrl.trim()
        ) {
          return { ok: false, error: "baseUrl is required" };
        }
        const current = readDenBootstrapConfig();
        await setDenBootstrapConfig({
          baseUrl: args.baseUrl.trim(),
          requireSignin: current.requireSignin,
        });
        await denAuth.refresh();
        return { baseUrl: readDenBootstrapConfig().baseUrl };
      },
    };
  }, [denAuth.refresh]);
  useControlAction(setEvalBaseUrlAction);

  return null;
}

/**
 * Control action for eval automation: inject brand theme (logo, icon, accent color)
 * via the dev-only desktop config bridge. Placed inside JuggleWorkControlProvider.
 */
function BrandThemeControlActions() {
  const applyAction = useMemo<JuggleWorkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.brand_theme.apply",
      label: "Apply brand theme override",
      description: "Inject brand theme (logo, icon, accent color) via desktop config for eval testing.",
      sideEffect: "mutation",
      args: [
        { name: "brandLogoUrl", type: "string", description: "Logo URL" },
        { name: "brandIconUrl", type: "string", description: "Icon URL" },
        { name: "brandAccentColor", type: "string", description: "Radix color family" },
      ],
      execute: (args) => {
        const bridge = (window as unknown as Record<string, unknown>).__juggleworkApplyDesktopConfig;
        if (typeof bridge !== "function") {
          return { ok: false, error: "Desktop config bridge not available (dev mode only)." };
        }
        bridge(args);
        return { applied: args };
      },
    };
  }, []);
  useControlAction(applyAction);

  const relaunchAction = useMemo<JuggleWorkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.app.relaunch",
      label: "Relaunch app for eval",
      description: "Dev-only eval hook that relaunches the Electron app.",
      sideEffect: "mutation",
      execute: () => evalRelaunchDesktopApp(),
    };
  }, []);
  useControlAction(relaunchAction);

  return null;
}

let appOpenedCaptured = false;

export function AppRoot() {
  useDesktopFontZoomBehavior();

  // TIPS: 订阅语言，切换后立刻重渲染整棵树；不加 key，避免卸载重挂载导致
  // 会话重连与本地 UI 状态丢失。
  useLocale();

  // Module-level dedupe keeps StrictMode double-mounts from double-counting.
  useEffect(() => {
    if (appOpenedCaptured) return;
    appOpenedCaptured = true;
    initAnalytics();
    captureAnalyticsEvent("app_opened", {});
  }, []);

  return (
    <>
      <DevProfiler id="AppRoot">
        <ShellConfigProvider>
        <AppMenuProvider>
        <JuggleWorkControlProvider>
          <JuggleWorkRouteControlActions />
          <NotificationCenterController />
          <JuggleWorkContextPublisher />
          <DenAuthControlActions />
          <BrandThemeControlActions />
          <DenSigninGate>
              <RootJuggleWorkServerProvider>
                <AutomationRunNotificationCoordinator />
                <Routes>
              <Route
                path="/signin"
                element={
                  <DevProfiler id="SigninRoute">
                    <ForcedSigninPage developerMode={false} />
                  </DevProfiler>
                }
              />
              <Route
                path="/onboarding"
                element={
                  <DevProfiler id="OrgOnboarding">
                    <OrgOnboardingPage />
                  </DevProfiler>
                }
              />
              <Route
                path="/welcome"
                element={
                  <DevProfiler id="WelcomeRoute">
                    <WelcomeRoute />
                  </DevProfiler>
                }
              />

              {/* Default + fallback: land on the session view. Users open
                  settings deliberately via the sidebar or command palette. */}
              <Route path="/" element={<Navigate to="/session" replace />} />
              <Route
                path="*"
                element={
                  <DevProfiler id="WorkspaceAppRoute">
                    <WorkspaceAppRoute />
                  </DevProfiler>
                }
              />
              </Routes>
            </RootJuggleWorkServerProvider>
          </DenSigninGate>
        </JuggleWorkControlProvider>
        </AppMenuProvider>
        </ShellConfigProvider>
        <LoadingOverlay />
      </DevProfiler>
      {/*
        DevProfilerOverlay sits OUTSIDE the AppRoot <Profiler> zone on
        purpose. The overlay re-renders on every emit() to refresh its
        table, and any commit inside a <Profiler> is recorded as a
        commit on that zone. Mounting the overlay inside AppRoot would
        inflate AppRoot's commit count by hundreds of overlay
        self-renders for every real user-visible commit, masking the
        true app-level signal.
      */}
      <NewProvidersListener />
      <DevProfilerOverlay />
      <ReactRenderWatchdogOverlay />
    </>
  );
}
