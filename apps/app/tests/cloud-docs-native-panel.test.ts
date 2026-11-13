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
  async capturePage() { return { toDataURL: () => "data:image/png;base64,fixture" }; }
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
  setBounds = mock((_bounds: { x: number; y: number; width: number; height: number }) => {});
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
afterAll(() => mock.restore());

test("原生视图在新文档授权前隐藏，401/403/404 隐藏并报告，旧实例不能覆盖新实例", async () => {
  const host = {
    mainFrame: {},
    send: mock(() => {}),
    focus: mock(() => {}),
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
    docsOrigin: "http://docs.localhost:13000",
    bootstrapUrl: "http://docs.localhost:13000/api/jw/session/bootstrap",
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
  const ready = (view: NativeView, id: string) => {
    view.webContents.send.mockImplementation((channel: string, value: any) => {
      if (channel === "jugglework:docs:prepare-close") queueMicrotask(() => events.get("jugglework:docs:file-intake")!({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { ...value, ok: true, result: { persisted: true } }));
    });
    events.get("jugglework:docs:message")!(
      { sender: view.webContents, senderFrame: view.webContents.mainFrame },
      { contractVersion: 1, instanceId: id, tenantId, workspaceId: "ws", type: "docs.ready" },
    );
  };
  bounds(a.instanceId);
  expect(first.visible).toBe(false);
  ready(first, a.instanceId);
  bounds(a.instanceId);
  expect(first.visible).toBe(true);
  expect(first.webContents.focus).toHaveBeenCalledTimes(1);
  const boundsCalls = first.setBounds.mock.calls.length;
  events.get("jugglework:docs:bounds")!(
    { sender: host, senderFrame: host.mainFrame },
    { instanceId: a.instanceId, visible: false, x: 0, y: 0, width: 0, height: 0 },
  );
  expect(first.visible).toBe(false);
  expect(first.setBounds.mock.calls.length).toBe(boundsCalls);
  bounds(a.instanceId);
  expect(first.webContents.focus).toHaveBeenCalledTimes(2);
  events.get("jugglework:docs:message")!({ sender: first.webContents, senderFrame: first.webContents.mainFrame }, {
    contractVersion: 1, instanceId: a.instanceId, tenantId, workspaceId: "ws", docId: "doc", title: "方案", type: "docs.ai-reference", action: "ask", blockIds: ["b1"],
  });
  expect(host.focus).toHaveBeenCalledTimes(1);
  expect(host.send).toHaveBeenLastCalledWith("jugglework:docs:ai-reference", expect.objectContaining({ docId: "doc", blockIds: ["b1"] }));
  // TIPS: 周期 ready／布局更新不能打断用户输入；只有从覆盖层隐藏恢复时才重新聚焦。
  bounds(a.instanceId);
  expect(first.webContents.focus).toHaveBeenCalledTimes(2);
  events.get("jugglework:docs:bounds")!(
    { sender: host, senderFrame: host.mainFrame },
    { instanceId: a.instanceId, visible: false, x: 0, y: 0, width: 500, height: 400 },
  );
  bounds(a.instanceId);
  expect(first.webContents.focus).toHaveBeenCalledTimes(3);
  // TIPS: 顶部控制只能作用于当前主框架、当前实例，状态读取不能打断编辑焦点。
  const command = (senderFrame: object, instanceId: string, action: string) =>
    events.get("jugglework:docs:layout-command")!({ sender: host, senderFrame }, { instanceId, action });
  command({}, a.instanceId, "toggle-left");
  command(host.mainFrame, randomUUID(), "toggle-right");
  command(host.mainFrame, a.instanceId, "arbitrary-script");
  expect(first.webContents.send).not.toHaveBeenCalled();
  command(host.mainFrame, a.instanceId, "request-state");
  expect(first.webContents.focus).toHaveBeenCalledTimes(3);
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
  const deniedCount = host.send.mock.calls.length;
  first.webContents.emit("did-start-navigation", {}, "https://docs.test/late", false, true);
  ready(first, a.instanceId);
  bounds(a.instanceId);
  expect(first.visible).toBe(false);
  expect(host.send.mock.calls).toHaveLength(deniedCount);
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
    status: "error",
    message: "云文档暂时无法连接",
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(clearedOrigins).toEqual([]);
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
        docsOrigin: "http://docs.localhost:13000",
    bootstrapUrl: "http://docs.localhost:13000/api/jw/session/bootstrap",
      },
    ),
  ).toThrow("Forbidden");
  panel.close();
});

test("后台上传不替换前台，页面切换与后台关闭只结束各自的请求", async () => {
  const host = { mainFrame: {}, send: mock(() => {}), getZoomFactor: () => 1 };
  const attached: NativeView[] = [];
  const win = {
    webContents: host, isDestroyed: () => false,
    getContentBounds: () => ({ width: 1000, height: 800 }),
    contentView: {
      addChildView(view: NativeView) { attached.push(view); },
      removeChildView(view: NativeView) { attached.splice(attached.indexOf(view), 1); },
    },
  };
  const handlers = new Map<string, Function>(), events = new Map<string, Function>();
  const panel = createCloudDocsPanel({ getWindow: () => win });
  panel.registerIpc({
    handle: (name: string, fn: Function) => handlers.set(name, fn),
    on: (name: string, fn: Function) => events.set(name, fn),
  });
  const tenantId = "native_fixture";
  const key = createHash("sha256").update(tenantId).digest("hex").slice(0, 32);
  const input = (background = false) => ({
    tenantId, sourceUserId: "u", sourceServerOrigin: "https://source.test",
    instanceId: randomUUID(), launchGrant: "fixture", background,
    docsOrigin: "http://docs.localhost:13000",
    bootstrapUrl: "http://docs.localhost:13000/api/jw/session/bootstrap",
    presentation: { mode: "product" },
  });
  const event = { sender: host, senderFrame: host.mainFrame };
  const open = async (value: ReturnType<typeof input>) => {
    await handlers.get("jugglework:docs:open")!(event, value);
    const view = views.at(-1)!;
    view.webContents.send.mockImplementation((channel: string, value: any) => {
      if (channel === "jugglework:docs:prepare-close") queueMicrotask(() => events.get("jugglework:docs:file-intake")!({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { ...value, ok: true, result: { persisted: true } }));
    });
    events.get("jugglework:docs:message")!({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, {
      contractVersion: 1, type: "docs.ready", instanceId: value.instanceId, tenantId, workspaceId: "ws",
    });
    return view;
  };
  const front = input(), back = input(true);
  const frontView = await open(front);
  events.get("jugglework:docs:bounds")!(event, { instanceId: front.instanceId, x: 0, y: 0, width: 800, height: 600, visible: true });
  const backView = await open(back);
  expect(frontView.visible).toBe(true);
  expect(frontView.webContents.closed).toBe(false);
  expect(backView.visible).toBe(false);
  expect(attached).toEqual([frontView]);

  const requestId = randomUUID();
  const lookup = handlers.get("jugglework:docs:file-intake")!(event, {
    action: "lookup", instanceId: back.instanceId, requestId, checksum: "a".repeat(64),
  });
  const replacementInput = input();
  const replacement = await open(replacementInput);
  expect(frontView.webContents.closed).toBe(true);
  expect(backView.webContents.closed).toBe(false);
  events.get("jugglework:docs:file-intake")!({ sender: backView.webContents, senderFrame: backView.webContents.mainFrame }, {
    instanceId: back.instanceId, requestId, ok: true, result: { existing: [] },
  });
  expect(await lookup).toEqual({ existing: [] });
  panel.close(back.instanceId);
  expect(backView.webContents.closed).toBe(true);
  expect(replacement.webContents.closed).toBe(false);
  expect(attached).toEqual([replacement]);
  const otherBack = await open(input(true));
  events.get("jugglework:docs:bounds")!(event, { instanceId: replacementInput.instanceId, x: 0, y: 0, width: 800, height: 600, visible: true });
  const retained = { ...input(), retain: true };
  const retainedView = await open(retained);
  const session = { ...input(), retain: true };
  const sessionView = await open(session);
  expect(replacement.visible).toBe(true);
  expect(retainedView.webContents.closed).toBe(false);
  expect(retainedView.visible).toBe(false);
  events.get("jugglework:docs:bounds")!(event, { instanceId: retained.instanceId, x: 0, y: 0, width: 800, height: 600, visible: true });
  expect(retainedView.visible).toBe(true);
  expect(sessionView.visible).toBe(false);
  expect(await handlers.get("jugglework:docs:snapshot")!(event, retained.instanceId)).toBe("data:image/png;base64,fixture");
  expect(await handlers.get("jugglework:docs:snapshot")!(event, otherBack.webContents.url)).toBeNull();
  await panel.closeScope(front);
  expect(replacement.webContents.closed).toBe(true);
  expect(otherBack.webContents.closed).toBe(true);
  expect(retainedView.webContents.closed).toBe(true);
  expect(sessionView.webContents.closed).toBe(true);
  expect(attached).toEqual([]);
});

test("File Browser 只控制所属原生页，关闭须收到原生本地保存确认", async () => {
  const owner = (id: number) => ({ id, webContents: { mainFrame: {}, send: mock(() => {}), getZoomFactor: () => 1 }, isDestroyed: () => false, getContentBounds: () => ({ width: 1000, height: 800 }), contentView: { addChildView() {}, removeChildView() {} } });
  const main = owner(1), file = owner(2), other = owner(3);
  const handlers = new Map<string, Function>(), events = new Map<string, Function>();
  const panel = createCloudDocsPanel({ getWindow: () => main, getWindows: () => [main, file, other] });
  panel.registerIpc({ handle: (name: string, fn: Function) => handlers.set(name, fn), on: (name: string, fn: Function) => events.set(name, fn) });
  const input = { tenantId: "org", sourceUserId: "user", sourceServerOrigin: "https://work.test", docsOrigin: "https://docs.test", bootstrapUrl: "https://docs.test/api/jw/session/bootstrap", instanceId: randomUUID(), launchGrant: "fixture", presentation: { mode: "product" }, retain: true };
  await panel.open(input, file);
  const view = views.at(-1)!;
  view.webContents.url = 'https://docs.test/workspace/ws/original';
  const event = (win: typeof file) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  expect(() => handlers.get("jugglework:docs:status")!(event(other), input.instanceId)).toThrow("Forbidden");
  expect(() => handlers.get("jugglework:docs:api")!(event(file), { tenantId: "org" })).toThrow("Forbidden");
  events.get("jugglework:docs:message")!({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { contractVersion: 1, instanceId: input.instanceId, tenantId: "org", workspaceId: "ws", contextId: "a".repeat(43), type: "docs.ready" });
  expect(handlers.get("jugglework:docs:status")!(event(file), input.instanceId)).toMatchObject({ ready: true, status: "ready" });
  expect(panel.documentFor(input.instanceId, file)?.docId).toBe('original');
  expect(panel.documentFor(input.instanceId, other)).toBeNull();
  view.webContents.url = 'https://docs.test/workspace/ws/navigated';
  view.webContents.emit('did-navigate-in-page');
  expect(panel.documentFor(input.instanceId, file)?.docId).toBe('navigated');
  expect(file.webContents.send).toHaveBeenLastCalledWith('jugglework:docs:state', expect.objectContaining({docId:'navigated'}));
  const failedClose = handlers.get("jugglework:docs:close")!(event(file), input.instanceId);
  expect(view.webContents.closed).toBe(false);
  const request = view.webContents.send.mock.calls.at(-1)!;
  expect(request[0]).toBe("jugglework:docs:prepare-close");
  const message = request[1] as { instanceId: string; requestId: string };
  // 其他页面即使知道 requestId，也不能伪造落盘回执。
  events.get("jugglework:docs:file-intake")!({ sender: other.webContents, senderFrame: other.webContents.mainFrame }, { ...message, ok: true, result: { persisted: true } });
  expect(view.webContents.closed).toBe(false);
  events.get("jugglework:docs:file-intake")!({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { ...message, ok: true, result: { persisted: false } });
  expect(await failedClose).toEqual({ closed: false });
  expect(view.webContents.closed).toBe(false);
  const closing = handlers.get("jugglework:docs:close")!(event(file), input.instanceId);
  const retry = view.webContents.send.mock.calls.at(-1)![1] as { instanceId: string; requestId: string };
  events.get("jugglework:docs:file-intake")!({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { ...retry, ok: true, result: { persisted: true } });
  expect(await closing).toEqual({ closed: true });
  expect(view.webContents.closed).toBe(true);
});

test("退出和更新等待所有窗口落盘；关闭主窗口不销毁独立云文档", async () => {
  const owner = (id: number) => ({ id, webContents: { mainFrame: {}, send: mock(() => {}), getZoomFactor: () => 1 }, isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} } });
  const main = owner(11), file = owner(12), events = new Map<string,Function>();
  const panel = createCloudDocsPanel({ getWindow: () => main, getWindows: () => [main, file] });
  panel.registerIpc({handle() {}, on: (name: string, callback: Function) => events.set(name,callback)});
  const values = [];
  for (const window of [main, file]) {
    const instanceId = randomUUID();
    await panel.open({instanceId, tenantId:"org", sourceUserId:"user", sourceServerOrigin:"https://work.test", docsOrigin:"https://docs.test", bootstrapUrl:"https://docs.test/api/jw/session/bootstrap", launchGrant:"test", retain:true}, window);
    const view = views.at(-1)!; values.push({view,instanceId});
    events.get("jugglework:docs:message")!({sender:view.webContents,senderFrame:view.webContents.mainFrame},{contractVersion:1,instanceId,type:"docs.ready",tenantId:"org",workspaceId:"ws"});
  }
  const preparing = panel.prepareQuit();
  for (const [index,{view}] of values.entries()) {
    const command = view.webContents.send.mock.calls.at(-1)![1] as any;
    events.get("jugglework:docs:file-intake")!({sender:view.webContents,senderFrame:view.webContents.mainFrame},{...command,ok:true,result:{persisted:index===0}});
  }
  expect(await preparing).toBe(false);
  expect(values.every(value => !value.view.webContents.closed)).toBe(true);
  panel.closeWindow(main);
  expect(values[0].view.webContents.closed).toBe(true);
  expect(values[1].view.webContents.closed).toBe(false);
  panel.close();
});
