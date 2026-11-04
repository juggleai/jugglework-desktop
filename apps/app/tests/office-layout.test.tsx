import * as React from "react";
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OfficeEditor } from "../src/react-app/domains/session/office/office-editor";

test.each([false, true])("菜单交接先显示已加载快照，原生恢复完成才移除，关闭菜单使迟到截图失效（图片已缓存=%s）", async (cached) => {
  const descriptors = new Map(["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  class Overlay { offsetParent = {}; }
  let menuOpen = false;
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible", hasFocus: () => true,
    querySelectorAll: () => menuOpen ? [new Overlay()] : [],
  });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const hidden: unknown[] = [];
  const shown: unknown[] = [];
  let capture!: (image: string) => void;
  let restore!: () => void;
  let waitForShow = false;
  let changed: ((document: any) => void) | undefined;
  const image = "data:image/png;base64,menu-cover";
  const native = {
    async show(input: unknown) {
      shown.push(input);
      if (waitForShow) await new Promise<void>((resolve) => { restore = resolve; });
      return { here: true };
    },
    async snapshot() { return new Promise<string>((resolve) => { capture = resolve; }); },
    async hide(...input: unknown[]) { hidden.push(input); return image; },
    onDocumentChanged(listener: (document: any) => void) { changed = listener; return () => { changed = undefined; }; },
  };
  const host = Object.assign(new EventTarget(), {
    __JUGGLEWORK_ELECTRON__: { office: native },
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: host });
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Overlay });
  const document = { documentId: "od_menu", pageId: "page_menu", workspaceId: "ws", ownerSessionId: "ses_menu", relativePath: "数据.xlsx", name: "数据.xlsx", state: "ready", dirty: true, engineFileId: "model_menu", previewUrl: "http://127.0.0.1:39999/static/sheet/pc.html" };
  const client = { baseUrl: "http://fixture-menu", officeCapabilities: async () => ({ available: true, formats: ["xlsx"] }), openOfficeDocument: async () => ({ document }), getOfficeDocument: async () => ({ document }) };
  const query = new QueryClient();
  query.setQueryData(["office-capabilities", client.baseUrl, "ws"], { available: true, formats: ["xlsx"] });
  const element = { isConnected: true, getBoundingClientRect: () => ({ x: 100, y: 86, width: 800, height: 600 }) };
  const loadedImage = { complete: cached, naturalWidth: cached ? 800 : 0 };
  const tick = async () => act(async () => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  });
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(<QueryClientProvider client={query}><OfficeEditor client={client as any} workspaceId="ws" sessionId="ses_menu" path="数据.xlsx" hideHeader /></QueryClientProvider>, {
        createNodeMock: (node) => node.type === "img" ? loadedImage : node.props.className === "relative min-h-0 flex-1" ? element : null,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(shown.length).toBeGreaterThan(0);
    menuOpen = true;
    await tick();
    expect(hidden).toEqual([]);
    await act(async () => { capture(image); });
    expect(view!.root.findByType("img").props.src).toBe(image);
    if (!cached) {
      expect(hidden).toEqual([]);
      await act(async () => { view!.root.findByType("img").props.onLoad(); });
    }
    expect(hidden).toEqual([]);
    await tick();
    expect(hidden).toEqual([]);
    await tick();
    expect(hidden).toEqual([["od_menu", true]]);
    // 状态通知不能撤掉菜单下面的替代画面。
    await act(async () => { changed?.({ ...document, dirty: false }); });
    expect(view!.root.findByType("img").props.src).toBe(image);
    menuOpen = false;
    waitForShow = true;
    await tick();
    expect(view!.root.findByType("img").props.src).toBe(image);
    await act(async () => { restore(); });
    expect(view!.root.findAllByType("img")).toHaveLength(0);
    waitForShow = false;
    menuOpen = true;
    await tick();
    const staleCapture = capture;
    menuOpen = false;
    await tick();
    await act(async () => { staleCapture(image); });
    expect(hidden).toEqual([["od_menu", true]]);
    expect(view!.root.findAllByType("img")).toHaveLength(0);
    // 截图未返回时切到后台，必须立即隐藏，不能等图片或把焦点交回后台宿主。
    menuOpen = true;
    await tick();
    const backgroundCapture = capture;
    page.visibilityState = "hidden";
    await act(async () => { page.dispatchEvent(new Event("visibilitychange")); });
    expect(hidden.at(-1)).toEqual(["od_menu", false]);
    await act(async () => { backgroundCapture(image); });
    expect(view!.root.findAllByType("img")).toHaveLength(0);
  } finally {
    if (view) await act(async () => { view!.unmount(); });
    query.clear();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("宿主恢复后即使尺寸不变也重新确认区域，隐藏页面和卸载面板不显示原生视图", async () => {
  const descriptors = new Map(
    ["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const page = new EventTarget() as EventTarget & {
    visibilityState: string;
    hasFocus: () => boolean;
    querySelectorAll: () => never[];
  };
  page.visibilityState = "visible";
  page.hasFocus = () => true;
  page.querySelectorAll = () => [];
  const frames = new Map<number, FrameRequestCallback>();
  const layoutListeners = new Set<() => void>();
  const shown: unknown[] = [];
  const hidden: unknown[] = [];
  const native = {
    async show(input: unknown) {
      shown.push(input);
      return { here: true };
    },
    async hide(...input: unknown[]) {
      hidden.push(input);
    },
    onLayoutInvalidated(callback: () => void) {
      layoutListeners.add(callback);
      return () => {
        layoutListeners.delete(callback);
      };
    },
  };
  let sequence = 0;
  const host = Object.assign(new EventTarget(), {
    __JUGGLEWORK_ELECTRON__: { office: native },
    requestAnimationFrame(callback: FrameRequestCallback) {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: host,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: page,
  });
  const document = {
    documentId: "od_layout",
    workspaceId: "ws",
    ownerSessionId: "ses_layout",
    relativePath: "数据.xlsx",
    name: "数据.xlsx",
    state: "ready",
    dirty: true,
    engineFileId: "model_layout",
    previewUrl: "http://127.0.0.1:39999/static/sheet/pc.html",
  };
  const client = {
    baseUrl: "http://fixture",
    officeCapabilities: async () => ({ available: true, formats: ["xlsx"] }),
    openOfficeDocument: async () => ({ document }),
    getOfficeDocument: async () => ({ document }),
  };
  const query = new QueryClient();
  query.setQueryData(["office-capabilities", client.baseUrl, "ws"], {
    available: true,
    formats: ["xlsx"],
  });
  let width = 800;
  const element = {
    isConnected: true,
    getBoundingClientRect: () => ({ x: 100, y: 86, width, height: 600 }),
  };
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={query}>
          <OfficeEditor
            client={client as any}
            workspaceId="ws"
            sessionId="ses_layout"
            path="数据.xlsx"
            hideHeader
          />
        </QueryClientProvider>,
        {
          createNodeMock: (node) =>
            node.props.className === "relative min-h-0 flex-1" ? element : null,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(shown.length).toBeGreaterThan(0);
    width = 480;
    await act(async () => {
      const pending = [...frames.entries()]; frames.clear();
      for (const [, callback] of pending) callback(0);
    });
    expect(shown.at(-1)).toMatchObject({ bounds: { width: 480 } });
    expect(document.engineFileId).toBe("model_layout");
    const initial = shown.length;
    await act(async () => {
      for (const listener of layoutListeners) listener();
    });
    expect(shown).toHaveLength(initial + 1);
    page.visibilityState = "hidden";
    await act(async () => {
      page.dispatchEvent(new Event("visibilitychange"));
    });
    expect(hidden.at(-1)).toEqual(["od_layout", false]);
    expect(shown).toHaveLength(initial + 1);
    page.visibilityState = "visible";
    await act(async () => {
      page.dispatchEvent(new Event("visibilitychange"));
    });
    expect(shown).toHaveLength(initial + 2);
    element.isConnected = false;
    await act(async () => {
      host.dispatchEvent(new Event("pageshow"));
    });
    expect(shown).toHaveLength(initial + 2);
    await act(async () => {
      view!.unmount();
    });
    view = undefined;
    expect(hidden.at(-1)).toEqual(["od_layout"]);
    expect(layoutListeners.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(document.dirty).toBe(true);
  } finally {
    if (view)
      await act(async () => {
        view!.unmount();
      });
    query.clear();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
