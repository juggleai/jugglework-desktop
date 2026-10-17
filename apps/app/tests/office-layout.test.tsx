import * as React from "react";
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OfficeEditor } from "../src/react-app/domains/session/office/office-editor";

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
  const element = {
    isConnected: true,
    getBoundingClientRect: () => ({ x: 100, y: 86, width: 800, height: 600 }),
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
