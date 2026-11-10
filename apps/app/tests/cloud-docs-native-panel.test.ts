import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
class Contents extends EventEmitter {
  mainFrame = {};
  url = "";
  closed = false;
  setWindowOpenHandler() {}
  async loadURL(url: string) {
    this.url = url;
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return this.closed;
  }
  close() {
    this.closed = true;
  }
  send = mock((_channel: string, _value: unknown) => {});
  getZoomFactor() { return 1; }
  focus = mock(() => {});
}
class NativeView {
  webContents = new Contents();
  visible = false;
  constructor() {
    views.push(this);
  }
  setVisible(value: boolean) {
    this.visible = value;
  }
  getVisible() { return this.visible; }
  setBounds() {}
}
const views: NativeView[] = [];
const clearedOrigins: string[] = [];
let failStorageCleanup = false;
mock.module("electron", () => ({
  WebContentsView: NativeView,
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler() {},
      async clearStorageData(input: { origin: string }) {
        clearedOrigins.push(input.origin);
        if (failStorageCleanup) throw new Error("storage_cleanup_failed");
      },
      async flushStorageData() {},
    }),
  },
  shell: {},
}));
const { createCloudDocsPanel } =
  await import("../../desktop/electron/cloud-docs-panel.mjs");
const { createCloudDocsEditors } =
  await import("../../desktop/electron/cloud-docs-editor.mjs");
afterAll(() => mock.restore());

test("原生视图在新文档授权前隐藏，401/403/404 隐藏并报告，旧实例不能覆盖新实例", async () => {
  const host = {
    mainFrame: {},
    send: mock(() => {}),
    getZoomFactor: () => 1,
  };
  const win = {
    webContents: host,
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1000, height: 800 }),
    contentView: { addChildView() {}, removeChildView() {} },
  };
  const handlers = new Map<string, Function>(),
    events = new Map<string, Function>();
  const panel = createCloudDocsPanel({ getWindow: () => win });
  panel.registerIpc({
    handle: (name: string, fn: Function) => handlers.set(name, fn),
    on: (name: string, fn: Function) => events.set(name, fn),
  });
  const tenantId = "native_fixture",
    key = createHash("sha256").update(tenantId).digest("hex").slice(0, 32);
  const input = () => ({
    tenantId,
    sourceUserId: "u",
    sourceServerOrigin: "https://source.test",
    instanceId: randomUUID(),
    launchGrant: "fixture",
    bootstrapUrl: `http://t-${key}.localhost:13000/api/jw/session/bootstrap`,
    presentation: { mode: "product" },
  });
  const a = input();
  await handlers.get("jugglework:docs:open")!(
    { sender: host, senderFrame: host.mainFrame },
    a,
  );
  const first = views.at(-1)!;
  const bounds = (id: string) =>
    events.get("jugglework:docs:bounds")!(
      { sender: host, senderFrame: host.mainFrame },
      { instanceId: id, visible: true, x: 0, y: 0, width: 500, height: 400 },
    );
  const ready = (view: NativeView, id: string) =>
    events.get("jugglework:docs:message")!(
      { sender: view.webContents, senderFrame: view.webContents.mainFrame },
      {
        contractVersion: 1,
        instanceId: id,
        tenantId,
        workspaceId: "ws",
        type: "docs.ready",
      },
    );
  bounds(a.instanceId);
  expect(first.visible).toBe(false);
  ready(first, a.instanceId);
  bounds(a.instanceId);
  expect(first.visible).toBe(true);
  expect(first.webContents.focus).toHaveBeenCalledTimes(1);
  // TIPS: 周期 ready／布局更新不能打断用户输入；只有从覆盖层隐藏恢复时才重新聚焦。
  bounds(a.instanceId);
  expect(first.webContents.focus).toHaveBeenCalledTimes(1);
  events.get("jugglework:docs:bounds")!(
    { sender: host, senderFrame: host.mainFrame },
    { instanceId: a.instanceId, visible: false, x: 0, y: 0, width: 500, height: 400 },
  );
  bounds(a.instanceId);
  expect(first.webContents.focus).toHaveBeenCalledTimes(2);
  // TIPS: 顶部控制只能作用于当前主框架、当前实例，状态读取不能打断编辑焦点。
  const command = (senderFrame: object, instanceId: string, action: string) =>
    events.get("jugglework:docs:layout-command")!({ sender: host, senderFrame }, { instanceId, action });
  command({}, a.instanceId, "toggle-left");
  command(host.mainFrame, randomUUID(), "toggle-right");
  command(host.mainFrame, a.instanceId, "arbitrary-script");
  expect(first.webContents.send).not.toHaveBeenCalled();
  command(host.mainFrame, a.instanceId, "request-state");
  expect(first.webContents.focus).toHaveBeenCalledTimes(2);
  command(host.mainFrame, a.instanceId, "toggle-left");
  expect(first.webContents.send).toHaveBeenLastCalledWith("jugglework:docs:layout-command", {
    instanceId: a.instanceId, action: "toggle-left",
  });
  events.get("jugglework:docs:message")!({ sender: first.webContents, senderFrame: first.webContents.mainFrame }, {
    contractVersion: 1, instanceId: a.instanceId, tenantId, type: "docs.layout",
    layout: { leftOpen: false, leftWidth: 248, rightOpen: true },
  });
  expect(host.send).toHaveBeenLastCalledWith("jugglework:docs:layout", {
    instanceId: a.instanceId, layout: { leftOpen: false, leftWidth: 248, rightOpen: true },
  });
  first.webContents.emit(
    "did-start-navigation",
    {},
    "https://docs.test/page",
    false,
    true,
  );
  expect(first.visible).toBe(false);
  for (const status of [401, 403, 404]) {
    first.webContents.emit("did-navigate", {}, first.webContents.url, status);
    expect(host.send).toHaveBeenLastCalledWith("jugglework:docs:state", {
      instanceId: a.instanceId,
      status: "unauthorized",
    });
  }
  ready(first, a.instanceId);
  bounds(a.instanceId);
  expect(first.visible).toBe(false);
  events.get("jugglework:docs:message")!(
    { sender: first.webContents, senderFrame: first.webContents.mainFrame },
    {
      contractVersion: 1,
      instanceId: a.instanceId,
      type: "docs.session-expired",
    },
  );
  failStorageCleanup = true;
  expect(host.send).toHaveBeenLastCalledWith("jugglework:docs:state", {
    instanceId: a.instanceId,
    status: "unauthorized",
    message: "云文档连接已失效，请重新打开",
  });
  first.webContents.emit("render-process-gone");
  expect(first.visible).toBe(false);
  expect(host.send).toHaveBeenLastCalledWith("jugglework:docs:state", {
    instanceId: a.instanceId,
    status: "unauthorized",
    message: "云文档连接已失效，请重新打开",
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(clearedOrigins).toContain(`http://t-${key}.localhost:13000`);
  const b = input();
  await handlers.get("jugglework:docs:open")!(
    { sender: host, senderFrame: host.mainFrame },
    b,
  );
  failStorageCleanup = false;
  const second = views.at(-1)!;
  ready(second, b.instanceId);
  bounds(b.instanceId);
  const count = host.send.mock.calls.length;
  first.webContents.emit("did-navigate", {}, first.webContents.url, 403);
  ready(first, a.instanceId);
  panel.close(a.instanceId);
  expect(host.send.mock.calls).toHaveLength(count);
  expect(second.visible).toBe(true);
  expect(second.webContents.closed).toBe(false);
  panel.close();
});

test("后台编辑器撤权按来源账号和组织精确隔离", async () => {
  const ipcEvents = new Map<string, Function>();
  const paused: Array<{ attachmentId: string; reason: string }> = [];
  const editors = createCloudDocsEditors({
    onEvent: (attachmentId: string, message: { payload?: { reason?: string } }) => {
      if (message.payload?.reason)
        paused.push({ attachmentId, reason: message.payload.reason });
    },
  });
  editors.registerIpc({
    on: (name: string, fn: Function) => ipcEvents.set(name, fn),
  });
  const tenantId = "shared_tenant",
    key = createHash("sha256").update(tenantId).digest("hex").slice(0, 32),
    bootstrapUrl = `http://t-${key}.localhost:13000/api/jw/session/bootstrap`;
  const open = async (sourceServerOrigin: string, sourceUserId: string) => {
    const input = {
      tenantId,
      sourceUserId,
      sourceServerOrigin,
      instanceId: randomUUID(),
      attachmentId: randomUUID(),
      pageId: "page_1",
      launchGrant: "fixture",
      bootstrapUrl,
    };
    const opening = editors.open(input);
    await Promise.resolve();
    const view = views.at(-1)!;
    const bridgeId = randomUUID();
    ipcEvents.get("jugglework:docs:editor-message")!(
      { sender: view.webContents, senderFrame: view.webContents.mainFrame },
      {
        contractVersion: 1,
        instanceId: input.instanceId,
        tenantId,
        pageId: input.pageId,
        workspaceId: "workspace_1",
        bridgeId,
        type: "editor.ready",
        payload: {
          canEdit: true,
          capability: "word-relative-plain-v1",
        },
      },
    );
    return { input, view, bridgeId, handle: await opening };
  };
  const first = await open("https://source-a.test", "user-a");
  const second = await open("https://source-b.test", "user-b");
  ipcEvents.get("jugglework:docs:editor-message")!(
    {
      sender: first.view.webContents,
      senderFrame: first.view.webContents.mainFrame,
    },
    {
      contractVersion: 1,
      instanceId: first.input.instanceId,
      tenantId,
      pageId: first.input.pageId,
      workspaceId: "workspace_1",
      bridgeId: first.bridgeId,
      type: "editor.paused",
      payload: { reason: "session_expired" },
    },
  );
  expect(first.view.webContents.closed).toBe(true);
  expect(second.view.webContents.closed).toBe(false);
  expect(paused).toEqual([
    { attachmentId: first.input.attachmentId, reason: "session_expired" },
  ]);
  second.handle.close();
  editors.dispose();
});

test("主窗口子框架不能控制原生云文档视图", async () => {
  const host = {
    mainFrame: {},
    send: mock(() => {}),
    getZoomFactor: () => 1,
  };
  const win = {
    webContents: host,
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1000, height: 800 }),
    contentView: { addChildView() {}, removeChildView() {} },
  };
  const handlers = new Map<string, Function>();
  const panel = createCloudDocsPanel({ getWindow: () => win });
  panel.registerIpc({
    handle: (name: string, fn: Function) => handlers.set(name, fn),
    on: () => {},
  });
  const tenantId = "native_fixture",
    key = createHash("sha256").update(tenantId).digest("hex").slice(0, 32);
  expect(() =>
    handlers.get("jugglework:docs:open")!(
      { sender: host, senderFrame: {} },
      {
        tenantId,
        sourceUserId: "u",
        sourceServerOrigin: "https://source.test",
        instanceId: randomUUID(),
        launchGrant: "fixture",
        bootstrapUrl: `http://t-${key}.localhost:13000/api/jw/session/bootstrap`,
      },
    ),
  ).toThrow("Forbidden");
  panel.close();
});
