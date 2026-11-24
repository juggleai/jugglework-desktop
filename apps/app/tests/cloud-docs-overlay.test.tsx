/** @jsxImportSource react */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { useCloudDocsBounds } from "../src/react-app/domains/cloud-docs/use-cloud-docs-bounds";
import { hasCloudDocsOccluder } from "../src/react-app/domains/cloud-docs/cloud-docs-visibility";
import { CloudDocsPlaceholder } from "../src/react-app/domains/cloud-docs/cloud-docs-placeholder";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originals = { window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
afterAll(() => { Object.assign(globalThis, originals); mock.restore(); });
const rect = (x = 60, y = 50, width = 800, height = 700) => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }) as DOMRect;
class Overlay {
  hidden = false;
  dataset: { appRailTooltip?: string } = {};
  attributes = new Map<string, string>();
  style = { display: "block", visibility: "visible" };
  parentElement = { style: { opacity: "" } };
  constructor(public role: string, public box = rect(), public modal = false) {}
  getAttribute(name: string) { return name === "aria-modal" && this.modal ? "true" : this.attributes.get(name) ?? null; }
  matches(selector: string) { return selector.includes(this.role); }
  getClientRects() { return this.hidden ? [] : [this.box]; }
  getBoundingClientRect() { return this.box; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
}
let overlays: Overlay[] = [];
let frames: FrameRequestCallback[] = [];
let hostVisible = true;
beforeEach(() => {
  overlays = []; frames = []; hostVisible = true;
  (globalThis as any).document = {
    hidden: false, documentElement: new Overlay("root"),
    querySelectorAll: (selector: string) => overlays.filter(node => selector.includes(node.role)),
  };
  globalThis.getComputedStyle = ((node: Overlay) => node.style ?? { display: "block", visibility: hostVisible ? "visible" : "hidden", borderTopLeftRadius: "18px" }) as typeof getComputedStyle;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
});
async function fixture(mirrorRailHints = false) {
  const bounds = mock((_value: { instanceId: string; visible: boolean; borderRadius: number }) => {});
  const captures: Array<{ resolve: (image: string | null) => void; reject: (error: Error) => void }> = [];
  const status = mock(async (_id: string) => ({ ready: true }));
  const menuAction = mock(() => {});
  const restored = mock((_id: string) => {});
  const railHint = mock((_input: { instanceId: string; hint: { label: string; centerY: number; dark: boolean } | null }) => {});
  (globalThis as any).window = { __JUGGLEWORK_ELECTRON__: { cloudDocs: {
    setBounds: bounds, status,
    setRailHint: railHint,
    snapshot: () => new Promise<string | null>((resolve, reject) => captures.push({ resolve, reject })),
  } } };
  let result!: ReturnType<typeof useCloudDocsBounds>;
  function Host() {
    const host = React.useRef({ getBoundingClientRect: () => rect() } as HTMLDivElement);
    result = useCloudDocsBounds(host, restored, { mirrorRailHints });
    return <div>{overlays.length > 0 && <div role="menu"><button role="menuitem" onClick={menuAction}>Menu action</button></div>}{result.snapshot && <img src={result.snapshot} onLoad={result.loaded} onError={result.failed} />}{result.fallback && <CloudDocsPlaceholder />}</div>;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); });
  return { get result() { return result; }, renderer, bounds, captures, status, menuAction, restored, railHint,
    sync: async (active = true, id = "home") => { await act(async () => result.sync(id, true, active)); },
    paint: async () => { await act(async () => { for (const frame of frames.splice(0)) frame(0); }); },
    close: async () => { await act(async () => renderer.unmount()); },
  };
}

test("普通 tooltip 不截图／隐藏，非相交 menu 不遮挡；modal 与实际 sidebar preview 保留遮挡", async () => {
  const f = await fixture();
  overlays = [new Overlay('role="tooltip"'), new Overlay('role="menu"', rect(0, 0, 40, 40))];
  await f.sync();
  expect(f.captures).toHaveLength(0);
  expect(f.bounds.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true, borderRadius: 18 });
  for (const role of ['role="menu"', 'data-app-navigation-sidebar-preview', 'data-session-list-preview="true"']) {
    overlays = [new Overlay(role)];
    expect(hasCloudDocsOccluder(rect())).toBe(true);
  }
  overlays = [new Overlay('role="dialog"', rect(0, 0, 40, 40), true)];
  expect(hasCloudDocsOccluder(rect())).toBe(true);
  overlays[0].style.visibility = "hidden";
  expect(hasCloudDocsOccluder(rect())).toBe(false);
  await f.close();
});

test("overlapping Rail hints display on the native layer without a capture or visibility change", async () => {
  const f = await fixture(true);
  await f.sync();
  expect(document.documentElement.getAttribute("data-cloud-docs-rail-guard")).toBe("home");
  const hint = new Overlay("[data-app-rail-tooltip][data-open]", rect(48, 80, 92, 24));
  hint.dataset.appRailTooltip = "Calendar";
  hint.parentElement.style.opacity = "0";
  overlays = [hint];
  await f.sync();
  expect(f.railHint).not.toHaveBeenCalled();
  expect(hint.attributes.has("data-cloud-docs-host-hint")).toBe(false);
  hint.parentElement.style.opacity = "";
  await f.sync();
  await f.sync();
  expect(f.railHint.mock.calls).toEqual([[{
    instanceId: "home",
    hint: { label: "Calendar", centerY: 42, dark: false },
  }]]);
  expect(hint.attributes.has("data-cloud-docs-host-hint")).toBe(false);
  expect(f.captures).toHaveLength(0);
  expect(f.bounds.mock.calls.every(([bounds]) => bounds.visible)).toBe(true);

  hint.box = rect(0, 0, 48, 40);
  await f.sync();
  expect(f.railHint.mock.calls.at(-1)?.[0]).toEqual({ instanceId: "home", hint: null });
  expect(hint.attributes.has("data-cloud-docs-host-hint")).toBe(true);
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  await f.close();
  expect(document.documentElement.getAttribute("data-cloud-docs-rail-guard")).toBeNull();
  expect(hint.attributes.has("data-cloud-docs-host-hint")).toBe(false);
});

test("真实 overlay 等截图加载才隐藏，关闭后保留截图直到 IPC 屏障与下一帧", async () => {
  const f = await fixture();
  await f.sync();
  overlays = [new Overlay('role="menu"')];
  await f.sync(); await f.sync();
  expect(f.captures).toHaveLength(1);
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  await act(async () => f.captures[0].resolve("screen"));
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  await act(async () => f.renderer.root.findByType("img").props.onLoad());
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(false);
  expect(f.renderer.root.findByProps({ role: "menu" })).toBeDefined();
  overlays = [];
  let acknowledge!: () => void;
  f.status.mockImplementation(() => new Promise(resolve => { acknowledge = () => resolve({ ready: true }); }));
  await f.sync();
  expect(f.result.snapshot).toBe("screen");
  expect(frames).toHaveLength(0);
  await act(async () => acknowledge());
  expect(f.result.snapshot).toBe("screen");
  await f.paint();
  expect(f.result.snapshot).toBeNull();
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  await f.close();
});

test("旧实例截图 reject 与卸载后的迟到结果不能隐藏后来激活的原生来源", async () => {
  const f = await fixture();
  overlays = [new Overlay('role="menu"')];
  await f.sync(true, "old-instance");
  const old = f.captures[0];
  await f.sync(false, "old-instance");
  await f.sync(true, "new-instance");
  await act(async () => old.reject(new Error("late failure")));
  expect(f.bounds.mock.calls.at(-1)?.[0]).toMatchObject({ instanceId: "new-instance", visible: true });
  expect(f.result.snapshot).toBeNull();
  const count = f.bounds.mock.calls.length;
  await f.close();
  await act(async () => f.captures.at(-1)!.resolve("after unmount"));
  expect(f.bounds.mock.calls).toHaveLength(count);
});

test("截图 null／reject 提交明确占位，跨过完整绘制机会再 hide，恢复后清理占位；迟到截图与旧 onLoad 不影响重新激活来源", async () => {
  const f = await fixture();
  for (const fail of [false, true]) {
    overlays = [new Overlay('role="menu"')];
    await f.sync();
    const capture = f.captures.at(-1)!;
    await act(async () => { if (fail) capture.reject(new Error("capture failed")); else capture.resolve(null); });
    await f.sync();
    expect(f.result.snapshot).toBeNull();
    expect(f.result.fallback).toBe(true);
    expect(f.renderer.root.findByProps({ "data-cloud-docs-placeholder": true }).props.className).toContain("bg-background");
    expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
    await f.paint();
    expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
    await f.paint();
    expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(false);
    overlays = []; await f.sync();
    expect(f.result.fallback).toBe(true);
    await f.paint();
    expect(f.result.fallback).toBe(false);
  }
  overlays = [new Overlay('role="menu"')];
  await f.sync();
  const late = f.captures.at(-1)!;
  await f.sync(false); await f.sync(true);
  await act(async () => late.resolve("late"));
  expect(f.result.snapshot).toBeNull();
  await act(async () => f.captures.at(-1)!.resolve("current"));
  const oldLoad = f.renderer.root.findByType("img").props.onLoad;
  await f.sync(false); await f.sync(true);
  await act(async () => oldLoad());
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  await f.close();
});

test("占位等待绘制期间切换来源，旧绘制回调不能隐藏重新激活的来源；坏图也进入明确占位", async () => {
  const f = await fixture();
  overlays = [new Overlay('role="menu"')];
  await f.sync();
  await act(async () => f.captures[0].resolve(null));
  await f.sync(false); await f.sync(true);
  await f.paint(); await f.paint();
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  expect(f.result.fallback).toBe(false);
  await act(async () => f.captures.at(-1)!.resolve("broken-image"));
  await act(async () => f.renderer.root.findByType("img").props.onError());
  expect(f.result.fallback).toBe(true);
  await f.paint(); await f.paint();
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(false);
  await f.close();
});

test("隐藏 retained 宿主不能重新 claim 原生页，过期恢复帧不能清除重新打开浮层的截图", async () => {
  const f = await fixture();
  overlays = [new Overlay('role="menu"')]; await f.sync();
  await act(async () => f.captures[0].resolve("old"));
  await act(async () => f.result.loaded());
  overlays = []; await f.sync();
  overlays = [new Overlay('role="menu"')]; await f.sync();
  expect(f.captures).toHaveLength(1);
  expect(f.result.snapshot).toBe("old");
  await f.paint();
  expect(f.result.snapshot).toBe("old");
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(false);
  hostVisible = false;
  await f.sync();
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(false);
  expect(f.result.snapshot).toBeNull();
  await f.close();
});

test("浮层在图片 onLoad 前关闭，恢复中 onLoad 后于 RAF 前重开仍立即 hide 且复用 loaded 截图", async () => {
  const f = await fixture();
  overlays = [new Overlay('role="menu"')];
  await f.sync();
  await act(async () => f.captures[0].resolve("screen"));
  const load = f.renderer.root.findByType("img").props.onLoad;
  overlays = []; await f.sync();
  const calls = f.bounds.mock.calls.length;
  await act(async () => load());
  expect(f.bounds.mock.calls).toHaveLength(calls);
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  overlays = [new Overlay('role="menu"')]; await f.sync();
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(false);
  expect(f.captures).toHaveLength(1);
  await f.paint();
  expect(f.result.snapshot).toBe("screen");
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(false);
  await f.close();
});

test("只有 native 从遮挡或 surface 隐藏恢复通知 consumer，预热及重复 bounds 不重复通知", async () => {
  const f = await fixture();
  await f.sync(); await f.sync();
  expect(f.restored).not.toHaveBeenCalled();
  overlays = [new Overlay('role="menu"')]; await f.sync();
  await act(async () => f.captures[0].resolve("screen"));
  expect(f.restored).not.toHaveBeenCalled();
  await act(async () => f.result.loaded());
  overlays = []; await f.sync(); await f.sync();
  expect(f.restored).toHaveBeenCalledTimes(1);
  await f.paint();
  await f.sync(false); await f.sync(false);
  expect(f.restored).toHaveBeenCalledTimes(1);
  await f.sync(); await f.sync();
  expect(f.restored).toHaveBeenCalledTimes(2);
  expect(f.restored).toHaveBeenLastCalledWith("home");
  await f.close();
});

test("close-before-decode → restoring 中 onError → RAF 前重开：坏图转占位，绘制后才 hide，旧 RAF／图片事件均失效", async () => {
  const f = await fixture();
  overlays = [new Overlay('role="menu"')]; await f.sync();
  await act(async () => f.captures[0].resolve("bad-image"));
  const { onLoad: oldLoad, onError: oldError } = f.renderer.root.findByType("img").props;
  overlays = []; await f.sync();
  expect(frames).toHaveLength(1);
  const calls = f.bounds.mock.calls.length;
  await act(async () => oldError());
  expect(f.bounds.mock.calls).toHaveLength(calls);
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  overlays = [new Overlay('role="menu"')]; await f.sync();
  expect(f.result.snapshot).toBeNull();
  expect(f.result.fallback).toBe(true);
  expect(f.renderer.root.findAllByType("img")).toHaveLength(0);
  expect(f.captures).toHaveLength(1);
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  await act(async () => { oldLoad(); oldError(); });
  await f.paint(); // 旧 restore RAF + fallback 第一帧，尚不能 hide。
  expect(f.result.fallback).toBe(true);
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  await f.paint();
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(false);
  overlays = []; await f.sync(); await f.paint();
  expect(f.result.fallback).toBe(false);
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  await f.close();
});

test("restoring 中 onError 后不重开，原恢复 RAF 仍清理坏图；换实例后旧 onError 不影响新截图", async () => {
  const f = await fixture();
  overlays = [new Overlay('role="menu"')]; await f.sync();
  await act(async () => f.captures[0].resolve("bad-image"));
  const oldError = f.renderer.root.findByType("img").props.onError;
  overlays = []; await f.sync();
  await act(async () => oldError());
  await f.paint();
  expect(f.result.snapshot).toBeNull();
  expect(f.result.fallback).toBe(false);
  expect(f.bounds.mock.calls.at(-1)?.[0].visible).toBe(true);
  overlays = [new Overlay('role="menu"')]; await f.sync(true, "new");
  await act(async () => f.captures.at(-1)!.resolve("new-image"));
  await act(async () => oldError());
  expect(f.result.snapshot).toBe("new-image");
  expect(f.result.fallback).toBe(false);
  expect(f.bounds.mock.calls.at(-1)?.[0]).toMatchObject({ instanceId: "new", visible: true });
  await f.close();
});
