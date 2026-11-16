/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const storage = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
const hostWindow = new EventTarget() as any;
const hostDocument = new EventTarget() as any;
hostDocument.body = {};
(globalThis as any).window = hostWindow;
(globalThis as any).document = hostDocument;
(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
(globalThis as any).MutationObserver = class { observe() {} disconnect() {} };
(globalThis as any).getComputedStyle = () => ({ fontFamily: "sans-serif", getPropertyValue: () => "#fff" });
(globalThis as any).CSS = { supports: () => true };
let tenantId = "tenant-a";
const actualDen = await import("../src/app/lib/den.ts?unified-tabs-real");
const launches: string[] = [];
const opened: Array<{ instanceId: string }> = [];
const closed: string[] = [];
let closeAllowed = true;
const visibility = new Map<string, boolean>();
const states = new Set<(value: unknown) => void>();
mock.module("../src/app/lib/den", () => ({ ...actualDen,
  readDenSettings: () => ({ baseUrl: "https://source.test", activeOrgId: tenantId, authToken: "fixture" }),
  readDenUserId: () => "user",
  createDenClient: () => ({ launchCloudDocs: async (input: any) => {
    launches.push(input.target.pageId);
    return { tenantId, presentation: input.presentation, bootstrapUrl: "https://docs.test/api/jw/session/bootstrap", launchGrant: "fixture" };
  } }),
}));
let switchAllowed = true;
mock.module("../src/react-app/domains/session/files/office-file-switch", () => ({ commitOfficeFileSwitch: (_session: string, _path: string, commit: () => void) => { if (switchAllowed) commit(); } }));
mock.module("../src/react-app/domains/cloud-docs/product-view", () => ({ rememberCloudDocsOrigin() {} }));
mock.module("../src/react-app/domains/cloud-docs/use-cloud-docs-bounds", () => ({ useCloudDocsBounds: () => ({ snapshot: null, loaded() {}, sync: (id: string, ready: boolean, active: boolean) => visibility.set(id, ready && active) }) }));
hostWindow.__JUGGLEWORK_ELECTRON__ = { cloudDocs: {
  open: async (input: { instanceId: string }) => { opened.push(input); states.forEach(fn => fn({ instanceId: input.instanceId, status: "ready" })); },
  close: async (id: string) => {
    if (closeAllowed) closed.push(id);
    return { closed: closeAllowed };
  },
  onState: (fn: (value: unknown) => void) => { states.add(fn); return () => states.delete(fn); },
  onLayout: () => () => {}, onAiReference: () => () => {}, setAppearance() {}, layoutCommand() {}, highlightBlocks() {},
} };
const { CloudDocPanel } = await import("../src/react-app/domains/cloud-docs/cloud-doc-panel");
const { FileTabs } = await import("../src/react-app/domains/session/files/file-tabs");
const { useFilesPanelStore } = await import("../src/react-app/domains/session/files/files-panel-store");
const { openCloudDocTab, activateCloudDocTab, closeCloudDocTab, cloudDocTabsSnapshot } = await import("../src/app/lib/cloud-doc-tabs");
const { captureCloudDocTurn } = await import("../src/app/lib/cloud-doc-turn");
const { denSettingsChangedEvent } = await import("../src/app/lib/den-session-events");
afterAll(() => mock.restore());

test("云文档和本地文件共用一排标签及关闭入口，选中态互斥", () => {
  const html = renderToStaticMarkup(<FileTabs tabs={[{ path: "report.docx", name: "report.docx" }]} activePath={null} dirtyPaths={new Set()} changesTab={null} onSelect={() => {}} onClose={() => {}} cloudTabs={[{ key: "ws/doc", title: "产品方案", active: true, onSelect: () => {}, onClose: () => {} }]} />);
  expect(html.match(/overflow-x-auto/g)).toHaveLength(1);
  expect(html).toContain("report.docx");
  expect(html).toContain("产品方案");
  expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Close report.docx"');
  expect(html).toContain('aria-label="Close 产品方案"');
});

test("本地与多篇云文档反复切换保留各自实例；关闭标签和切组织释放，选区预检取消时不切换", async () => {
  const sessionId = "unified-tabs";
  const store = useFilesPanelStore.getState();
  store.openFile(sessionId, { path: "report.docx", name: "report.docx" });
  const tab = (docId: string) => ({ tenantId, workspaceId: "cloud-ws", docId, title: docId });
  openCloudDocTab(sessionId, tab("a"));
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<CloudDocPanel sessionId={sessionId} />, { createNodeMock: () => ({ clientWidth: 600 }) }); });
  expect(launches).toEqual(["a"]);
  const a = opened[0].instanceId;
  await act(async () => store.clearTurnChanges(sessionId));
  expect(useFilesPanelStore.getState().sessions[sessionId]?.activeKey).toBe("cloud");
  await act(async () => store.selectFile(sessionId, "report.docx"));
  expect(visibility.get(a)).toBe(false);
  expect(captureCloudDocTurn(sessionId, "修改当前文档").activeDoc).toBeNull();
  await act(async () => activateCloudDocTab(sessionId, "cloud-ws/a"));
  expect(visibility.get(a)).toBe(true);
  expect(launches).toEqual(["a"]);
  await act(async () => openCloudDocTab(sessionId, tab("b")));
  const b = opened[1].instanceId;
  expect(launches).toEqual(["a", "b"]);
  await act(async () => activateCloudDocTab(sessionId, "cloud-ws/a"));
  expect(launches).toEqual(["a", "b"]);
  expect(closed).toEqual([]);
  expect(visibility.get(a)).toBe(true);
  expect(visibility.get(b)).toBe(false);
  switchAllowed = false;
  await act(async () => activateCloudDocTab(sessionId, "cloud-ws/b"));
  expect(cloudDocTabsSnapshot(sessionId).active).toBe("cloud-ws/a");
  switchAllowed = true;
  closeAllowed = false;
  await act(async () => closeCloudDocTab(sessionId, "cloud-ws/b"));
  expect(cloudDocTabsSnapshot(sessionId).tabs.some(item => item.docId === "b")).toBe(true);
  expect(closed).toEqual([]);
  closeAllowed = true;
  await act(async () => closeCloudDocTab(sessionId, "cloud-ws/b"));
  expect(closed).toEqual([b]);
  expect(captureCloudDocTurn(sessionId, "修改当前文档").activeDoc?.docId).toBe("a");
  tenantId = "tenant-b";
  await act(async () => hostWindow.dispatchEvent(new Event(denSettingsChangedEvent)));
  expect(closed).toEqual([b, a]);
  expect(launches).toEqual(["a", "b"]);
  expect(captureCloudDocTurn(sessionId, "修改当前文档").activeDoc).toBeNull();
  await act(async () => renderer.unmount());
  store.clearSession(sessionId);
});
