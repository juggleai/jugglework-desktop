import { afterEach, expect, test } from "bun:test";
import React, { useMemo, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import { t } from "../src/i18n";
import type { TaskSection } from "../src/react-app/domains/tasks/task-page-state";
import type { TasksSidebarRegistration } from "../src/react-app/domains/tasks/tasks-sidebar";
import {
  AppNavigationSidebarPreviewProvider,
  useAppNavigationSidebarPreview,
  usePublishTasksSidebar,
} from "../src/react-app/shell/app-navigation-sidebar-preview";
import { useUiStateStore } from "../src/react-app/shell/ui-state-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  useUiStateStore.setState({ sidebarOpen: true });
});

test("renders the published Tasks sidebar and shares its live callbacks", async () => {
  const actions: string[] = [];
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (!globalThis.window) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
    });
  }

  function Harness() {
    const preview = useAppNavigationSidebarPreview();
    const [section, setSection] = useState<TaskSection>("today");
    const registration = useMemo<TasksSidebarRegistration>(() => ({
      section,
      onSectionChange: (value) => { actions.push(`section:${value}`); setSection(value); },
      lists: [{ id: "list-one", name: "Launch", marker: "#", version: 3 }],
      selectedListId: null,
      onSelectList: (id) => actions.push(`list:${id}`),
      onCreateList: () => actions.push("create"),
      onArchiveList: (id, version) => actions.push(`archive:${id}:${version}`),
    }), [section]);
    usePublishTasksSidebar(registration);
    return <button type="button" data-testid="open-tasks-preview" onClick={() => preview.onTriggerChange("tasks", true)}>Open</button>;
  }

  useUiStateStore.setState({ sidebarOpen: false });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={["/tasks"]}>
        <AppNavigationSidebarPreviewProvider><Harness /></AppNavigationSidebarPreviewProvider>
      </MemoryRouter>,
    );
  });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "open-tasks-preview" }).props.onClick(); });
    const host = renderer!.root.findByProps({ "data-app-navigation-sidebar-preview": "tasks" });
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar-preview" });
    expect(sidebar.props.className).toContain("h-full");
    expect(sidebar.props.className).toContain("rounded-[18px] border border-dls-border");
    expect(renderer!.root.findByProps({ "aria-label": t("tasks.archive_list") }).props.className).toContain("group-has-[:focus-visible]:visible");

    expect(sidebar.findAllByType("input")).toHaveLength(0);
    expect(sidebar.findAll((node) => node.props.children === t("tasks.inbox"))).toHaveLength(0);
    expect(sidebar.findAll((node) => node.props.children === t("tasks.trash"))).toHaveLength(0);
    expect(sidebar.findAll((node) => node.props.children === t("tasks.archived_lists"))).toHaveLength(0);
    const primary = sidebar.findAllByProps({ "aria-label": t("tasks.navigation") }).find((node) => node.type === "nav")!;
    expect(primary.findAllByType("button").map((button) => button.props.children[1])).toEqual([
      t("tasks.today"), t("tasks.assigned_to_me"), t("tasks.following"), t("tasks.activity"),
    ]);
    const quickAccess = sidebar.findByProps({ "aria-expanded": true });
    expect(quickAccess.props.children[0].props.children).toBe(t("tasks.quick_access"));
    const quickAccessNav = sidebar.findByProps({ "aria-label": t("tasks.quick_access") });
    expect(quickAccessNav.findAllByType("button").map((button) => button.props.children[1])).toEqual([
      t("tasks.all"), t("tasks.created_by_me"), t("tasks.assigned_by_me"), t("tasks.completed"),
    ]);
    const delegated = quickAccessNav.findAllByType("button")[2]!;
    await act(async () => { delegated.props.onClick(); });
    await act(async () => { quickAccess.props.onClick(); });
    expect(sidebar.findByProps({ "aria-expanded": false })).toBeDefined();
    expect(sidebar.findAllByProps({ "aria-label": t("tasks.quick_access") })).toHaveLength(0);
    const list = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Launch"))!;
    await act(async () => { list.props.onClick(); });
    await act(async () => { sidebar.findByProps({ "aria-label": t("tasks.create_list") }).props.onClick(); });
    await act(async () => { sidebar.findByProps({ "aria-label": t("tasks.archive_list") }).props.onClick(); });
    expect(actions).toEqual(["section:delegated", "list:list-one", "create", "archive:list-one:3"]);

    await act(async () => {
      host.props.onMouseLeave();
      host.props.onMouseEnter();
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    expect(renderer!.root.findByProps({ "data-app-navigation-sidebar-preview": "tasks" })).toBeDefined();
    await act(async () => {
      const focusedHost = renderer!.root.findByProps({ "data-app-navigation-sidebar-preview": "tasks" });
      focusedHost.props.onFocus();
      focusedHost.props.onMouseLeave();
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    expect(renderer!.root.findByProps({ "data-app-navigation-sidebar-preview": "tasks" })).toBeDefined();
    await act(async () => {
      renderer!.root.findByProps({ "data-app-navigation-sidebar-preview": "tasks" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    expect(renderer!.root.findAllByProps({ "data-app-navigation-sidebar-preview": "tasks" })).toHaveLength(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
