import * as React from "react";
import { expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const Item = ({ onClick, children }: React.PropsWithChildren<{ onClick?: () => void }>) => (
  <button onClick={onClick}>{children}</button>
);
mock.module("../src/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: Item,
}));

const { createOfficeFile } = await import(
  "../src/react-app/domains/session/files/office-create"
);
const { OfficeCreateItems } = await import(
  "../src/react-app/domains/session/files/office-create-items"
);

test("创建动作提供 Word 和 PowerPoint 两种有限类型", async () => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const kinds: string[] = [];
  let view: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<OfficeCreateItems onCreate={(kind) => kinds.push(kind)} />);
    });
    const buttons = view!.root.findAllByType("button");
    expect(buttons).toHaveLength(2);
    await act(async () => {
      buttons[0]!.props.onClick();
      buttons[1]!.props.onClick();
    });
    expect(kinds).toEqual(["docx", "pptx"]);
    await act(async () => view!.unmount());
  } finally {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test("取消创建不打开标签，成功创建 PPTX 才交给现有文件查看器", async () => {
  const opened: unknown[] = [];
  const calls: unknown[] = [];
  const bridge = {
    create: async (input: unknown) => {
      calls.push(input);
      return calls.length === 1 ? null : { path: "slides/季度复盘.pptx" };
    },
  };
  expect(await createOfficeFile(
    bridge as any,
    { workspaceId: "ws", sessionId: "ses", kind: "pptx" },
    (file) => opened.push(file),
  )).toBe(false);
  expect(opened).toEqual([]);
  expect(await createOfficeFile(
    bridge as any,
    { workspaceId: "ws", sessionId: "ses", kind: "pptx" },
    (file) => opened.push(file),
  )).toBe(true);
  expect(opened).toEqual([
    { path: "slides/季度复盘.pptx", name: "季度复盘.pptx" },
  ]);
  expect(calls).toEqual([
    { workspaceId: "ws", sessionId: "ses", kind: "pptx" },
    { workspaceId: "ws", sessionId: "ses", kind: "pptx" },
  ]);
});
