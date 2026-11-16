/** @jsxImportSource react */
import { afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

import { setLocale } from "../src/i18n";

// Popover 走 portal；这里只验证选择逻辑，直接渲染触发器与内容。
mock.module("../src/components/ui/popover", () => ({
  Popover: ({ children }: { children: unknown }) => children,
  PopoverTrigger: ({ render }: { render: unknown }) => render,
  PopoverContent: ({ children }: { children: unknown }) => children,
}));

const { WorkspaceSelect } = await import("../src/react-app/domains/session/surface/composer/workspace-select");

afterEach(() => setLocale("en"));

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
}

const workspaces = [
  { id: "ws_office", label: "日常办公", remote: false },
  { id: "ws_project", label: "项目资料", remote: false },
  { id: "ws_remote", label: "团队空间", remote: true },
];

test("shows the selected workspace and switches only to a different one", () => {
  setLocale("zh");
  const onSelect = mock((_id: string) => {});
  let view: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    view = TestRenderer.create(<WorkspaceSelect workspaces={workspaces} selectedWorkspaceId="ws_office" onSelect={onSelect} />);
  });

  const trigger = view!.root.findByProps({ "data-testid": "session-home-workspace-select" });
  expect(textOf(trigger)).toContain("日常办公");

  const options = view!.root.findAllByProps({ "data-testid": "session-home-workspace-option" });
  expect(options.map((option) => option.props["aria-checked"])).toEqual([true, false, false]);

  act(() => options[0]!.props.onClick());
  expect(onSelect).not.toHaveBeenCalled();

  act(() => options[1]!.props.onClick());
  expect(onSelect).toHaveBeenCalledWith("ws_project");
});

test("falls back to the placeholder when no workspace is selected", () => {
  setLocale("zh");
  let view: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    view = TestRenderer.create(<WorkspaceSelect workspaces={workspaces} selectedWorkspaceId="missing" onSelect={() => {}} />);
  });
  const trigger = view!.root.findByProps({ "data-testid": "session-home-workspace-select" });
  expect(textOf(trigger)).toContain("选择工作空间");
});
