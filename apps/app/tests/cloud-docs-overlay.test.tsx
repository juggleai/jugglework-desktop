/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";
let overlay = false;
let includesRailTooltips = false;
mock.module("../src/react-app/domains/session/panel/utils", () => ({ hasNativeBrowserOccluder: (include: boolean) => { includesRailTooltips = include; return overlay; } }));
const { useCloudDocsBounds } = await import("../src/react-app/domains/cloud-docs/use-cloud-docs-bounds");
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalGetComputedStyle = globalThis.getComputedStyle;
afterAll(() => { mock.restore(); globalThis.getComputedStyle = originalGetComputedStyle; });

test("浮窗期间先保留文档画面再隐藏原生页；关闭后恢复，切换页面不能被迟到截图覆盖", async () => {
  const bounds: Array<{ visible: boolean; borderRadius: number }> = [];
  globalThis.getComputedStyle = (() => ({ borderTopLeftRadius: "18px" })) as typeof getComputedStyle;
  let resolveImage!: (value: string | null) => void;
  let captures = 0;
  (globalThis as any).window = { __JUGGLEWORK_ELECTRON__: { cloudDocs: {
    snapshot: () => { captures++; return new Promise<string | null>(resolve => { resolveImage = resolve; }); },
    setBounds: (value: { visible: boolean; borderRadius: number }) => bounds.push(value),
  } } };
  (globalThis as any).document = { hidden: false };
  let result!: ReturnType<typeof useCloudDocsBounds>;
  function Host() {
    const host = React.useRef({ getBoundingClientRect: () => ({ x: 60, y: 50, width: 800, height: 700 }) } as HTMLDivElement);
    result = useCloudDocsBounds(host);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); });
  await act(async () => result.sync("home", true));
  expect(bounds.at(-1)?.visible).toBe(true);
  expect(bounds.at(-1)?.borderRadius).toBe(18);
  expect(includesRailTooltips).toBe(true);
  overlay = true;
  await act(async () => { result.sync("home", true); result.sync("home", true); });
  expect(captures).toBe(1);
  expect(bounds.at(-1)?.visible).toBe(true);
  await act(async () => { resolveImage("data:image/png;base64,screen"); });
  expect(result.snapshot).toBe("data:image/png;base64,screen");
  await act(async () => result.loaded());
  expect(bounds.at(-1)?.visible).toBe(false);
  overlay = false;
  await act(async () => result.sync("home", true));
  expect(result.snapshot).toBeNull();
  expect(bounds.at(-1)?.visible).toBe(true);
  overlay = true;
  await act(async () => result.sync("home", true));
  await act(async () => result.sync("home", true, false));
  await act(async () => resolveImage("late"));
  expect(result.snapshot).toBeNull();
  expect(bounds.at(-1)?.visible).toBe(false);
  await act(async () => renderer.unmount());
});

test("导航提示在首次就绪时已打开，也先呈现文档再截取画面", async () => {
  overlay = true;
  let visible = false;
  (globalThis as any).window = { __JUGGLEWORK_ELECTRON__: { cloudDocs: {
    setBounds: (value: { visible: boolean }) => { visible = value.visible; },
    snapshot: async () => { expect(visible).toBe(true); return "data:image/png;base64,first"; },
  } } };
  let result!: ReturnType<typeof useCloudDocsBounds>;
  function Host() {
    const host = React.useRef({ getBoundingClientRect: () => ({ x: 60, y: 50, width: 800, height: 700 }) } as HTMLDivElement);
    result = useCloudDocsBounds(host);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); });
  await act(async () => result.sync("first", true));
  expect(result.snapshot).toBe("data:image/png;base64,first");
  await act(async () => result.loaded());
  expect(visible).toBe(false);
  overlay = false;
  await act(async () => result.sync("first", true));
  expect(visible).toBe(true);
  await act(async () => renderer.unmount());
});
