import { expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("../src/react-app/shell/app-navigation-rail", () => ({
  AppNavigationRail: () => <nav data-testid="mock-app-rail" />,
}));
mock.module("../src/react-app/shell/workspace-shell-layout", () => ({
  appInsetSidebarCssWidth: () => "240px",
  useWorkspaceShellLayout: () => ({ leftSidebarWidth: 240 }),
}));

const { TaskPage, TaskShellContent } = await import("../src/react-app/domains/tasks/task-page");

test("renders an Agent-independent empty task center shell", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={["/tasks"]}>
        <TaskPage
          workspaceId="workspace-1"
          sessionPath="/workspace/workspace-1/session/session-1"
          onOpenAccount={() => undefined}
          onOpenApps={() => undefined}
          onOpenChat={() => undefined}
          onOpenReviews={() => undefined}
          onOpenSettings={() => undefined}
          state={{ kind: "empty" }}
        />
      </MemoryRouter>,
    );
  });
  try {
    expect(renderer!.root.findByProps({ "data-testid": "tasks-sidebar" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "tasks-main" })).toBeDefined();
    expect(renderer!.root.findAllByProps({ children: "No tasks yet" })).toHaveLength(1);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("renders loading and retryable error states", async () => {
  let retried = 0;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<TaskShellContent state={{ kind: "loading" }} />);
  });
  expect(renderer!.root.findByProps({ role: "status" })).toBeDefined();
  await act(async () => {
    renderer!.update(<TaskShellContent state={{ kind: "error", onRetry: () => { retried += 1; } }} />);
  });
  expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
  await act(async () => { renderer!.root.findByType("button").props.onClick(); });
  expect(retried).toBe(1);
  await act(async () => { renderer!.unmount(); });
});
