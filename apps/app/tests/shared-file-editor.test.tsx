import * as React from "react";
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  FileEditorState,
  FileEditorBridge,
} from "@jugglework/types/file-editor";
import { FileViewer } from "../src/react-app/domains/session/files/file-viewer";
import { useFilesPanelStore } from "../src/react-app/domains/session/files/files-panel-store";
import { t } from "../src/i18n";

test("文件浏览器和侧栏使用同一编辑组件，草稿、保存内容及状态在两个视图同步", async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const callbacks = new Set<(state: FileEditorState) => void>();
  const state: FileEditorState = {
    workspaceId: "ws",
    path: "客户.tsv",
    draft: null,
    saved: null,
    external: false,
  };
  const emit = () => {
    for (const callback of callbacks) callback(structuredClone(state));
  };
  const bridge = {
    state: async () => structuredClone(state),
    onChanged: (callback: (state: FileEditorState) => void) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    update: async (_target: unknown, draft: FileEditorState["draft"]) => {
      state.draft = draft;
      emit();
      return structuredClone(state);
    },
    save: async () => {
      state.saved = { content: state.draft!.content, updatedAt: 2, size: 35 };
      state.draft = null;
      emit();
      return structuredClone(state);
    },
  } as FileEditorBridge;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __JUGGLEWORK_ELECTRON__: { fileEditor: bridge },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const queries = [new QueryClient(), new QueryClient()];
  const views: ReactTestRenderer[] = [];
  for (const query of queries)
    query.setQueryData(["workspace-file", "ws", "客户.tsv"], {
      presentation: "sheet",
      text: "姓名\t营收\n张伟\t10\n",
      bytes: new ArrayBuffer(0),
      updatedAt: 1,
      contentType: "text/tab-separated-values",
      size: 30,
    });
  try {
    await act(async () => {
      for (const [index, query] of queries.entries())
        views.push(
          create(
            <QueryClientProvider client={query}>
              <FileViewer
                client={{} as any}
                workspaceId="ws"
                sessionId={`view-${index}`}
                path="客户.tsv"
                name="客户.tsv"
                draft={undefined}
              />
            </QueryClientProvider>,
          ),
        );
    });
    for (const view of views) expect(view.root.findAllByType("input")).toHaveLength(4);
    const revenue = (view: ReactTestRenderer) =>
      view.root
        .findAllByType("input")
        .find((input) => input.props["aria-label"] === "B2")!;
    await act(async () => {
      revenue(views[0]!).props.onChange({ target: { value: "20" } });
    });
    expect(revenue(views[1]!).props.value).toBe("20");
    expect(
      useFilesPanelStore.getState().sessions["view-1"]?.drafts["客户.tsv"]
        ?.content,
    ).toContain("张伟\t20");
    await act(async () => {
      views[1]!.root
        .findAllByType("button")
        .find((button) => button.props.children === t("session_files.save"))!
        .props.onClick();
    });
    expect(state.draft).toBeNull();
    for (const query of queries)
      expect(
        query.getQueryData<any>(["workspace-file", "ws", "客户.tsv"])?.text,
      ).toBe("姓名\t营收\n张伟\t20\n");
    expect(
      useFilesPanelStore.getState().sessions["view-0"]?.drafts["客户.tsv"],
    ).toBeUndefined();
    expect(
      useFilesPanelStore.getState().sessions["view-1"]?.drafts["客户.tsv"],
    ).toBeUndefined();
  } finally {
    await act(async () => {
      for (const view of views) view.unmount();
    });
    for (const query of queries) query.clear();
    for (const session of ["view-0", "view-1"])
      useFilesPanelStore.getState().clearSession(session);
    if (before) Object.defineProperty(globalThis, "window", before);
    else Reflect.deleteProperty(globalThis, "window");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});
