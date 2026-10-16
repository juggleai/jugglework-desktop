import { expect, mock, test } from "bun:test";
import React, { useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter, useNavigate } from "react-router-dom";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let workspaceTarget: "local" | "remote" | null = null;
let mounts = 0;
let toonFactoryMounts = 0;
mock.module("../src/react-app/shell/session-route", () => ({
  SessionRoute: (props: { surfaceVisible: boolean; routeWorkspaceId?: string; onOpenToonFactory?: (workspaceId: string) => void }) => {
    const [instance] = useState(() => ++mounts);
    const [draft, setDraft] = useState("");
    return (
      <div data-session-instance={instance} data-surface-visible={props.surfaceVisible}>
        <input data-session-draft value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button data-open-toon-factory onClick={() => props.onOpenToonFactory?.(props.routeWorkspaceId ?? "")} />
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
mock.module("../src/react-app/domains/automations/automation-page", () => ({ AutomationPage: () => null }));
mock.module("../src/react-app/domains/reviews/review-page", () => ({ ReviewPage: () => null }));
mock.module("../src/react-app/domains/toon-factory/toon-factory-page", () => ({
  ToonFactoryPage: (props: { visible: boolean; projectId: string | null }) => {
    const [instance] = useState(() => ++toonFactoryMounts);
    const [draft, setDraft] = useState("");
    return (
      <div data-toon-factory-instance={instance} data-toon-factory-visible={props.visible} data-project-id={props.projectId}>
        <input data-toon-factory-draft value={draft} onChange={(event) => setDraft(event.target.value)} />
      </div>
    );
  },
}));
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
    await act(async () => { renderer!.root.findByProps({ "data-session-draft": true }).props.onChange({ target: { value: "unsent draft" } }); });
    const instance = renderer!.root.findByProps({ "data-surface-visible": true }).props["data-session-instance"];
    for (const path of [
      "/workspace/workspace-1/settings/preferences",
      "/workspace/workspace-1/apps",
      "/workspace/workspace-1/chat",
      "/automations",
      "/workspace/workspace-1/reviews",
      "/workspace/workspace-1/toon-factory",
    ]) {
      await act(async () => { navigate!(path); });
      const wrapper = () => renderer!.root.findByProps({ "data-testid": "retained-session-surface" });
      expect(wrapper().props.className).toBe("hidden");
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
        expect(renderer!.root.findByProps({ "data-session-draft": true }).props.value).toBe("unsent draft");
        expect(renderer!.root.findByProps({ "data-session-list-preview": "true" }).findByType("button")).toBeDefined();
      }
      workspaceTarget = null;
      await act(async () => { renderer!.update(tree()); });
      expect(wrapper().props.className).toBe("hidden");
    }
    await act(async () => { navigate!("/workspace/workspace-1/session/session-1"); });
    expect(renderer!.root.findByProps({ "data-testid": "retained-session-surface" }).props.className).toBe("h-full min-h-0");
    expect(renderer!.root.findByProps({ "data-surface-visible": true }).props["data-session-instance"]).toBe(instance);
    expect(renderer!.root.findByProps({ "data-session-draft": true }).props.value).toBe("unsent draft");
    expect(mounts).toBe(1);
  } finally {
    workspaceTarget = null;
    await act(async () => { renderer!.unmount(); });
  }
});

test("lazily mounts Toon Factory once, retains its draft, and suspends it while hidden", async () => {
  let navigate: ReturnType<typeof useNavigate>;
  function Navigation() {
    navigate = useNavigate();
    return <WorkspaceAppRoute />;
  }
  const mountBaseline = toonFactoryMounts;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={["/workspace/workspace-1/session/session-1"]}>
        <Navigation />
      </MemoryRouter>,
    );
  });
  try {
    expect(renderer!.root.findAllByProps({ "data-testid": "workspace-toon-factory-surface" })).toHaveLength(0);
    await act(async () => { navigate!("/workspace/workspace-1/toon-factory/project-a"); });
    const instance = renderer!.root.findByProps({ "data-toon-factory-visible": true }).props["data-toon-factory-instance"];
    await act(async () => {
      renderer!.root.findByProps({ "data-toon-factory-draft": true }).props.onChange({ target: { value: "scene draft" } });
    });

    await act(async () => { navigate!("/workspace/workspace-1/reviews"); });
    expect(renderer!.root.findByProps({ "data-testid": "workspace-toon-factory-surface" }).props.className).toBe("hidden");
    expect(renderer!.root.findByProps({ "data-toon-factory-visible": false }).props["data-toon-factory-instance"]).toBe(instance);

    await act(async () => { navigate!("/workspace/workspace-1/session/session-1"); });
    await act(async () => { renderer!.root.findByProps({ "data-open-toon-factory": true }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-toon-factory-visible": true }).props["data-toon-factory-instance"]).toBe(instance);
    expect(renderer!.root.findByProps({ "data-toon-factory-visible": true }).props["data-project-id"]).toBe("project-a");
    expect(renderer!.root.findByProps({ "data-toon-factory-draft": true }).props.value).toBe("scene draft");
    expect(toonFactoryMounts).toBe(mountBaseline + 1);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});
