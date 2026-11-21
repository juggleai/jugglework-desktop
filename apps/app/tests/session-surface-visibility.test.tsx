/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { readFileSync } from "node:fs";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originals = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage, getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver, CSS: globalThis.CSS };
const storage = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
const hostWindow = new EventTarget() as any;
const hostDocument = new EventTarget() as any;
hostDocument.body = {};
hostDocument.documentElement = { lang: "en" };
hostDocument.hidden = false;
hostDocument.querySelectorAll = () => [];
(globalThis as any).window = hostWindow;
(globalThis as any).document = hostDocument;
(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
(globalThis as any).MutationObserver = class { observe() {} disconnect() {} };
let surfaceVisible = true;
(globalThis as any).getComputedStyle = () => ({ display: "block", visibility: surfaceVisible ? "visible" : "hidden", borderTopLeftRadius: "0px", fontFamily: "sans-serif", getPropertyValue: () => "#fff" });
(globalThis as any).CSS = { supports: () => true };

const actualDen = await import("../src/app/lib/den.ts?session-surface-visibility-real");
const launches: string[] = [];
const opened: string[] = [];
const closed: string[] = [];
const bounds: Array<{ instanceId: string; visible: boolean; width: number; height: number }> = [];
const states = new Set<(value: unknown) => void>();
mock.module("../src/app/lib/den", () => ({ ...actualDen,
  readDenSettings: () => ({ baseUrl: "https://source.test", activeOrgId: "tenant", authToken: "fixture" }),
  readDenUserId: () => "user",
  createDenClient: () => ({ launchCloudDocs: async (input: any) => {
    launches.push(input.target.pageId);
    return { tenantId: "tenant", presentation: input.presentation, bootstrapUrl: "https://docs.test/bootstrap", launchGrant: "fixture" };
  } }),
}));
mock.module("../src/react-app/domains/cloud-docs/product-view", () => ({ rememberCloudDocsOrigin() {} }));
mock.module("../src/components/ui/sonner", () => ({ toast: { error() {} } }));
mock.module("../src/components/ui/button", () => ({ Button: ({ variant, size, ...props }: any) => <button {...props} /> }));
// 与可见性无关的本地文件内容和查询不参与本测试；保留真实 FilesPanel、标签、云文档与 bounds。
mock.module("../src/react-app/domains/session/files/file-tree", () => ({ FileTree: () => null }));
mock.module("../src/react-app/domains/session/files/file-viewer", () => ({ FileViewer: () => null }));
mock.module("../src/react-app/domains/session/files/changes-view", () => ({ ChangesView: () => null }));
mock.module("../src/react-app/domains/session/files/turn-changes-view", () => ({ TurnChangesView: () => null }));
mock.module("../src/react-app/domains/session/files/use-workspace-changes", () => ({ useWorkspaceChanges: () => ({ data: { changes: [] } }), useRefreshWorkspaceChanges: () => () => {} }));
mock.module("../src/components/ui/popover", () => ({ Popover: ({ children }: any) => children, PopoverTrigger: ({ render }: any) => render, PopoverContent: () => null }));
hostWindow.__JUGGLEWORK_ELECTRON__ = { cloudDocs: {
  open: async (input: { instanceId: string }) => { opened.push(input.instanceId); states.forEach(fn => fn({ instanceId: input.instanceId, status: "ready" })); },
  close: async (id: string) => { closed.push(id); return { closed: true }; },
  setBounds: (value: typeof bounds[number]) => bounds.push(value),
  onState: (fn: (value: unknown) => void) => { states.add(fn); return () => states.delete(fn); },
  onLayout: () => () => {}, onAiReference: () => () => {},
  setAppearance() {}, layoutCommand() {}, highlightBlocks() {},
} };

const { SessionSurfaceVisibilityProvider } = await import("../src/react-app/domains/session/session-surface-visibility");
const { FilesPanel } = await import("../src/react-app/domains/session/files/files-panel");
const { CloudDocPanel } = await import("../src/react-app/domains/cloud-docs/cloud-doc-panel");
const { useFilesPanelStore } = await import("../src/react-app/domains/session/files/files-panel-store");
const { openCloudDocTab, cloudDocTabsSnapshot } = await import("../src/app/lib/cloud-doc-tabs");
const { captureCloudDocTurn } = await import("../src/app/lib/cloud-doc-turn");
afterAll(() => { mock.restore(); Object.assign(globalThis, originals); });

test("SessionRoute 仅为 SessionPage 提供 surfaceVisible，runtime 不受显示状态控制", () => {
  const route = readFileSync(new URL("../src/react-app/shell/session-route.tsx", import.meta.url), "utf8");
  const start = route.indexOf("<SessionSurfaceVisibilityProvider surfaceVisible={props.surfaceVisible ?? true}>");
  const end = route.indexOf("</SessionSurfaceVisibilityProvider>", start);
  expect(start).toBeGreaterThan(route.indexOf("<ReactSessionRuntime"));
  expect(route.slice(start, end)).toMatch(/>\s*<SessionPage\b[\s\S]*\/>\s*$/);
  expect(route.slice(start, end)).not.toContain("<ReactSessionRuntime");
  expect(route.slice(start, end)).not.toContain("<CreateWorkspaceModal");
});

test("真实文件/云文档边界传递 surfaceVisible；后台 preview 保留尺寸与标签，返回复用原实例", async () => {
  const sessionId = "surface-visibility";
  openCloudDocTab(sessionId, { tenantId: "tenant", workspaceId: "cloud-ws", docId: "doc", title: "Document" });
  const panel = <FilesPanel sessionId={sessionId} client={null} workspaceId={null} workspaceRoot="" opencodeBaseUrl="" opencodeToken="" busy={true} isRemoteWorkspace />;
  const tree = () => <SessionSurfaceVisibilityProvider surfaceVisible={surfaceVisible}><div style={{ visibility: surfaceVisible ? "visible" : "hidden", width: 800, height: 600 }}>{panel}</div></SessionSurfaceVisibilityProvider>;
  const host = { clientWidth: 800, getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }) };
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(tree(), { createNodeMock: () => host }); });
  try {
    const instanceId = opened[0];
    expect(renderer.root.findByType(CloudDocPanel).props.surfaceVisible).toBe(true);
    expect(bounds.at(-1)).toMatchObject({ instanceId, visible: true });
    const activeDoc = captureCloudDocTurn(sessionId, "修改当前文档");
    expect(activeDoc.activeDoc?.docId).toBe("doc");
    surfaceVisible = false;
    await act(async () => { renderer.update(tree()); });
    expect(renderer.root.findByType(CloudDocPanel).props.surfaceVisible).toBe(false);
    bounds.length = 0;
    // 后台 preview/ready/resize 仍可更新，不能重新显示原生页。
    await act(async () => {
      hostWindow.dispatchEvent(new Event("resize"));
      states.forEach(fn => fn({ instanceId, status: "ready" }));
    });
    expect(bounds.length).toBeGreaterThan(0);
    expect(bounds.every(value => !value.visible && value.width === 800 && value.height === 600)).toBe(true);
    expect(useFilesPanelStore.getState().sessions[sessionId].activeKey).toBe("cloud");
    expect(cloudDocTabsSnapshot(sessionId).active).toBe("cloud-ws/doc");
    expect(captureCloudDocTurn(sessionId, "修改当前文档")).toEqual(activeDoc);
    surfaceVisible = true;
    await act(async () => { renderer.update(tree()); hostWindow.dispatchEvent(new Event("resize")); });
    expect(renderer.root.findByType(CloudDocPanel).props.surfaceVisible).toBe(true);
    expect(bounds.at(-1)).toMatchObject({ instanceId, visible: true });
    expect(launches).toEqual(["doc"]);
    expect(opened).toEqual([instanceId]);
    expect(closed).toEqual([]);
  } finally {
    await act(async () => renderer.unmount());
    useFilesPanelStore.getState().clearSession(sessionId);
    surfaceVisible = true;
  }
});

test("独立 FilesPanel 无 Provider 时向云文档传递可见默认值", async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<FilesPanel sessionId="standalone-surface" client={null} workspaceId={null} workspaceRoot="" opencodeBaseUrl="" opencodeToken="" busy={false} isRemoteWorkspace />); });
  try {
    expect(renderer.root.findByType(CloudDocPanel).props.surfaceVisible).toBe(true);
  } finally {
    await act(async () => renderer.unmount());
  }
});
