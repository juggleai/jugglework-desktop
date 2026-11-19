/** @jsxImportSource react */
import * as React from "react";
import { expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFilesPanelStore } from "../src/react-app/domains/session/files/files-panel-store";
import { t } from "../src/i18n";

// 仅替换需要 DOM 的编辑器叶子，FileViewer、加载、Markdown 和保存逻辑均使用真实实现。
mock.module("../src/react-app/domains/session/artifacts/artifact-text-editor", () => ({
  ArtifactTextEditor: (props: any) => <textarea value={props.value} onChange={(event: any) => props.onChange(event.target.value)} />,
}));
const { FileViewer } = await import("../src/react-app/domains/session/files/file-viewer");

test.each(["说明.md", "说明.txt", "说明.tsv"])("只读 %s 读取真实文本，忽略旧草稿且无编辑入口或快捷键写入", async (path) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const keys = new Set<(event: any) => void>();
  const content = "原件内容\t42\n";
  const draft = { content: "不应展示的旧草稿", baseUpdatedAt: 1 };
  const state = mock(async () => ({ workspaceId: "ws", path, draft: null, saved: null, external: false }));
  const update = mock(async () => { throw new Error("只读视图不应更新草稿"); });
  const save = mock(async () => { throw new Error("只读视图不应保存"); });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __JUGGLEWORK_ELECTRON__: { fileEditor: { state, update, save, onChanged: () => () => {} } },
    addEventListener: (name: string, handler: any) => { if (name === "keydown") keys.add(handler); },
    removeEventListener: (name: string, handler: any) => { if (name === "keydown") keys.delete(handler); },
  } });
  const download = mock(async () => ({ data: new TextEncoder().encode(content).buffer, contentType: "text/plain" }));
  const client = { downloadWorkspaceFile: download, statWorkspaceFile: async () => ({ updatedAt: 1, size: content.length }) };
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(<QueryClientProvider client={query}><FileViewer client={client as any} workspaceId="ws" sessionId="readonly" path={path} name={path} draft={draft} readOnly /></QueryClientProvider>);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(download).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(view!.toJSON())).toContain("原件内容");
    expect(JSON.stringify(view!.toJSON())).not.toContain(draft.content);
    for (const type of ["textarea", "input", "button"]) expect(view!.root.findAllByType(type)).toHaveLength(0);
    for (const metaKey of [true, false]) for (const handler of keys) handler({ key: "s", metaKey, ctrlKey: !metaKey, preventDefault() {} });
    expect(update).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  } finally {
    await act(async () => view?.unmount()); query.clear();
    useFilesPanelStore.getState().clearSession("readonly");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test("可编辑 Markdown 保留编辑和快捷键保存，切为只读后立即恢复原件预览", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const keys = new Set<(event: any) => void>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (name: string, handler: any) => { if (name === "keydown") keys.add(handler); },
    removeEventListener: (name: string, handler: any) => { if (name === "keydown") keys.delete(handler); },
  } });
  const write = mock(async () => ({ updatedAt: 2 }));
  const query = new QueryClient();
  query.setQueryData(["workspace-file", "ws", "editable.md"], { presentation: "markdown", text: "原件", bytes: new ArrayBuffer(0), updatedAt: 1, size: 6 });
  const render = (readOnly = false) => <QueryClientProvider client={query}><FileViewer client={{ writeWorkspaceBinaryFile: write } as any} workspaceId="ws" sessionId="editable" path="editable.md" name="editable.md" draft={undefined} readOnly={readOnly} /></QueryClientProvider>;
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(render()); });
    const edit = () => view!.root.findAllByType("button").find(button => button.props["aria-label"] === t("common.edit"))!;
    await act(async () => { edit().props.onClick(); });
    await act(async () => { view!.root.findByType("textarea").props.onChange({ target: { value: "已保存" } }); });
    await act(async () => { for (const handler of keys) handler({ key: "s", metaKey: true, preventDefault() {} }); });
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => { edit().props.onClick(); });
    await act(async () => { view!.root.findByType("textarea").props.onChange({ target: { value: "未保存" } }); });
    await act(async () => { view!.update(render(true)); });
    expect(view!.root.findAllByType("textarea")).toHaveLength(0);
    expect(view!.root.findAllByType("button")).toHaveLength(0);
    expect(JSON.stringify(view!.toJSON())).toContain("已保存");
    expect(JSON.stringify(view!.toJSON())).not.toContain("未保存");
    for (const handler of keys) handler({ key: "s", ctrlKey: true, preventDefault() {} });
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => view?.unmount()); query.clear();
    useFilesPanelStore.getState().clearSession("editable");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});
