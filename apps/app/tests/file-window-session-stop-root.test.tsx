/** @jsxImportSource react */
import * as React from "react";
import { expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const passthrough = ({ children }: React.PropsWithChildren) => children;
const empty = () => null;
let signedIn = false;
const bootstrap = {};
mock.module("../src/app/lib/analytics", () => ({ captureAnalyticsEvent() {}, initAnalytics() {} }));
mock.module("../src/app/lib/den", () => ({ readDenBootstrapConfig: () => bootstrap, readDenSettings: () => ({}), createDenClient() {}, setDenBootstrapConfig() {} }));
mock.module("../src/app/lib/den-handoff", () => ({ exchangeHandoffAndSignIn() {} }));
mock.module("../src/app/lib/toon-factory-auth-lifecycle", () => ({ closeToonFactoryForDenSession() {} }));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ status: signedIn ? "signed-in" : "signed-out", isSignedIn: signedIn }) }));
mock.module("../src/react-app/domains/cloud/forced-signin-page", () => ({ ForcedSigninPage: () => <div data-page="signin" /> }));
mock.module("../src/react-app/domains/cloud/org-onboarding-page", () => ({ OrgOnboardingPage: () => <div data-page="onboarding" /> }));
mock.module("../src/react-app/shell/welcome-route", () => ({ WelcomeRoute: () => <div data-page="welcome" /> }));
mock.module("../src/react-app/shell/workspace-app-route", () => ({ WorkspaceAppRoute: () => <div data-page="workbench" /> }));
mock.module("../src/react-app/shell/control/control-provider", () => ({ JuggleWorkControlProvider: passthrough, JuggleWorkRouteControlActions: empty, useControlAction() {} }));
mock.module("../src/react-app/shell/shell-config", () => ({ ShellConfigProvider: passthrough }));
mock.module("../src/react-app/shell/app-menu", () => ({ AppMenuProvider: passthrough }));
mock.module("../src/react-app/shell/dev-profiler", () => ({ DevProfiler: passthrough, DevProfilerOverlay: empty }));
mock.module("../src/react-app/shell/react-render-watchdog-overlay", () => ({ ReactRenderWatchdogOverlay: empty }));
mock.module("../src/react-app/shell/loading-overlay", () => ({ LoadingOverlay: empty }));
mock.module("../src/react-app/shell/font-zoom", () => ({ useDesktopFontZoomBehavior() {} }));
mock.module("../src/react-app/shell/new-providers-listener", () => ({ NewProvidersListener: empty }));
mock.module("../src/react-app/shell/notification-center", () => ({ NotificationCenterController: empty }));
mock.module("../src/react-app/shell/jugglework-context-publisher", () => ({ JuggleWorkContextPublisher: empty }));
mock.module("../src/react-app/domains/automations/automation-activity-provider", () => ({ AutomationActivityProvider: passthrough }));
mock.module("../src/react-app/domains/automations/automation-run-notification-coordinator", () => ({ AutomationRunNotificationCoordinator: empty }));
mock.module("../src/react-app/domains/settings/state/host-marketplace-plugins-provider", () => ({ HostMarketplacePluginsProvider: passthrough }));

// Reference cleanup must never hold up Stop acknowledgement or navigation.
const firstRelease = mock(() => new Promise<never>(() => {}));
const secondRelease = mock(() => new Promise<never>(() => {}));
const firstClient = { releaseOfficeSelections: firstRelease };
const secondClient = { releaseOfficeSelections: secondRelease };
let snapshot: { juggleworkServerClient: typeof firstClient | null } = { juggleworkServerClient: null };
const start = mock(() => {}), dispose = mock(() => {});
const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, start, dispose };
mock.module("../src/react-app/domains/connections/jugglework-server-store", () => ({ createJuggleWorkServerStore: () => store }));
const { AppRoot } = await import("../src/react-app/shell/app-root");

test("the real AppRoot keeps one Stop listener across signin and routes, and ACKs even when reference release never resolves", async () => {
  const previousWindow = globalThis.window;
  const listeners = new Set<(input: { workspaceId: string; sessionId: string }) => Promise<{ ok: boolean }>>();
  let installs = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
    location: { pathname: "/index.html" }, localStorage: { getItem: () => null },
    __JUGGLEWORK_ELECTRON__: { fileWindow: { onSessionStopRequest: (callback: any) => {
      installs++; listeners.add(callback); return () => listeners.delete(callback);
    } } },
  }) });
  let navigate!: ReturnType<typeof useNavigate>;
  function Root() { navigate = useNavigate(); return <AppRoot />; }
  let view: TestRenderer.ReactTestRenderer | undefined;
  const sessionId = "ses_root_stop", workspaceId = "ws_root_stop";
  const stop = async () => {
    useComposerStateStore.getState().setDraft(sessionId, "keep root input");
    const queued = useComposerStateStore.getState().appendQueuedDraft(sessionId, {
      text: "queued", parts: [{ type: "text", text: "queued" }, { type: "office-selection", references: [{ referenceId: "root-ref" }] } as any], attachments: [],
    });
    useComposerStateStore.getState().claimQueue(sessionId, queued.id);
    expect(listeners.size).toBe(1);
    expect(installs).toBe(1);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const ack = [...listeners][0]!({ workspaceId, sessionId });
      expect(await Promise.race([
        ack,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Stop ACK waited for reference release")), 250); }),
      ])).toEqual({ ok: true });
    } finally { clearTimeout(timeout); }
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]).toBeUndefined();
    expect(useComposerStateStore.getState().queueClaims[sessionId]).toBeUndefined();
    expect(useComposerStateStore.getState().sessions[sessionId]?.draft).toBe("keep root input");
  };
  try {
    signedIn = false; snapshot = { juggleworkServerClient: null };
    await act(async () => { view = TestRenderer.create(<MemoryRouter initialEntries={["/signin"]}><Root /></MemoryRouter>); });
    expect(view.root.findByProps({ "data-page": "signin" })).toBeDefined();
    await stop(); // A still-booting local client cannot prevent local cancellation.
    expect(firstRelease).not.toHaveBeenCalled();
    expect(secondRelease).not.toHaveBeenCalled();
    snapshot = { juggleworkServerClient: firstClient };
    signedIn = true;
    for (const [path, page] of [["/welcome", "welcome"], ["/onboarding", "onboarding"], ["/settings/preferences", "workbench"], ["/session", "workbench"]]) {
      await act(async () => { navigate(path!); });
      expect(view.root.findByProps({ "data-page": page })).toBeDefined();
      await stop();
    }
    expect(firstRelease).toHaveBeenCalledTimes(4);
    expect(firstRelease).toHaveBeenLastCalledWith(workspaceId, sessionId, ["root-ref"]);
    snapshot = { juggleworkServerClient: secondClient };
    signedIn = false;
    await act(async () => { navigate("/signin"); });
    await stop();
    expect(firstRelease).toHaveBeenCalledTimes(4);
    expect(secondRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledWith(workspaceId, sessionId, ["root-ref"]);
    expect(installs).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => { view?.unmount(); });
    expect(listeners.size).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    useComposerStateStore.getState().clearSession(sessionId);
    useComposerStateStore.getState().clearQueuedDrafts(sessionId);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

test("the root coordinator cannot install a listener in the file-window renderer", async () => {
  const previousWindow = globalThis.window;
  const install = mock(() => () => {});
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
    location: { pathname: "/file-window.html" }, localStorage: { getItem: () => null },
    __JUGGLEWORK_ELECTRON__: { fileWindow: { onSessionStopRequest: install } },
  }) });
  let view: TestRenderer.ReactTestRenderer | undefined;
  try {
    signedIn = false;
    await act(async () => { view = TestRenderer.create(<MemoryRouter initialEntries={["/signin"]}><AppRoot /></MemoryRouter>); });
    expect(install).not.toHaveBeenCalled();
  } finally {
    await act(async () => { view?.unmount(); });
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});
