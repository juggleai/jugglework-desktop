import { expect, mock, test } from "bun:test";
import React, { useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter, useNavigate } from "react-router-dom";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let workspaceTarget: "local" | "remote" | null = null;
let mounts = 0;
mock.module("../src/react-app/shell/session-route", () => ({
  SessionRoute: (props: { surfaceVisible: boolean }) => {
    const [instance] = useState(() => ++mounts);
    const [draft, setDraft] = useState("");
    return (
      <div data-session-instance={instance} data-surface-visible={props.surfaceVisible}>
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
mock.module("../src/react-app/domains/automations/automation-page", () => ({ AutomationPage: () => null }));
mock.module("../src/react-app/domains/reviews/review-page", () => ({ ReviewPage: () => null }));
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
    await act(async () => { renderer!.root.findByType("input").props.onChange({ target: { value: "unsent draft" } }); });
    const instance = renderer!.root.findByProps({ "data-surface-visible": true }).props["data-session-instance"];
    for (const path of [
      "/workspace/workspace-1/settings/preferences",
      "/workspace/workspace-1/apps",
      "/workspace/workspace-1/chat",
      "/automations",
      "/workspace/workspace-1/reviews",
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
