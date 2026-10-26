import { expect, mock, test } from "bun:test";
import React, { useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { readFileSync } from "node:fs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let workspaceTarget: "local" | "remote" | null = null;
let mounts = 0;
let latestReviewProps: Record<string, any> | null = null;
mock.module("../src/react-app/shell/session-route", () => ({
  SessionRoute: (props: { surfaceVisible: boolean; embedded?: boolean; routeWorkspaceId: string; routeSessionId: string | null; onSessionTargetChange?: (workspaceId: string, sessionId: string) => void }) => {
    const [instance] = useState(() => ++mounts);
    const [draft, setDraft] = useState("");
    return (
      <div data-session-instance={instance} data-surface-visible={props.surfaceVisible} data-embedded={props.embedded} data-workspace-id={props.routeWorkspaceId} data-session-id={props.routeSessionId}>
        {props.embedded ? <button data-follow-session onClick={() => props.onSessionTargetChange?.("automation-ws", "forked-session")}>Follow session</button> : null}
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        <div data-session-list-preview={workspaceTarget ? "true" : undefined}>
          <button>Open session</button>
        </div>
      </div>
    );
  },
}));
mock.module("../src/react-app/shell/settings-route", () => ({ SettingsRoute: () => null }));
mock.module("../src/react-app/shell/apps-page", () => ({ AppsPage: () => null }));
mock.module("../src/react-app/shell/chat-page", () => ({ ChatPage: () => null }));
mock.module("../src/react-app/shell/toonFactoryPage", () => ({
  ToonFactoryPage: (props: { workspaceId: string }) => <div data-toon-factory-workspace-id={props.workspaceId} />,
}));
mock.module("../src/react-app/domains/automations/automation-page", () => ({
  AutomationPage: (props: { onOpenSession: (workspaceId: string, sessionId: string) => void }) => (
    <button data-open-automation-session onClick={() => props.onOpenSession("automation-ws", "automation-session")}>Open automation</button>
  ),
}));
mock.module("../src/react-app/domains/reviews/review-page", () => ({ ReviewPage: (props: Record<string, any>) => { latestReviewProps = props; return null; } }));
mock.module("../src/react-app/shell/workspace-shell-actions", () => ({
  WorkspaceShellActionsProvider: ({ children }: { children: React.ReactNode }) => children,
  useWorkspaceShellActions: () => ({}),
}));
mock.module("../src/react-app/shell/app-navigation-sidebar-preview", () => ({
  AppNavigationSidebarPreviewProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppNavigationSidebarPreview: () => ({ workspaceTarget }),
}));
mock.module("../src/react-app/shell/session-memory", () => ({
  readActiveWorkspaceId: () => "workspace-1",
  readLastSessionFor: () => "session-1",
}));

const { WorkspaceAppRoute } = await import("../src/react-app/shell/workspace-app-route");

test("retains the session and draft while only the list is revealed over every dedicated app", async () => {
  mounts = 0;
  let navigate: ReturnType<typeof useNavigate>;
  function Navigation() {
    navigate = useNavigate();
    return <WorkspaceAppRoute />;
  }
  const tree = () => (
    <MemoryRouter initialEntries={["/workspace/workspace-1/session/session-1"]}>
      <Navigation />
    </MemoryRouter>
  );
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(tree()); });
  try {
    await act(async () => { renderer!.root.findByType("input").props.onChange({ target: { value: "unsent draft" } }); });
    const instance = renderer!.root.findByProps({ "data-surface-visible": true }).props["data-session-instance"];
    for (const path of [
      "/workspace/workspace-1/settings/preferences",
      "/workspace/workspace-1/apps",
      "/workspace/workspace-1/chat",
      "/automations",
      "/workspace/workspace-1/reviews",
      "/workspace/workspace%201/toon-factory",
    ]) {
      await act(async () => { navigate!(path); });
      const wrapper = () => renderer!.root.findByProps({ "data-testid": "retained-session-surface" });
      expect(wrapper().props.className).toBe("hidden");
      if (path.endsWith("/toon-factory")) {
        expect(renderer!.root.findByProps({ "data-toon-factory-workspace-id": "workspace 1" })).toBeDefined();
      }
      expect(wrapper().props["aria-hidden"]).toBe(true);
      for (const target of ["local", "remote"] as const) {
        workspaceTarget = target;
        await act(async () => { renderer!.update(tree()); });
        expect(wrapper().props.className).toContain("invisible absolute inset-0 z-50");
        expect(wrapper().props.className).toContain("[&_[data-session-list-preview=true]]:visible");
        expect(wrapper().props.className).toContain("[&_[data-session-list-preview=true]]:pointer-events-auto");
        expect(wrapper().props.className).toContain("[&_[data-session-preview-title-hover-guard]]:visible");
        expect(wrapper().props["aria-hidden"]).toBeUndefined();
        expect(renderer!.root.findByProps({ "data-surface-visible": false }).props["data-session-instance"]).toBe(instance);
        expect(renderer!.root.findByType("input").props.value).toBe("unsent draft");
        expect(renderer!.root.findByProps({ "data-session-list-preview": "true" }).findByType("button")).toBeDefined();
      }
      workspaceTarget = null;
      await act(async () => { renderer!.update(tree()); });
      expect(wrapper().props.className).toBe("hidden");
    }
    await act(async () => { navigate!("/workspace/workspace-1/session/session-1"); });
    expect(renderer!.root.findByProps({ "data-testid": "retained-session-surface" }).props.className).toBe("h-full min-h-0");
    expect(renderer!.root.findByProps({ "data-surface-visible": true }).props["data-session-instance"]).toBe(instance);
    expect(renderer!.root.findByType("input").props.value).toBe("unsent draft");
    expect(mounts).toBe(1);
  } finally {
    workspaceTarget = null;
    await act(async () => { renderer!.unmount(); });
  }
});

test("hands GitHub setup to organization Connect settings", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={["/workspace/workspace-1/reviews"]}>
        <WorkspaceAppRoute />
      </MemoryRouter>,
    );
  });
  try {
    expect(latestReviewProps?.onOpenConnect).toBeFunction();
    await act(async () => { latestReviewProps?.onOpenConnect(); });
    expect(renderer!.root.findByProps({ "data-testid": "workspace-settings-surface" }).props.className).toContain("absolute inset-0");
  } finally {
    await act(async () => { renderer!.unmount(); });
    latestReviewProps = null;
  }
});

test("opens automation sessions without leaving automations or mounting a second runtime", async () => {
  mounts = 0;
  let navigate: ReturnType<typeof useNavigate>;
  let pathname = "";
  function Navigation() {
    navigate = useNavigate();
    pathname = useLocation().pathname;
    return <WorkspaceAppRoute />;
  }
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<MemoryRouter initialEntries={["/workspace/workspace-1/session/session-1"]}><Navigation /></MemoryRouter>); });
  try {
    await act(async () => { navigate!("/automations"); });
    await act(async () => { renderer!.root.findByProps({ "data-open-automation-session": true }).props.onClick(); });
    const session = () => renderer!.root.findByProps({ "data-embedded": true });
    expect(pathname).toBe("/automations");
    expect(session().props["data-workspace-id"]).toBe("automation-ws");
    expect(session().props["data-session-id"]).toBe("automation-session");
    expect(session().props["data-surface-visible"]).toBe(true);
    await act(async () => { renderer!.root.findByProps({ "data-follow-session": true }).props.onClick(); });
    expect(pathname).toBe("/automations");
    expect(session().props["data-session-id"]).toBe("forked-session");
    await act(async () => { navigate!("/workspace/workspace-1/session/session-1"); });
    expect(renderer!.root.findByProps({ "data-session-id": "session-1" }).props["data-embedded"]).toBe(false);
    expect(mounts).toBe(1);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("moves a stable portal container into the automation host instead of duplicating SessionRoute", () => {
  const source = readFileSync(new URL("../src/react-app/shell/workspace-app-route.tsx", import.meta.url), "utf8");
  expect(source.match(/<SessionRoute\b/g)).toHaveLength(1);
  expect(source).toContain("createPortal(sessionSurface, sessionContainer)");
  expect(source).toContain("host.appendChild(sessionContainer)");
  expect(source).toContain("onSessionHostChange={setAutomationSessionHost}");
});
