import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { UseWorkspaceRouteStateInput } from "../src/react-app/shell/use-workspace-route-state";
import type { RouteSession, RouteWorkspace } from "../src/react-app/shell/route-workspaces";

mock.module("../src/react-app/kernel/local-provider", () => ({
  useLocal: () => ({ prefs: { hasCompletedOnboarding: false } }),
}));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ status: "signed-out", isSignedIn: false }),
}));
mock.module("../src/react-app/shell/boot-state", () => ({
  useBootState: () => ({ markRouteReady: noop }),
}));
mock.module("../src/react-app/shell/jugglework-connection", () => ({
  resolveJuggleWorkConnection: async () => ({
    normalizedBaseUrl: "", resolvedToken: "", resolvedHostToken: "", hostInfo: null,
  }),
}));

const { useWorkspaceRouteState } = await import("../src/react-app/shell/use-workspace-route-state");
const { writeLastSessionFor } = await import("../src/react-app/shell/session-memory");
const noop = () => {};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
let renderer: TestRenderer.ReactTestRenderer | undefined;
let state: ReturnType<typeof useWorkspaceRouteState>;
let pathname = "";

function Probe({ input }: { input: UseWorkspaceRouteStateInput }) {
  state = useWorkspaceRouteState(input);
  pathname = useLocation().pathname;
  return null;
}

async function mount(input: Partial<UseWorkspaceRouteStateInput> = {}) {
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={["/automations"]}>
        <Routes>
          <Route path="/workspace/:workspaceId/session/:sessionId?" element={
            <Probe input={{ developerMode: false, onServerSettingsChanged: noop, onHostInfo: noop, ...input, routeSessionId: undefined }} />
          } />
          <Route path="*" element={
            <Probe input={{ developerMode: false, onServerSettingsChanged: noop, onHostInfo: noop, ...input }} />
          } />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const workspace = { id: "workspace-a", path: "/test", workspaceType: "local", displayNameResolved: "Test" } as RouteWorkspace;
async function seedWorkspace() {
  writeLastSessionFor(workspace.id, "remembered");
  await act(async () => {
    state.setWorkspaces([workspace]);
    state.setLegacySelectedWorkspaceId(workspace.id);
    state.setSessionsByWorkspaceId({ [workspace.id]: [{ id: "remembered" } as RouteSession] });
  });
}

beforeEach(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      setTimeout, clearTimeout,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    }),
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalActEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("embedded session navigation", () => {
  test("keeps automations on empty startup and an invalid workspace without requesting a fallback", async () => {
    const onSessionTargetChange = mock();
    await mount({ embedded: true, routeWorkspaceId: "missing", routeSessionId: null, onSessionTargetChange });
    await seedWorkspace();
    expect(pathname).toBe("/automations");
    expect(state.selectedSessionId).toBeNull();
    expect(onSessionTargetChange).not.toHaveBeenCalled();
  });

  test("does not restore the last session in a valid embedded workspace", async () => {
    const onSessionTargetChange = mock();
    await mount({ embedded: true, routeWorkspaceId: workspace.id, routeSessionId: null, onSessionTargetChange });
    await seedWorkspace();
    expect(state.selectedSessionId).toBeNull();
    expect(pathname).toBe("/automations");
    expect(onSessionTargetChange).not.toHaveBeenCalled();
  });

  test("reports explicit session/root/legacy targets without changing the URL", async () => {
    const onSessionTargetChange = mock();
    await mount({ embedded: true, routeWorkspaceId: workspace.id, routeSessionId: null, onSessionTargetChange });
    await act(async () => {
      state.navigateToWorkspaceSession(" workspace-b ", " session-b ");
      state.navigateToWorkspaceSession(workspace.id, null, { replace: true });
      state.navigateToWorkspaceSession("");
    });
    expect(onSessionTargetChange.mock.calls).toEqual([["workspace-b", "session-b"], [workspace.id, null], ["", null]]);
    expect(pathname).toBe("/automations");
  });

  test("does not escape embedded mode when the optional callback is absent", async () => {
    await mount({ embedded: true });
    await seedWorkspace();
    await act(async () => state.navigateToWorkspaceSession(workspace.id, "other"));
    expect(pathname).toBe("/automations");
  });

  test("ordinary mode still redirects an empty unconfigured app to welcome", async () => {
    await mount();
    expect(pathname).toBe("/welcome");
  });

  test("ordinary mode still falls back from a missing workspace", async () => {
    await mount({ routeWorkspaceId: "missing", routeSessionId: "selected" });
    await seedWorkspace();
    expect(pathname).toBe("/workspace/workspace-a/session/selected");
  });

  test("ordinary mode still restores remembered sessions and uses browser navigation", async () => {
    await mount({ routeWorkspaceId: workspace.id, routeSessionId: null });
    await seedWorkspace();
    expect(pathname).toBe("/workspace/workspace-a/session/remembered");
    await act(async () => state.navigateToWorkspaceSession(workspace.id, "other"));
    expect(pathname).toBe("/workspace/workspace-a/session/other");
  });
});

describe("embedded session composition contract", () => {
  const route = readFileSync(new URL("../src/react-app/shell/session-route.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url), "utf8");

  test("passes the host contract through the route and excludes hidden split runtime/palette targets", () => {
    expect(route).toContain("onSessionTargetChange: props.onSessionTargetChange");
    expect(route).toContain("embedded: props.embedded");
    expect(route).toContain("<SessionPage\n      embedded={props.embedded}");
    expect(route).toContain("!props.embedded && state.workspaceId === selectedWorkspaceId ? state.splitSessionId : null");
    expect(route).toContain('!props.embedded && state.workspaceId === selectedWorkspaceId && state.focusedPane === "secondary"');
    expect(route).not.toContain("navigate(legacySessionRoute());");
  });

  test("keeps primary controls and real surfaces/panels while removing nested shell chrome", () => {
    expect(page).toContain('props.embedded ? "primary" : state.focusedPane');
    expect(page).toContain("const actionSessionId = props.embedded ? props.selectedSessionId :");
    expect(page).toContain("const splitSessionId = !props.embedded &&");
    expect(page).toContain("if (!props.embedded) return;");
    expect(page).toContain("setWorkbenchSplit(null);");
    expect(page).toContain("return () => useWorkbenchStore.setState((current) => ({");
    expect(page).toContain("workspaceId, workspaceTitle, primarySessionId, tabs, splitSessionId, focusedPane,");
    expect(page).toContain("{!props.embedded ? <AppSidebar");
    expect(page).toContain("{!props.embedded && shellConfig.sidebar && !sidebarOpen ? (");
    expect(page).toContain("{!props.embedded && shellConfig.sidebar && sidebarOpen ? (");
    expect(page).toContain('props.embedded && (sidebarOpen');
    expect(page).toContain('"rounded-l-none rounded-r-[18px] border-l-0"');
    expect(page).toContain("style={props.embedded ? { left: 0 }");
    expect(page).toContain("{sessionTopBar}");
    expect(page).not.toContain("data-embedded-session-back");
    expect(page).toContain("data-embedded-session-collapsed-controls");
    expect(page).toContain("data-embedded-session-task-search");
    expect(page).toContain("data-embedded-session-sidebar-toggle");
    expect(page).toContain("showBadge={false}");
    expect(page).toContain("{!props.embedded ? (");
    expect(page).toContain("<SessionSurface");
    expect(page).toContain("<SidePanel");
    expect(page).toContain("<FilesPanel");
  });

  test("keeps the embedded top bar draggable without duplicate automation metadata", () => {
    expect(page).toMatch(/style=\{\{ WebkitAppRegion: "drag" \} as CSSProperties\}[\s\S]+data-session-shell-topbar/);
    expect(page).toMatch(/WebkitAppRegion: "no-drag"[\s\S]+data-embedded-session-collapsed-controls/);
    expect(page).toMatch(/WebkitAppRegion: "no-drag"[\s\S]+data-session-topbar-actions/);
    expect(page).toMatch(/<AutomationSessionStatus[\s\S]+showBadge=\{false\}/);
    expect(page).toMatch(/\{!props\.embedded \? \([\s\S]+\{workspaceName\}/);
  });
});
