/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originals = Object.fromEntries(["window", "document", "localStorage", "getComputedStyle", "CSS", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"].map(key => [key, (globalThis as any)[key]]));
afterAll(() => { Object.assign(globalThis, originals); mock.restore(); });
const storage = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
const hostWindow = new EventTarget() as any;
const hostDocument = new EventTarget() as any;
let occluded = false;
const box = { x: 0, y: 0, width: 600, height: 500, left: 0, top: 0, right: 600, bottom: 500 };
hostDocument.body = {};
hostDocument.documentElement = { lang: "en" };
hostDocument.querySelectorAll = () => occluded ? [{ hidden: false, getClientRects: () => [box], getBoundingClientRect: () => box, getAttribute: () => null, matches: () => false }] : [];
(globalThis as any).window = hostWindow;
(globalThis as any).document = hostDocument;
(globalThis as any).getComputedStyle = () => ({ display: "block", visibility: "visible", fontFamily: "sans-serif", borderTopLeftRadius: "0", getPropertyValue: () => "#fff" });
(globalThis as any).CSS = { supports: () => true };
const resizes = new Set<() => void>(), mutations = new Set<() => void>();
(globalThis as any).ResizeObserver = class {
  constructor(private callback: () => void) {}
  observe() { resizes.add(this.callback); }
  disconnect() { resizes.delete(this.callback); }
};
(globalThis as any).MutationObserver = class {
  constructor(private callback: () => void) {}
  observe(target: unknown) { if (target === hostDocument.body) mutations.add(this.callback); }
  disconnect() { mutations.delete(this.callback); }
};
let frames: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
globalThis.cancelAnimationFrame = () => {};
const actualDen = await import("../src/app/lib/den.ts?panel-restoration-real");
mock.module("../src/app/lib/den", () => ({ ...actualDen,
  readDenSettings: () => ({ baseUrl: "https://source.test", activeOrgId: "org", authToken: "fixture" }),
  readDenUserId: () => "user",
  createDenClient: () => ({ launchCloudDocs: async (input: any) => ({ tenantId: "org", presentation: input.presentation, bootstrapUrl: "https://docs.test/api/jw/session/bootstrap", launchGrant: "fixture" }) }),
}));
mock.module("../src/react-app/domains/cloud-docs/product-view", () => ({ rememberCloudDocsOrigin() {} }));
mock.module("../src/react-app/domains/session/files/office-file-switch", () => ({ commitOfficeFileSwitch: (_session: string, _path: string, commit: () => void) => commit() }));
const { CloudDocPanel } = await import("../src/react-app/domains/cloud-docs/cloud-doc-panel");
const { openCloudDocTab } = await import("../src/app/lib/cloud-doc-tabs");
const { useFilesPanelStore } = await import("../src/react-app/domains/session/files/files-panel-store");

test("实际 bounds hook + panel：menu hidden 拒绝自动收起，恢复重读后仅重试一次；surface 恢复也能重试", async () => {
  const sessionId = "panel-restoration";
  const states = new Set<(value: any) => void>(), layouts = new Set<(value: any) => void>();
  let id = "", nativeVisible = false, focusCount = 0;
  const accepted: string[] = [];
  const command = mock((input: { instanceId: string; action: string }) => {
    // 与 Main 一致：request-state 可在 hidden 时返回真实 leftOpen；toggle 不交付也不聚焦。
    if (input.action === "request-state") return;
    if (!nativeVisible) return;
    accepted.push(input.action); focusCount++;
  });
  const snapshot = mock(async () => "screen");
  hostWindow.__JUGGLEWORK_ELECTRON__ = { cloudDocs: {
    open: async (input: { instanceId: string }) => { id = input.instanceId; for (const fn of states) fn({ instanceId: id, status: "ready" }); },
    close: async () => ({ closed: true }),
    setBounds: (input: { visible: boolean }) => { nativeVisible = input.visible; },
    status: async () => ({ ready: true }), snapshot,
    onState: (fn: (value: any) => void) => { states.add(fn); return () => states.delete(fn); },
    onLayout: (fn: (value: any) => void) => { layouts.add(fn); return () => layouts.delete(fn); },
    onAiReference: () => () => {}, setAppearance() {}, highlightBlocks() {}, layoutCommand: command,
  } };
  openCloudDocTab(sessionId, { tenantId: "org", workspaceId: "ws", docId: "doc", title: "Doc" });
  let renderer!: ReturnType<typeof create>;
  const layout = async (leftOpen: boolean) => act(async () => { for (const fn of layouts) fn({ instanceId: id, layout: { leftOpen, leftWidth: 248, rightOpen: false } }); });
  const mutate = async () => act(async () => { for (const fn of mutations) fn(); });
  const paint = async () => act(async () => { for (const fn of frames.splice(0)) fn(0); });
  const toggles = () => command.mock.calls.filter(([input]) => input.action === "toggle-left").length;
  await act(async () => { renderer = create(<CloudDocPanel sessionId={sessionId} />, { createNodeMock: () => ({ clientWidth: 600, getBoundingClientRect: () => box }) }); });
  try {
    expect(nativeVisible).toBe(true);
    occluded = true; await mutate();
    await act(async () => renderer.root.findByType("img").props.onLoad());
    expect(nativeVisible).toBe(false);
    await layout(true); await layout(true);
    expect(toggles()).toBe(1);
    expect(accepted).toEqual([]);
    expect(focusCount).toBe(0);
    for (let i = 0; i < 3; i++) { await act(async () => { for (const fn of resizes) fn(); }); await layout(true); }
    expect(toggles()).toBe(1);
    occluded = false; await mutate();
    expect(nativeVisible).toBe(true);
    expect(command).toHaveBeenLastCalledWith({ instanceId: id, action: "request-state" });
    await layout(true); await layout(true); await mutate(); await layout(true);
    expect(toggles()).toBe(2);
    expect(accepted).toEqual(["toggle-left"]);
    // public layout 仍为 true 不算 ack；重复 ready、resize、DOM mutation 不允许再 toggle。
    await act(async () => { for (const fn of states) fn({ instanceId: id, status: "ready" }); for (const fn of resizes) fn(); });
    await layout(true);
    expect(toggles()).toBe(2);
    await paint();
    await act(async () => renderer.update(<CloudDocPanel sessionId={sessionId} surfaceVisible={false} />));
    await layout(true);
    expect(nativeVisible).toBe(false);
    expect(toggles()).toBe(2);
    expect(focusCount).toBe(1);
    await act(async () => renderer.update(<CloudDocPanel sessionId={sessionId} surfaceVisible />));
    expect(nativeVisible).toBe(true);
    await layout(true); await layout(true);
    expect(toggles()).toBe(3);
    expect(accepted).toEqual(["toggle-left", "toggle-left"]);
    // 真正收到 leftOpen=false 才清 pending；此后用户重新展开仍保留正常自动收起。
    await layout(false);
    await layout(true); await layout(true);
    expect(toggles()).toBe(4);
    expect(accepted).toEqual(["toggle-left", "toggle-left", "toggle-left"]);
    expect(snapshot).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => renderer.unmount());
    useFilesPanelStore.getState().clearSession(sessionId);
    occluded = false;
  }
});
