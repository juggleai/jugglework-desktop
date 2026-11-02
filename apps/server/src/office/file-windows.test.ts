import { afterEach, expect, mock, test } from "bun:test";
import { getOfficeDocumentKind } from "@jugglework/types/office";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

let sequence = 0;
const answers = {
  close: 2,
  open: { canceled: true, filePaths: [] as string[] },
  save: { canceled: true, filePath: "" },
  wait: undefined as ((options: any) => Promise<any>) | undefined,
  openError: null as string | null,
  review: undefined as ((options: any) => Promise<any>) | undefined,
  dialogs: [] as string[],
};
const nativeApp = new EventEmitter();
const partitions = new Map<string, any>();
const rendererIpc = new EventEmitter();
const rendererBridges: any[] = [];
class FakeContents extends EventEmitter {
  id = ++sequence;
  mainFrame = { parent: null };
  destroyed = false;
  messages: Array<{ name: string; value: any }> = [];
  loads: string[] = [];
  evaluations: string[] = [];
  focusCalls = 0;
  evaluationResult: unknown = false;
  evaluationGate?: () => Promise<void>;
  async executeJavaScript(source: string) {
    this.evaluations.push(source);
    await this.evaluationGate?.();
    return this.evaluationResult;
  }
  isDestroyed() {
    return this.destroyed;
  }
  getZoomFactor() {
    return 1;
  }
  send(name: string, value: unknown) {
    this.messages.push({ name, value });
  }
  setWindowOpenHandler() {}
  focus() {
    this.focusCalls++;
  }
  async loadURL(url: string) {
    this.loads.push(url);
  }
  async capturePage() {
    return { toDataURL: () => "data:image/png;base64,fixture" };
  }
  close() {
    this.destroyed = true;
  }
}
class FakeWindow extends EventEmitter {
  id = ++sequence;
  webContents = new FakeContents();
  children = new Set<any>();
  destroyed = false;
  title = "";
  focused = false;
  visible = true;
  minimized = false;
  contentView = {
    addChildView: (view: any) => this.children.add(view),
    removeChildView: (view: any) => this.children.delete(view),
  };
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.webContents.close();
    this.emit("closed");
  }
  setTitle(title: string) {
    this.title = title;
  }
  getTitle() {
    return this.title;
  }
  isFocused() {
    return this.focused;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  show() {}
  focus() {
    this.focused = true;
  }
}
class FakeView {
  webContents = new FakeContents();
  visible = false;
  getVisible() {
    return this.visible;
  }
  setBounds() {}
  setVisible(value: boolean) {
    this.visible = value;
  }
}
mock.module("electron", () => ({
  app: nativeApp,
  contextBridge: {
    exposeInMainWorld: (_name: string, value: any) =>
      rendererBridges.push(value),
  },
  ipcRenderer: rendererIpc,
  webUtils: {},
  BrowserWindow: FakeWindow,
  WebContentsView: FakeView,
  dialog: {
    showOpenDialog: async () => {
      answers.dialogs.push("open");
      return answers.open;
    },
    showSaveDialog: async () => {
      answers.dialogs.push("save");
      return answers.save;
    },
    showMessageBox: async (...args: any[]) => {
      const options = args.at(-1);
      if (options.title === "核对文档修改" && answers.review) return answers.review(options);
      return options.signal && answers.wait
        ? answers.wait(options)
        : { response: answers.close };
    },
    showErrorBox() {},
  },
  shell: { showItemInFolder() {} },
  session: {
    fromPartition: (name: string) => {
      if (!partitions.has(name)) {
        const partition = new EventEmitter() as any;
        const handled = new Map();
        partition.webRequest = {
          listener: null,
          onBeforeRequest(listener: any) {
            this.listener = listener;
          },
        };
        partition.protocol = {
          handlers: handled,
          handle(
            scheme: string,
            handler: (request: Request) => Promise<Response>,
          ) {
            if (handled.has(scheme))
              throw new Error("protocol already handled");
            handled.set(scheme, handler);
            if (scheme === "http") partition.protocol.handler = handler;
          },
          unhandle(scheme: string) {
            handled.delete(scheme);
          },
        };
        partitions.set(name, partition);
      }
      return partitions.get(name);
    },
  },
}));
// @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
await import("../../../desktop/electron/preload.mjs");
// @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
await import("../../../desktop/electron/file-window-preload.mjs");
const { createOfficePanel } =
  // @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
  await import("../../../desktop/electron/office-panel.mjs");
const { ManagedRuntimeClientError } =
  // @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
  await import("../../../desktop/electron/managed-runtime-client.mjs");
const { createOfficeResources } =
  // @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
  await import("../../../desktop/electron/office-resources.mjs");
const { createFileWindows } =
  // @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
  await import("../../../desktop/electron/file-windows.mjs");
const { triggerUpdaterInstall } =
  // @ts-expect-error Electron 的真实 JS 模块由桌面 checkJs 独立检查，跨包测试不使用重复声明。
  await import("../../../desktop/electron/updater.mjs");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  answers.review = undefined;
});

test("actual file-window state and changed payloads contain no access token; reads authenticate only in Main", async () => {
  const f = await fixture("notes.md");
  const secret = "state-regression-main-only-token";
  f.getAccess.mockImplementation(() => ({ baseUrl: "http://127.0.0.1:1234", clientToken: secret }));
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "notes.md" });
  const window = f.files.windows()[0];
  const state = structuredClone(await f.state(window));
  expect(state).toMatchObject({ baseUrl: "http://127.0.0.1:1234", activePath: "notes.md" });
  const scan = (value: unknown) => {
    expect(JSON.stringify(value)).not.toContain(secret);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      expect(key).not.toMatch(/token/i);
      scan(child);
    }
  };
  scan(state);
  const changes = window.webContents.messages.filter((message: any) => message.name === "jugglework:file-window:changed");
  expect(changes.length).toBeGreaterThan(0);
  for (const message of changes) scan(structuredClone(message.value));
  const result = await f.files.fetch(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    `${state.baseUrl}/workspace/ws/files/raw?path=notes.md`, {},
    async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${secret}` });
      return new Response(new Uint8Array([0, 255, 42]));
    },
  );
  expect([...new Uint8Array(result.body)]).toEqual([0, 255, 42]);
  window.destroy();
  f.panel.destroy();
});

test("file-window state rejects a window closed while awaiting access", async () => {
  const f = await fixture("notes.md");
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "notes.md" });
  const window = f.files.windows()[0];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.getAccess.mockImplementation(async () => {
    await gate;
    return { baseUrl: "http://127.0.0.1:1234", clientToken: "fixture" };
  });
  const pending = f.state(window).then(() => null, (error: unknown) => error);
  window.destroy();
  release();
  expect(await pending).toBeInstanceOf(Error);
  f.panel.destroy();
});

test("file-window fetch binds registered top-level sender and revokes closed tabs/windows", async () => {
  const f = await fixture("notes.md");
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "notes.md" });
  const window = f.files.windows()[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const url = "http://127.0.0.1:1234/workspace/ws/files/raw?path=notes.md";
  let calls = 0;
  const transport = async () => { calls++; return new Response("hello"); };
  const result = await f.files.fetch(event, url, {}, transport);
  expect(new TextDecoder().decode(result.body)).toBe("hello");
  await expect(f.files.fetch({ ...event, senderFrame: {} }, url, {}, transport)).rejects.toThrow();
  await expect(f.files.fetch({ sender: f.main.webContents, senderFrame: f.main.webContents.mainFrame }, url, {}, transport)).rejects.toThrow();
  await expect(f.files.fetch(event, url.replace("/ws/", "/other/"), {}, transport)).rejects.toThrow();
  await f.action(window, "close", "notes.md");
  await expect(f.files.fetch(event, url, {}, transport)).rejects.toThrow();
  window.destroy();
  await expect(f.files.fetch(event, url, {}, transport)).rejects.toThrow();
  expect(calls).toBe(1);
  f.panel.destroy();
});

test.each(["access", "response"])(
  "file-window fetch rejects a window closed while waiting for %s",
  async (phase) => {
    const f = await fixture("notes.md");
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "notes.md" });
    const window = f.files.windows()[0];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const access = { baseUrl: "http://127.0.0.1:1234", clientToken: "fixture" };
    if (phase === "access") f.getAccess.mockImplementation(async () => {
      started();
      await gate;
      return access;
    });
    const transport = mock(async () => {
      started();
      await gate;
      return new Response("private file");
    });
    const pending = f.files.fetch(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      `${access.baseUrl}/workspace/ws/files/raw?path=notes.md`, {}, transport,
    );
    const settled = pending.then(() => null, (error: unknown) => error);
    await waiting;
    window.destroy();
    release();
    expect(await settled).toBeInstanceOf(Error);
    expect(transport).toHaveBeenCalledTimes(phase === "access" ? 0 : 1);
    f.panel.destroy();
  },
);

async function fixture(
  name = "报告.docx",
  loadWindow = async (_window: FakeWindow) => {},
  target: { platform: NodeJS.Platform; arch: string } = {
    platform: "darwin",
    arch: "arm64",
  },
  resources?: any,
  composer?: any,
  conversationOptions: any = {},
) {
  partitions.clear();
  answers.open = { canceled: true, filePaths: [] };
  answers.openError = null;
  answers.save = { canceled: true, filePath: "" };
  answers.dialogs = [];
  const root = await mkdtemp(join(tmpdir(), "file-window-"));
  roots.push(root);
  const main = new FakeWindow();
  const document = {
    documentId: "od_A",
    pageId: "page_A",
    workspaceId: "ws",
    ownerSessionId: "ses",
    name,
    relativePath: name,
    previewUrl: `http://127.0.0.1:39999/static/${getOfficeDocumentKind(name)}/pc.html?localFilePath=/workspace/${name}`,
    state: "ready",
    dirty: false,
    engineFileId: "actual_A" as string | null,
  };
  const saves: Array<string | null> = [];
  const closes: unknown[] = [];
  const creations: Array<{ path: string; body: unknown }> = [];
  const contexts: unknown[] = [];
  const preparation = {
    error: null as string | null,
    closeError: null as string | null,
    targetError: null as string | null,
    calls: [] as unknown[],
    targets: [] as unknown[],
  };
  const opens: Promise<void>[] = [];
  const transfer = {
    reasons: [null] as Array<"running" | "finalizing" | "saving" | null>,
    checks: 0,
  };
  const client = {
    postHostJson: undefined as ((path: string, body: unknown, options?: { signal?: AbortSignal }) => Promise<any>) | undefined,
    async getJson(path: string, _options?: { signal?: AbortSignal }) {
      if (path === "/office/documents")
        return { items: document.state === "closed" ? [] : [{ ...document }] };
      if (path === "/workspaces") return { items: [{ id: "ws", path: root }] };
      if (path.includes("/files/stat")) return { exists: true, kind: "file" };
      if (path.endsWith("/capabilities")) return { available: true };
      if (path.endsWith("/transfer-status")) {
        transfer.checks++;
        return {
          documentId: document.documentId,
          reason:
            transfer.reasons.length > 1
              ? transfer.reasons.shift()
              : transfer.reasons[0],
        };
      }
      return { document: { ...document } };
    },
    async postJson(path: string, _body: unknown) {
      if (path.endsWith("/create")) {
        creations.push({ path, body: _body });
        return { document: { ...document } };
      }
      if (path.endsWith("/prepare-file")) {
        preparation.calls.push(_body);
        if (preparation.error) throw new Error(preparation.error);
        return { ok: true };
      }
      if (path === "/office/check-copy-target") {
        preparation.targets.push(_body);
        if (preparation.targetError) throw new Error(preparation.targetError);
        return { ok: true };
      }
      if (path.endsWith("/open") && answers.openError)
        throw Object.assign(new Error("Open failed"), {
          serverCode: answers.openError,
        });
      if (path.endsWith("/context")) contexts.push(_body);
      if (path.endsWith("/save")) {
        saves.push(document.engineFileId);
        document.dirty = false;
      }
      if (path.endsWith("/close")) {
        if (preparation.closeError) {
          if (preparation.closeError === "office_run_active")
            throw Object.assign(new Error("The managed runtime request failed."), {
              status: 409, serverCode: "office_run_active",
            });
          throw new Error(preparation.closeError);
        }
        closes.push(_body);
        document.state = "closed";
      }
      if (path.endsWith("/page-failed")) {
        document.state = "error";
        document.engineFileId = null;
        document.previewUrl = "";
      }
      if (path.endsWith("/recover")) {
        document.state = "opening";
        document.dirty = false;
        document.engineFileId = "recovered_A";
        document.previewUrl = `http://127.0.0.1:39999/static/${getOfficeDocumentKind(name)}/pc.html?localFilePath=/workspace/${name}`;
      }
      return { document: { ...document } };
    },
  };
  let files: any;
  const dockStates: any[] = [];
  const dock = {
    update: (state: any) => dockStates.push(state),
    prepareWindow: async () => {},
    dispose() {},
  };
  const panel = createOfficePanel({
    ...target,
    getWindow: () => main as any,
    getWindows: () => files.windows(),
    onDocumentClosed: (id: string) => files.documentClosed(id),
    resolveWindow: (sender: any) =>
      sender === main.webContents ? main : files.windowFor(sender),
    onOpenFile: (window: any, input: any) => {
      const operation = files.openDialog(window, input);
      opens.push(operation);
      return operation;
    },
    client,
    composer,
    resources:
      resources ??
      createOfficeResources({
        assetsDirectory: fileURLToPath(
          new URL("../../../desktop/resources/office-assets", import.meta.url),
        ),
        cacheDirectory: join(root, "fonts"),
      }),
  });
  const getAccess = mock((): { baseUrl: string; clientToken: string } | Promise<{ baseUrl: string; clientToken: string }> => ({
    baseUrl: "http://127.0.0.1:1234",
    clientToken: "fixture",
  }));
  files = createFileWindows({
    dock,
    client,
    getAccess,
    office: panel,
    getMainWindow: () => main,
    loadWindow,
    preloadPath: "fixture",
    iconPath: "fixture",
    recentPath: join(root, "recent.json"),
    ...conversationOptions,
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = {
    handle(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
  };
  panel.registerIpc(ipc as any);
  files.registerIpc(ipc as any);
  const call = (name: string, window: FakeWindow, ...args: any[]) =>
    handlers.get(name)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  const show = (window: FakeWindow) =>
    call("jugglework:office:show", window, {
      workspaceId: "ws",
      documentId: "od_A",
      bounds: { x: 0, y: 86, width: 1000, height: 700 },
    });
  const state = (window: FakeWindow) =>
    call("jugglework:file-window:state", window);
  const action = (window: FakeWindow, name: string, path?: string) =>
    call("jugglework:file-window:action", window, name, path);
  return {
    main,
    panel,
    files,
    document,
    saves,
    closes,
    creations,
    preparation,
    contexts,
    show,
    call,
    state,
    action,
    dockStates,
    transfer,
    opens,
    root,
    client,
    handlers,
    getAccess,
  };
}

test.each(["外部.docx", "外部.xlsx", "外部.csv", "外部.pptx"])("无聊天的 %s 保留文件页面，不显示不可用的原生 AI 编辑入口", async (name) => {
  const attached: Array<{ selectionUi: boolean }> = [];
  const resources = { attach: (_partition: unknown, host: { selectionUi: boolean }) => {
    attached.push(host);
    return { dispose() {} };
  } };
  const f = await fixture(name, undefined, undefined, resources, { request: mock(async () => ({})) });
  f.document.ownerSessionId = "file-browser";
  await f.show(f.main);
  expect(attached).toHaveLength(1);
  expect(attached[0].selectionUi).toBe(false);
  expect(f.main.children.size).toBe(1);
  const view = [...f.main.children][0];
  expect(view.webContents.loads).toEqual([f.document.previewUrl]);
  const result = await f.handlers.get("jugglework:office:selection-capture")!({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { captureId: "external" });
  expect(result.error.message).toContain("添加到目标聊天");
});

test("conversation requires a real existing local session and trusted policy; navigation uses only the Main binding", async () => {
  let policy: unknown = { allowCustomProviders: false, allowedModels: ["provider/model"], clientToken: "forbidden" };
  const navigations: unknown[] = [];
  const f = await fixture("notes.md", undefined, undefined, undefined, undefined, {
    getDesktopConfig: async () => policy,
    openSession: async (target: unknown) => { navigations.push(target); },
  });
  const original = f.client.getJson;
  f.client.getJson = async (path) => path.endsWith("/sessions/ses") ? { item: { id: "ses" } } as any : original(path);
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "notes.md" });
  const window = f.files.windows()[0];
  expect((await f.state(window)).conversation).toEqual({ desktopConfig: { allowCustomProviders: false, allowedModels: ["provider/model"] } });
  expect(JSON.stringify(window.webContents.messages)).not.toContain("forbidden");
  await f.action(window, "open-session");
  expect(navigations).toEqual([{ workspaceId: "ws", sessionId: "ses" }]);
  await expect(f.action(window, "open-session", "other-session")).rejects.toThrow();
  policy = null;
  expect(await f.state(window)).not.toHaveProperty("conversation");
  await expect(f.action(window, "open-session")).rejects.toThrow();
  policy = {};
  expect((await f.state(window)).conversation).toEqual({ desktopConfig: {} });
  f.client.getJson = async (path) => path.endsWith("/sessions/ses") ? { item: { id: "other" } } as any : original(path);
  expect(await f.state(window)).not.toHaveProperty("conversation");
  f.files.dispose(); f.panel.destroy();
});

test.each([false, true])("文件选区绑定真实会话（外部文件=%s），Main 投递后才可校验/发送；关闭标签撤销能力", async (local) => {
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, { getDesktopConfig: async () => ({}) });
  const original = f.client.getJson;
  f.client.getJson = async (path) => path.endsWith("/sessions/ses") ? { item: { id: "ses" } } as any : original(path);
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "报告.docx", local, absolutePath: join(f.root, "报告.docx") });
  const window = f.files.windows()[0];
  const input = { action: "append", windowId: window.id, workspaceId: "ws", sessionId: "ses",
    reference: { referenceId: "real-ref", workspaceId: "ws", ownerSessionId: "ses", documentId: "od_A" } };
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const target = { workspaceId: "ws", sessionId: "ses", referenceIds: ["real-ref"] };
  expect(() => f.files.authorizeOfficeReferences(event, target)).toThrow();
  expect(f.files.officeComposerWindow({ ...input, sessionId: "foreign" })).toBeNull();
  expect(f.files.officeComposerWindow({ ...input, reference: { ...input.reference, documentId: "foreign" } })).toBeNull();
  expect(f.files.officeComposerWindow(input)).toBe(window);
  expect(() => f.files.authorizeOfficeReferences(event, target)).not.toThrow();
  expect(() => f.files.authorizeOfficeReferences({ ...event, senderFrame: {} }, target)).toThrow();
  expect(() => f.files.authorizeOfficeReferences(event, { ...target, referenceIds: ["forged"] })).toThrow();
  expect(f.files.officeComposerWindows("ws", "ses")).toEqual([window]);
  await f.action(window, "close", "报告.docx");
  expect(() => f.files.authorizeOfficeReferences(event, target)).toThrow();
  f.files.dispose(); f.panel.destroy();
});

test("原文补全绑定同一后台页面，页面换代或等待中销毁拒绝旧原文", async () => {
  const f = await fixture();
  await f.show(f.main);
  const view = [...f.main.children][0];
  view.webContents.evaluationResult = ["标题\u000b副标题"];
  const input = { workspaceId: "ws", documentId: "od_A", pageId: "page_A", ranges: [{ begin: 0, end: 6 }], version: 0 };
  await f.call("jugglework:office:hide", f.main, "od_A");
  expect(await f.panel.readText(input)).toEqual(["标题\u000b副标题"]);
  expect(await f.panel.readText({ ...input, pageId: "old" })).toBeNull();
  let release!: () => void;
  view.webContents.evaluationGate = () => new Promise<void>((resolve) => { release = resolve; });
  const pending = f.panel.readText(input);
  f.panel.destroy("od_A"); release();
  expect(await pending).toBeNull();
});

test("外部文件没有主窗口也可读取会话并停止真实运行", async () => {
  const f = await fixture("外部.csv", undefined, undefined, undefined, undefined, {
    getDesktopConfig: async () => ({}), getMainWindow: () => null,
  });
  const original = f.client.getJson;
  f.client.getJson = async (path) => path.endsWith("/sessions/ses") ? { item: { id: "ses" } } as any : original(path);
  const run = { workspaceId: "ws", sessionId: "ses", runId: "run" };
  let aborts = 0;
  try {
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "外部.csv", local: true, absolutePath: join(f.root, "外部.csv") });
    const window = f.files.windows()[0];
    expect(await f.state(window)).toMatchObject({ local: true, workspaceRoot: f.root, conversation: { desktopConfig: {} } });
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    await f.files.fetch(event, "http://127.0.0.1:1234/workspace/ws/sessions/ses/runs/run/abort",
      { method: "POST", body: JSON.stringify({ abortCommandCorrelationId: null }) },
      async (_url: string, init: RequestInit) => {
        if (init.method === "GET") return Response.json({ items: [run] });
        aborts++;
        return Response.json({ run, abortRequested: true });
      });
    expect(aborts).toBe(1);
    expect(f.main.webContents.messages.some((message) => message.name === "jugglework:file-window:session-stop-request")).toBe(false);
  } finally { f.files.dispose(); f.panel.destroy(); }
});

test("file Stop waits for the real Main top-frame queue acknowledgement for its fixed session before abort", async () => {
  const f = await fixture("notes.md", undefined, undefined, undefined, undefined, { getDesktopConfig: async () => ({}) });
  const original = f.client.getJson;
  f.client.getJson = async (path) => path.endsWith("/sessions/ses") ? { item: { id: "ses" } } as any : original(path);
  const run = { workspaceId: "ws", sessionId: "ses", runId: "run" };
  let posts = 0;
  const transport = async (_url: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json({ items: [run] });
    posts++;
    return Response.json({ run, abortRequested: true });
  };
  const target = "http://127.0.0.1:1234/workspace/ws/sessions/ses/runs/run/abort";
  const body = { method: "POST", body: JSON.stringify({ abortCommandCorrelationId: null }) };
  try {
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "notes.md" });
    const window = f.files.windows()[0];
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    let notified!: (value: any) => void;
    let request = new Promise<any>((resolve) => { notified = resolve; });
    const send = f.main.webContents.send.bind(f.main.webContents);
    f.main.webContents.send = (name, value) => { send(name, value); if (name === "jugglework:file-window:session-stop-request") notified(value); };
    const stop = f.files.fetch(event, target, body, transport);
    const input = await request;
    expect(input).toEqual({ requestId: expect.any(String), workspaceId: "ws", sessionId: "ses" });
    expect(posts).toBe(0);
    const reply = { requestId: input.requestId, ok: true, sessionId: "foreign" };
    await expect(f.call("jugglework:file-window:session-stop-reply", window, reply)).rejects.toThrow();
    await expect(f.handlers.get("jugglework:file-window:session-stop-reply")!({ sender: f.main.webContents, senderFrame: {} }, reply)).rejects.toThrow();
    expect(posts).toBe(0);
    await f.call("jugglework:file-window:session-stop-reply", f.main, reply);
    await stop;
    expect(posts).toBe(1);
    await expect(f.call("jugglework:file-window:session-stop-reply", f.main, reply)).rejects.toThrow();
    await expect(f.files.fetch(event, target.replace("/ses/", "/foreign/"), body, transport)).rejects.toThrow();
    expect(posts).toBe(1);
    request = new Promise<any>((resolve) => { notified = resolve; });
    const failed = f.files.fetch(event, target, body, transport);
    const failure = failed.then(() => { throw new Error("failed preparation unexpectedly aborted"); }, () => {});
    const failedInput = await request;
    await f.call("jugglework:file-window:session-stop-reply", f.main, { requestId: failedInput.requestId, ok: false });
    await failure;
    expect(posts).toBe(1);
    request = new Promise<any>((resolve) => { notified = resolve; });
    const expiring = f.files.fetch(event, target, { ...body, timeoutMs: 20 }, transport);
    const expired = expiring.then(() => { throw new Error("unacknowledged Stop unexpectedly succeeded"); }, () => {});
    const timedInput = await request;
    await expired;
    await expect(f.call("jugglework:file-window:session-stop-reply", f.main, { requestId: timedInput.requestId, ok: true })).rejects.toThrow();
    expect(posts).toBe(1);
    // Closing while awaiting Main cancels the request; a late ack cannot send abort.
    request = new Promise<any>((resolve) => { notified = resolve; });
    const closing = f.files.fetch(event, target, body, transport);
    const rejected = closing.then(() => { throw new Error("closed Stop unexpectedly succeeded"); }, () => {});
    const pending = await request;
    window.destroy();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([rejected, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("closed Stop did not cancel")), 500); })]); }
    finally { clearTimeout(deadline); }
    await expect(f.call("jugglework:file-window:session-stop-reply", f.main, { requestId: pending.requestId, ok: true })).rejects.toThrow();
    expect(posts).toBe(1);
  } finally { f.files.dispose(); f.panel.destroy(); }
});

test("conversation seed is Main-only, first-open-only and survives live policy refresh", async () => {
  let policy = {};
  let initial: any;
  const f = await fixture("notes.md", async (window) => { initial = await f.state(window); }, undefined, undefined, undefined, { getDesktopConfig: async () => policy });
  const original = f.client.getJson;
  f.client.getJson = async (path) => path.endsWith("/sessions/ses") ? { item: { id: "ses" } } as any : original(path);
  const target = { workspaceId: "ws", sessionId: "ses", path: "notes.md" };
  const seed = { model: { providerID: "provider", modelID: "model" }, agent: "plan", variant: "high" };
  try {
    await expect(f.call("jugglework:file-window:open", f.main, { ...target, conversationOptions: { token: "forbidden" } })).rejects.toThrow();
    expect(f.files.windows()).toHaveLength(0);
    const subframe = { sender: f.main.webContents, senderFrame: { parent: f.main.webContents.mainFrame } };
    await expect(f.handlers.get("jugglework:file-window:open")!(subframe, { ...target, conversationOptions: seed })).rejects.toThrow();
    await f.call("jugglework:file-window:open", f.main, { ...target, conversationOptions: seed });
    const window = f.files.windows()[0];
    expect(initial.conversation).toEqual({ ...seed, desktopConfig: {} });
    // A file renderer cannot replace the seed, even with forged extra fields.
    await f.call("jugglework:file-window:open", window, { ...target, conversationOptions: { model: null, agent: "build", token: "forbidden" } });
    // Re-opening from Main also preserves the live file window's own choices.
    await f.call("jugglework:file-window:open", f.main, { ...target, conversationOptions: { model: null, agent: null, variant: null } });
    policy = { allowedModels: ["other/model"] };
    expect((await f.state(window)).conversation).toEqual({ ...seed, desktopConfig: policy });
    expect(JSON.stringify(window.webContents.messages)).not.toContain("forbidden");
    await expect(f.call("jugglework:file-window:open", window, { ...target, sessionId: "foreign", conversationOptions: seed })).rejects.toThrow();
    f.files.dispose();
    await f.call("jugglework:file-window:open", f.main, { ...target, conversationOptions: { model: null, agent: null, variant: null } });
    expect((await f.state(f.files.windows()[0])).conversation).toEqual({ model: null, agent: null, variant: null, desktopConfig: policy });
  } finally { f.files.dispose(); f.panel.destroy(); }
});

test("conversation refresh publishes policy transitions only, enforces latest policy on start and revokes invalid sessions", async () => {
  let config: unknown = { allowedModels: ["provider/model"], allowCustomProviders: false };
  const f = await fixture("notes.md", undefined, undefined, undefined, undefined, { getDesktopConfig: async () => config });
  const original = f.client.getJson;
  let valid = true;
  f.client.getJson = async (path) => path.endsWith("/sessions/ses") ? { item: { id: valid ? "ses" : "foreign" } } as any : original(path);
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "notes.md" });
  const window = f.files.windows()[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const changes = () => window.webContents.messages.filter((message: any) => message.name === "jugglework:file-window:changed");
  const before = changes().length;
  await f.state(window); await f.state(window);
  expect(changes().length).toBe(before);
  let posts = 0;
  const transport = async (url: string, init: RequestInit) => {
    if (init.method === "GET") {
      expect(url).toEndWith("/opencode/provider");
      return Response.json({ all: [{ id: "provider", source: "api", models: { model: { id: "model" } } }], connected: ["provider"] });
    }
    posts++;
    return Response.json({ run: { workspaceId: "ws", sessionId: "ses", runId: "run" } });
  };
  const body = { method: "POST", body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: null,
    prompt: { model: { providerID: "provider", modelID: "model" }, parts: [{ type: "text", text: "hello" }] } }) };
  const url = "http://127.0.0.1:1234/workspace/ws/sessions/ses/runs/start";
  await f.files.fetch(event, url, body, transport);
  config = { allowedModels: ["other/model"], allowCustomProviders: false };
  await expect(f.files.fetch(event, url, body, transport)).rejects.toThrow();
  expect(posts).toBe(1);
  expect(changes().length).toBe(before + 1);
  expect(changes().at(-1)?.value.conversation.desktopConfig).toEqual(config);
  await f.state(window);
  expect(changes().length).toBe(before + 1);
  valid = false;
  expect(await f.state(window)).not.toHaveProperty("conversation");
  expect(changes().length).toBe(before + 2);
  expect(changes().at(-1)?.value).not.toHaveProperty("conversation");
  await f.state(window);
  expect(changes().length).toBe(before + 2);
  await expect(f.files.fetch(event, url, body, transport)).rejects.toThrow();
  expect(posts).toBe(1);
  f.files.dispose(); f.panel.destroy();
});

test.each(["config", "session"])("reopening the same file window recovers a temporary %s failure and still fails closed", async (source) => {
  let failing = false;
  const policy = { allowCustomProviders: false, allowedModels: ["provider/model"] };
  const f = await fixture("notes.md", undefined, undefined, undefined, undefined, {
    getDesktopConfig: async () => {
      if (failing && source === "config") throw new Error("temporary policy read failure");
      return policy;
    },
  });
  const original = f.client.getJson;
  f.client.getJson = async (path) => {
    if (!path.endsWith("/sessions/ses")) return original(path);
    if (failing && source === "session") throw new Error("temporary session read failure");
    return { item: { id: "ses" } } as any;
  };
  const target = { workspaceId: "ws", sessionId: "ses", path: "notes.md" };
  const seed = { agent: "plan", model: { providerID: "provider", modelID: "model" }, variant: "high" };
  try {
    await f.call("jugglework:file-window:open", f.main, { ...target, conversationOptions: seed });
    const window = f.files.windows()[0];
    failing = true;
    await f.call("jugglework:file-window:open", f.main, target);
    expect(window.webContents.messages.filter((message: any) => message.name.endsWith(":changed")).at(-1)?.value).not.toHaveProperty("conversation");
    await expect(f.action(window, "open-session")).rejects.toThrow();
    const transport = mock(async () => Response.json({}));
    await expect(f.files.fetch({ sender: window.webContents, senderFrame: window.webContents.mainFrame },
      "http://127.0.0.1:1234/workspace/ws/sessions/ses/snapshot", {}, transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    failing = false;
    // Do not call state(): the ordinary Main reopen must refresh the existing entry.
    await f.call("jugglework:file-window:open", f.main, target);
    expect(f.files.windows()).toEqual([window]);
    expect(window.webContents.messages.filter((message: any) => message.name.endsWith(":changed")).at(-1)?.value.conversation).toEqual({ ...seed, desktopConfig: policy });
  } finally { f.files.dispose(); f.panel.destroy(); }
});

test("未绑定真实会话的外部文件保持文件模式", async () => {
  const policy = mock(async () => ({}));
  const f = await fixture("notes.md", undefined, undefined, undefined, undefined, { getDesktopConfig: policy });
  await f.files.open({ workspaceId: "ws", sessionId: "", path: "notes.md" });
  expect(await f.state(f.files.windows()[0])).not.toHaveProperty("conversation");
  await f.files.open({ workspaceId: "ws", sessionId: "external-file", local: true, absolutePath: join(f.root, "notes.md"), path: "notes.md" });
  const local = f.files.windows()[1];
  expect((await f.state(local)).local).toBe(true);
  expect(await f.state(local)).not.toHaveProperty("conversation");
  await expect(f.call("jugglework:file-window:session-subscribe", local)).rejects.toThrow();
  const original = f.client.getJson;
  const before = policy.mock.calls.length;
  f.client.getJson = async (path) => path === "/workspaces" ? { items: [{ id: "remote", workspaceType: "remote", path: f.root }] } as any : original(path);
  await expect(f.files.open({ workspaceId: "remote", sessionId: "ses", path: "notes.md" })).rejects.toThrow("工作区不可用");
  expect(policy.mock.calls.length).toBe(before);
  f.files.dispose(); f.panel.destroy();
});

test.each(["closed", "dispose", "unsubscribe", "render-process-gone"])(
  "real HTTP SSE is filtered at Main and cancelled on %s",
  async (ending) => {
    let closeConnection!: () => void;
    const closed = new Promise<void>((resolve) => { closeConnection = resolve; });
    let received!: () => void;
    const eventReceived = new Promise<void>((resolve) => { received = resolve; });
    const server = createServer((request, response) => {
      expect(request.url).toBe("/workspace/ws/opencode/event");
      expect(request.headers.authorization).toBe("Bearer main-private");
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const payload of [
        { type: "server.connected", properties: {} },
        { type: "message.part.delta", properties: { sessionID: "other", delta: "foreign" } },
        { type: "provider.updated", properties: { apiKey: "secret" } },
        { type: "message.part.delta", properties: { sessionID: "ses", delta: "bound" } },
      ]) response.write(`data: ${JSON.stringify({ payload })}\n\n`);
      request.socket.on("close", closeConnection);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const f = await fixture("notes.md", undefined, undefined, undefined, undefined, { getDesktopConfig: async () => ({}) });
    const original = f.client.getJson;
    f.client.getJson = async (path) => path.endsWith("/sessions/ses") ? { item: { id: "ses" } } as any : original(path);
    f.getAccess.mockImplementation(() => ({ baseUrl: `http://127.0.0.1:${address.port}`, clientToken: "main-private" }));
    try {
      await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "notes.md" });
      const window = f.files.windows()[0];
      const send = window.webContents.send.bind(window.webContents);
      window.webContents.send = (name: string, value: any) => {
        send(name, value);
        if (name === "jugglework:file-window:session-event" && value.event.type === "message.part.delta") received();
      };
      await expect(f.handlers.get("jugglework:file-window:session-subscribe")!({ sender: window.webContents, senderFrame: {} })).rejects.toThrow();
      const id = await f.call("jugglework:file-window:session-subscribe", window);
      const bounded = async (promise: Promise<void>, stage: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`SSE ${stage}: ${JSON.stringify(window.webContents.messages)}`)), 1000); })]); }
        finally { clearTimeout(timer); }
      };
      await bounded(eventReceived, "event");
      const events = window.webContents.messages.filter((message: any) => message.name.endsWith("session-event"));
      expect(events.map((message: any) => message.value.event.type)).toEqual(["server.connected", "message.part.delta"]);
      expect(JSON.stringify(events)).not.toMatch(/foreign|secret|main-private/);
      if (ending === "closed") window.destroy();
      else if (ending === "dispose") f.files.dispose();
      else if (ending === "unsubscribe") await f.call("jugglework:file-window:session-unsubscribe", window, id);
      else window.webContents.emit("render-process-gone");
      await bounded(closed, "close");
    } finally {
      f.files.dispose(); f.panel.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("window close aborts an in-flight buffered reader immediately", async () => {
  const f = await fixture("notes.md");
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "notes.md" });
  const window = f.files.windows()[0];
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  let cancelled = false;
  const task = f.files.fetch({ sender: window.webContents, senderFrame: window.webContents.mainFrame },
    "http://127.0.0.1:1234/workspace/ws/files/raw?path=notes.md", {}, async () => new Response(new ReadableStream({
      start() { started(); }, cancel() { cancelled = true; },
    })));
  const settled = task.then(() => null, (error: unknown) => error);
  await reading;
  await Promise.resolve();
  window.destroy();
  expect(await settled).toBeInstanceOf(Error);
  expect(cancelled).toBe(true);
  f.panel.destroy();
});

async function reviewFixture(failureCode = "office_selection_review_required") {
  const f = await fixture("报告.docx", undefined, undefined, undefined, { request: async () => ({ epoch: 1, bridgeGeneration: 0 }) });
  f.main.focus();
  await f.show(f.main);
  const view = [...f.main.children][0] as FakeView;
  const sender = view.webContents;
  const event = { sender, senderFrame: (sender as any).mainFrame };
  const requests: any[] = [], released: any[] = [], channels: string[] = [];
  const originalPost = f.client.postJson;
  f.client.postJson = async (path, body) => {
    if (path.endsWith("/selection-references")) {
      requests.push(body);
      channels.push("client");
      if (requests.length === 1) {
        const error = new ManagedRuntimeClientError("http_error", { serverCode: failureCode });
        error.status = 409;
        throw error;
      }
      return { reference: { referenceId: "ref", captureId: (body as any).captureId } } as any;
    }
    if (path.endsWith("/release")) { released.push(body); return { ok: true } as any; }
    return originalPost(path, body);
  };
  f.client.postHostJson = async (path, body, options) => {
    expect(path).toBe("/workspace/ws/office/od_A/selection-references/review-confirmed");
    expect(options?.signal?.aborted).toBe(false);
    requests.push(body); channels.push("host");
    return { reference: { referenceId: "ref", captureId: (body as any).captureId } };
  };
  const input = { captureId: "capture", expectedSelection: { ranges: [{ begin: 0, end: 2, length: 2 }], selectedText: "正文" }, reviewedUnconfirmed: true, expectedGeneration: "forged" };
  const capture = () => f.handlers.get("jugglework:office:selection-capture")!(event, input);
  const cancel = () => f.handlers.get("jugglework:office:selection-cancel")!(event, { captureId: input.captureId });
  return { ...f, view, sender, requests, released, channels, input, capture, cancel };
}

test("人工核对只认原生确认；忽略页面 reviewed 字段，同 capture 仅重试采集且不保存", async () => {
  const f = await reviewFixture();
  answers.review = async (options) => {
    await expect(f.capture()).rejects.toThrow("选区正在采集");
    expect(options).toMatchObject({
      message: "存在尚未核对的修改，请检查文档；确认保留当前内容后可重新选择继续编辑。",
      buttons: ["取消", "我已核对，保留并继续"], defaultId: 0, cancelId: 0,
    });
    expect(f.sender.messages.at(-1)).toEqual({ name: "jugglework:office:selection-review-pending", value: { captureId: "capture", pending: true } });
    return { response: 1 };
  };
  expect(await f.capture()).toMatchObject({ reference: { referenceId: "ref" } });
  expect(f.requests).toEqual([
    { sessionId: "ses", pageId: "page_A", captureId: "capture", expectedSelection: f.input.expectedSelection },
    { sessionId: "ses", pageId: "page_A", captureId: "capture", expectedSelection: f.input.expectedSelection, expectedGeneration: "page_A:actual_A" },
  ]);
  expect(f.channels).toEqual(["client", "host"]);
  expect(f.sender.messages.at(-1)?.value).toEqual({ captureId: "capture", pending: false });
  expect(f.saves).toEqual([]);
  await f.cancel();
  f.panel.destroy();
});

test("running 失败不弹人工核对，也不能被页面确认参数授权", async () => {
  const f = await reviewFixture("office_selection_save_blocked");
  let dialogs = 0;
  answers.review = async () => { dialogs++; return { response: 1 }; };
  expect(await f.capture()).toMatchObject({ error: { message: "文档选区操作仍在运行或尚未核对，请结束后重新选择" } });
  expect(dialogs).toBe(0);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).not.toHaveProperty("reviewedUnconfirmed");
  f.panel.destroy();
});

test("native host 客户端缺失时确认不能回退到普通 client capture", async () => {
  const f = await reviewFixture();
  f.client.postHostJson = undefined;
  answers.review = async () => ({ response: 1 });
  await expect(f.capture()).rejects.toThrow("本机核对服务不可用");
  expect(f.channels).toEqual(["client"]);
  expect(f.saves).toEqual([]);
  f.panel.destroy();
});

test("确认后的 capture 证明失败只返回本地错误，不循环弹框或再次重试", async () => {
  const f = await reviewFixture();
  let dialogs = 0;
  answers.review = async () => { dialogs++; return { response: 1 }; };
  const original = f.client.postHostJson!;
  f.client.postHostJson = async (path, body, options) => {
    await original(path, body, options);
    const error = new ManagedRuntimeClientError("http_error", { serverCode: "office_selection_stale" });
    error.status = 409;
    throw error;
  };
  expect(await f.capture()).toMatchObject({ error: { message: "选区已变化，请重新选择内容" } });
  expect(f.requests).toHaveLength(2);
  expect(dialogs).toBe(1);
  expect(f.saves).toEqual([]);
  f.panel.destroy();
});

for (const interruption of ["dialog-cancel", "cancel", "hide", "navigate", "host-navigate", "external-app", "other-window", "unfocused", "model-before-dialog", "model-in-dialog", "page-in-dialog", "late-result"] as const)
  test(`核对 ${interruption} 不复活原 capture`, async () => {
    const f = await reviewFixture();
    let dialogs = 0;
    if (interruption === "model-before-dialog") f.document.pageId = "replacement";
    answers.review = async (options) => {
      dialogs++;
      if (interruption === "cancel") await f.cancel();
      if (interruption === "hide") await f.call("jugglework:office:hide", f.main, "od_A");
      if (interruption === "navigate") f.sender.emit("did-start-navigation", {}, "http://other", false, true);
      if (interruption === "host-navigate") f.main.webContents.emit("did-start-navigation", {}, "http://other", false, true);
      if (interruption === "model-in-dialog") f.document.engineFileId = "replacement";
      if (interruption === "page-in-dialog") f.document.pageId = "replacement";
      if (interruption === "external-app") nativeApp.emit("did-resign-active");
      if (interruption === "other-window") nativeApp.emit("browser-window-focus", {}, new FakeWindow());
      if (interruption === "unfocused") f.main.focused = false;
      if (["cancel", "hide", "navigate", "host-navigate", "external-app", "other-window"].includes(interruption)) expect(options.signal.aborted).toBe(true);
      return { response: interruption === "dialog-cancel" ? 0 : 1 };
    };
    if (interruption === "late-result") {
      const original = f.client.postHostJson!;
      f.client.postHostJson = async (path, body, options) => {
        const result = await original(path, body, options);
        await f.cancel();
        return result;
      };
    }
    await expect(f.capture()).rejects.toThrow();
    expect(f.requests).toHaveLength(interruption === "late-result" ? 2 : 1);
    expect(f.channels).toEqual(interruption === "late-result" ? ["client", "host"] : ["client"]);
    expect(dialogs).toBe(interruption === "model-before-dialog" ? 0 : 1);
    expect(f.released).toHaveLength(interruption === "late-result" ? 1 : 0);
    expect(f.saves).toEqual([]);
    expect(nativeApp.listenerCount("did-resign-active")).toBe(0);
    f.panel.destroy();
  });

test("主窗口和独立窗口的实际 preload 均向编辑容器传递布局失效，并能释放订阅", () => {
  expect(rendererBridges).toHaveLength(2);
  for (const bridge of rendererBridges) {
    let refreshes = 0;
    const stop = bridge.office.onLayoutInvalidated(() => {
      refreshes++;
    });
    rendererIpc.emit("jugglework:office:layout-invalidated", {});
    expect(refreshes).toBe(1);
    stop();
    rendererIpc.emit("jugglework:office:layout-invalidated", {});
    expect(refreshes).toBe(1);
  }
  expect(
    rendererIpc.listenerCount("jugglework:office:layout-invalidated"),
  ).toBe(0);
});

test.each(["available", "open", "state", "create", "action"])(
  "file-window:%s 仅接受登记宿主的真实顶层 frame，拒绝子 frame、伪造 sender 和失效窗口",
  async (name) => {
    const f = await fixture("说明.md");
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "说明.md" });
    const window = f.files.windows()[0] as FakeWindow;
    const unknown = new FakeWindow();
    const events: Array<{ sender: FakeContents; senderFrame?: unknown }> = [];
    for (const host of [f.main, window]) {
      const sender = host.webContents;
      const forged = new FakeContents();
      forged.id = sender.id;
      const copiedFrame = new FakeContents();
      copiedFrame.id = sender.id;
      copiedFrame.mainFrame = sender.mainFrame;
      events.push(
        { sender, senderFrame: { parent: sender.mainFrame } },
        { sender, senderFrame: { ...sender.mainFrame } },
        { sender, senderFrame: unknown.webContents.mainFrame },
        { sender },
        { sender, senderFrame: null },
        { sender: forged, senderFrame: forged.mainFrame },
        { sender: copiedFrame, senderFrame: sender.mainFrame },
      );
      expect(f.files.windowFor(forged)).toBeNull();
      expect(f.files.windowFor(copiedFrame)).toBeNull();
    }
    events.push({ sender: unknown.webContents, senderFrame: unknown.webContents.mainFrame });
    if (name === "state" || name === "action")
      events.push({ sender: f.main.webContents, senderFrame: f.main.webContents.mainFrame });
    const args = name === "action"
      ? ["open"]
      : [{ workspaceId: "ws", sessionId: "ses", path: "新文件.md", kind: "docx" }];
    const getJson = mock(f.client.getJson);
    const postJson = mock(f.client.postJson);
    f.client.getJson = getJson;
    f.client.postJson = postJson;
    answers.open = { canceled: false, filePaths: [join(f.root, "新文件.md")] };
    answers.save = { canceled: false, filePath: join(f.root, "新文件.docx") };
    const messages = window.webContents.messages.length;
    const dockUpdates = f.dockStates.length;
    const handler = f.handlers.get(`jugglework:file-window:${name}`)!;
    for (const event of events)
      await expect(Promise.resolve().then(() => handler(event, ...args))).rejects.toThrow();
    // 缺少 mainFrame 时也不能因 undefined === undefined 被当作顶层页面。
    const mainFrame = f.main.webContents.mainFrame;
    Object.assign(f.main.webContents, { mainFrame: undefined });
    await expect(Promise.resolve().then(() => handler({ sender: f.main.webContents }, ...args))).rejects.toThrow();
    f.main.webContents.mainFrame = mainFrame;
    // 已销毁的 webContents 即使所属 BrowserWindow 仍登记也不可使用。
    window.webContents.close();
    expect(f.files.windowFor(window.webContents)).toBeNull();
    await expect(Promise.resolve().then(() => handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args))).rejects.toThrow();
    window.destroy();
    f.main.destroy();
    for (const host of [f.main, window])
      await expect(Promise.resolve().then(() => handler({ sender: host.webContents, senderFrame: host.webContents.mainFrame }, ...args))).rejects.toThrow();
    expect(getJson).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
    expect(f.getAccess).not.toHaveBeenCalled();
    expect(answers.dialogs).toEqual([]);
    expect(window.webContents.messages).toHaveLength(messages);
    expect(f.dockStates).toHaveLength(dockUpdates + 1);
    expect(f.creations).toEqual([]);
    f.panel.destroy();
  },
);

test.each(["open", "create"])(
  "文件窗口 %s 绑定 entry 的 workspace/session，越界参数在服务请求和对话框之前拒绝",
  async (name) => {
    const f = await fixture("说明.md");
    await f.call("jugglework:file-window:open", f.main, {
      workspaceId: "ws", sessionId: "ses", path: "说明.md",
    });
    const window = f.files.windows()[0];
    expect(await f.call("jugglework:file-window:available", window)).toBe(true);
    const getJson = mock(f.client.getJson);
    const postJson = mock(f.client.postJson);
    f.client.getJson = getJson;
    f.client.postJson = postJson;
    answers.save = { canceled: false, filePath: join(f.root, "新文件.docx") };
    for (const context of [
      { workspaceId: "other", sessionId: "ses" },
      { workspaceId: "ws", sessionId: "other" },
      { workspaceId: "other", sessionId: "other" },
      { workspaceId: "ws" },
      { sessionId: "ses" },
      {},
    ])
      await expect(f.call(`jugglework:file-window:${name}`, window, {
        ...context, path: "新文件.md", kind: "docx",
      })).rejects.toThrow("文件窗口工作区或聊天不匹配");
    expect(getJson).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
    expect(answers.dialogs).toEqual([]);
    expect(f.creations).toEqual([]);
    expect(f.files.windows()).toEqual([window]);
    expect((await f.state(window)).tabs.map((tab: any) => tab.path)).toEqual(["说明.md"]);
    await f.call(`jugglework:file-window:${name}`, window, {
      workspaceId: "ws", sessionId: "ses", path: "新文件.md", kind: "docx",
    });
    if (name === "open") {
      expect(f.files.windows()).toEqual([window]);
      expect((await f.state(window)).activePath).toBe("新文件.md");
    } else {
      expect(f.creations).toEqual([{
        path: "/workspace/ws/office/create",
        body: { sessionId: "ses", path: "新文件.docx" },
      }]);
    }
    f.files.dispose();
    f.panel.destroy();
  },
);

test("Word/PPTX 创建桥由宿主解析路径，取消不请求服务，越界目标被拒绝", async () => {
  const f = await fixture();
  expect(rendererBridges.every((bridge) => typeof bridge.fileWindow.create === "function")).toBe(true);
  expect(await f.call("jugglework:file-window:create", f.main, {
    workspaceId: "ws",
    sessionId: "ses",
    kind: "pptx",
  })).toBeNull();
  expect(f.creations).toEqual([]);

  answers.save = {
    canceled: false,
    filePath: join(f.root, "slides", "计划.pptx"),
  };
  expect(await f.call("jugglework:file-window:create", f.main, {
    workspaceId: "ws",
    sessionId: "ses",
    kind: "pptx",
  })).toEqual({ path: "slides/计划.pptx" });
  expect(f.creations).toEqual([{
    path: "/workspace/ws/office/create",
    body: { sessionId: "ses", path: "slides/计划.pptx" },
  }]);

  answers.save = {
    canceled: false,
    filePath: join(f.root, "..", "外部.docx"),
  };
  await expect(f.call("jugglework:file-window:create", f.main, {
    workspaceId: "ws",
    sessionId: "ses",
    kind: "docx",
  })).rejects.toThrow("请选择当前工作区中的文件");
  expect(f.creations).toHaveLength(1);

  answers.save = {
    canceled: false,
    filePath: join(f.root, "扩展名不符.docx"),
  };
  await expect(f.call("jugglework:file-window:create", f.main, {
    workspaceId: "ws",
    sessionId: "ses",
    kind: "pptx",
  })).rejects.toThrow("请选择 .pptx 文件");
  expect(f.creations).toHaveLength(1);
});

test("文件窗口创建 PPTX 后可通过现有打开动作成为 Office 标签", async () => {
  const f = await fixture("汇报.pptx");
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "汇报.pptx" });
  const window = f.files.windows()[0];
  answers.save = {
    canceled: false,
    filePath: join(f.root, "新汇报.pptx"),
  };
  const created = await f.call("jugglework:file-window:create", window, {
    workspaceId: "ws",
    sessionId: "ses",
    kind: "pptx",
  });
  await f.action(window, "open", created.path);
  expect(await f.state(window)).toMatchObject({
    activePath: "新汇报.pptx",
    tabs: [
      { path: "汇报.pptx", documentId: "od_A" },
      { path: "新汇报.pptx", documentId: "od_A" },
    ],
  });
  expect(f.creations.at(-1)).toEqual({
    path: "/workspace/ws/office/create",
    body: { sessionId: "ses", path: "新汇报.pptx" },
  });
});

test("三平台的两种宿主共用自动字体资源状态和网络边界，必需页面失败释放处理器并同步文档故障", async () => {
  for (const target of [
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
    { platform: "win32", arch: "x64" },
  ] as const) {
    for (const standalone of [false, true]) {
      const cache = await mkdtemp(join(tmpdir(), "office-resource-host-"));
      roots.push(cache);
      const resources = createOfficeResources({
        assetsDirectory: fileURLToPath(
          new URL("../../../desktop/resources/office-assets", import.meta.url),
        ),
        cacheDirectory: cache,
      });
      const f = await fixture("数据.csv", undefined, target, resources);
      if (standalone)
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.csv",
        });
      const host = standalone ? f.files.windows()[0] : f.main;
      await f.show(host);
      const partition = partitions.get("office-od_A");
      expect(partition.protocol.handlers.size).toBe(2);
      const networkGuard = partition.webRequest.listener;
      expect(typeof networkGuard).toBe("function");
      expect(
        await f.call("jugglework:office:resources", host, {
          documentId: "od_A",
        }),
      ).toEqual({ fontFailures: 0, coreFailures: 0 });
      if (target.arch === "arm64" && !standalone) {
        const view = [...f.main.children][0];
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.csv",
        });
        await f.show(f.files.windows()[0]);
        expect([...f.files.windows()[0].children][0]).toBe(view);
        expect(partition.protocol.handlers.size).toBe(2);
        expect(partition.webRequest.listener).toBe(networkGuard);
      }
      partition.fetch = async () => new Response(null, { status: 404 });
      await partition.protocol.handler(
        new Request("http://127.0.0.1:39999/static/sheet/pc.html"),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.document.state).toBe("error");
      expect(partition.protocol.handlers.size).toBe(0);
      expect(partition.webRequest.listener).toBeNull();
      f.panel.destroy();
      f.files.dispose();
    }
  }
});

test("两种宿主刷新或宿主渲染崩溃时卸下旧页面，重新展示沿用未保存模型和网络边界", async () => {
  for (const standalone of [false, true]) {
    for (const event of ["did-start-navigation", "render-process-gone"]) {
      const f = await fixture("数据.csv");
      if (standalone)
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.csv",
        });
      const host = standalone ? f.files.windows()[0] : f.main;
      await f.show(host);
      const view = [...host.children][0];
      const guard = partitions.get("office-od_A").webRequest.listener;
      f.document.dirty = true;
      // 同页路由及子框架导航不影响当前文件页。
      host.webContents.emit(
        "did-start-navigation",
        {},
        "http://fixture/#/session",
        true,
        true,
      );
      host.webContents.emit(
        "did-start-navigation",
        {},
        "http://fixture/frame",
        false,
        false,
      );
      expect(host.children.has(view)).toBe(true);
      host.webContents.emit(event, {}, "http://fixture/", false, true);
      expect(host.children.size).toBe(0);
      expect(view.visible).toBe(false);
      expect(view.webContents.destroyed).toBe(false);
      host.emit("focus");
      expect(host.children.size).toBe(0);
      expect(host.webContents.messages.at(-1)?.name).toBe(
        "jugglework:office:layout-invalidated",
      );
      await f.show(host);
      expect([...host.children][0]).toBe(view);
      expect(view.webContents.loads).toHaveLength(1);
      expect(f.document.dirty).toBe(true);
      expect(f.document.engineFileId).toBe("actual_A");
      expect(f.saves).toHaveLength(0);
      expect(partitions.get("office-od_A").webRequest.listener).toBe(guard);
      f.panel.destroy();
      expect(host.webContents.listenerCount("did-start-navigation")).toBe(standalone ? 1 : 0);
      expect(host.listenerCount("focus")).toBe(0);
      f.files.dispose();
    }
  }
});

test("宿主隐藏或最小化后不使用旧坐标恢复，只有当前面板重新确认后才显示原页面", async () => {
  for (const event of ["hide", "minimize"]) {
    const f = await fixture();
    await f.show(f.main);
    const view = [...f.main.children][0];
    f.document.dirty = true;
    f.main.visible = event !== "hide";
    f.main.minimized = event === "minimize";
    f.main.emit(event);
    expect(f.main.children.size).toBe(0);
    await f.show(f.main);
    expect(f.main.children.size).toBe(0);
    f.main.visible = true;
    f.main.minimized = false;
    f.main.emit(event === "hide" ? "show" : "restore");
    expect(f.main.children.size).toBe(0);
    await f.show(f.main);
    expect([...f.main.children][0]).toBe(view);
    f.main.emit("focus");
    expect([...f.main.children][0]).toBe(view);
    await f.show(f.main);
    expect([...f.main.children][0]).toBe(view);
    expect(f.document.dirty).toBe(true);
    f.panel.destroy();
  }
});

test.each([
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "win32", arch: "x64" },
] as const)(
  "$platform-$arch 两种宿主普通聚焦保留有效编辑视图，重测布局不抢聊天焦点",
  async (target) => {
    for (const standalone of [false, true]) {
      const f = await fixture("数据.xlsx", undefined, target);
      if (standalone)
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.xlsx",
        });
      const host = standalone ? f.files.windows()[0] : f.main;
      await f.show(host);
      const view = [...host.children][0];
      // TIPS: removeChildView 会丢失真实 Electron 的输入焦点，不能在 mock 中让卸载后自动恢复掩盖回归。
      let removals = 0;
      const remove = host.contentView.removeChildView;
      host.contentView.removeChildView = (child: any) => {
        removals++;
        remove(child);
      };
      const initialFocusCalls = view.webContents.focusCalls;
      for (const event of ["show", "restore", "focus"]) {
        host.emit(event);
        expect([...host.children][0]).toBe(view);
        expect(view.visible).toBe(true);
        expect(host.webContents.messages.at(-1)?.name).toBe(
          "jugglework:office:layout-invalidated",
        );
        await f.show(host);
        expect(view.webContents.focusCalls).toBe(initialFocusCalls);
      }
      expect(removals).toBe(0);
      expect(view.webContents.loads).toHaveLength(1);
      f.panel.destroy();
      f.files.dispose();
    }
  },
);

test.each([
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "win32", arch: "x64" },
] as const)(
  "$platform-$arch 恢复原编辑焦点，用户转向宿主输入后不再接管",
  async (target) => {
    for (const standalone of [false, true]) {
      const f = await fixture("数据.xlsx", undefined, target);
      if (standalone)
        await f.files.open({
          workspaceId: "ws",
          sessionId: "ses",
          path: "数据.xlsx",
        });
      const host = standalone ? f.files.windows()[0] : f.main;
      await f.show(host);
      const view = [...host.children][0];
      host.focused = true;
      view.webContents.emit("focus");
      host.emit("blur");
      // Electron 切回窗口时可以先聚焦宿主，再通知 BrowserWindow；不能误判为用户点击聊天。
      host.webContents.emit("focus");
      host.emit("focus");
      await f.show(host);
      expect(view.webContents.focusCalls).toBe(1);
      host.webContents.emit("focus");
      await f.show(host);
      expect(view.webContents.focusCalls).toBe(1);

      for (const [event, input] of [
        ["before-mouse-event", { type: "mouseDown" }],
        ["before-input-event", { type: "keyDown" }],
      ] as const) {
        view.webContents.emit("focus");
        host.emit("blur");
        host.webContents.emit(event, {}, input);
        host.emit("focus");
        await f.show(host);
        expect(view.webContents.focusCalls).toBe(1);
      }
      view.webContents.emit("focus");
      host.emit("blur");
      host.minimized = true;
      host.emit("minimize");
      // 隐藏页面的渲染层也会上报 hide，不能清掉窗口生命周期已保存的输入目标。
      await f.call("jugglework:office:hide", host, "od_A", false);
      host.minimized = false;
      host.emit("restore");
      host.webContents.emit("focus");
      host.emit("focus");
      await f.show(host);
      expect([...host.children][0]).toBe(view);
      expect(view.webContents.focusCalls).toBe(2);
      // 原页面关闭或导航后不保留待恢复焦点，新的聊天页面不能被旧文档接管。
      host.webContents.emit(
        "did-start-navigation",
        {},
        "http://fixture",
        false,
        true,
      );
      await f.show(host);
      expect(view.webContents.focusCalls).toBe(2);
      f.panel.destroy();
      expect(host.listenerCount("blur")).toBe(0);
      expect(host.webContents.listenerCount("focus")).toBe(0);
      expect(host.webContents.listenerCount("before-input-event")).toBe(0);
      expect(host.webContents.listenerCount("before-mouse-event")).toBe(0);
      f.files.dispose();
    }
  },
);

test("显式激活等待期间用户转向聊天输入，旧请求不能抢回焦点", async () => {
  const f = await fixture();
  f.main.focused = true;
  const original = f.client.postJson;
  const context = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  f.client.postJson = async (path: string, body: unknown) => {
    if (path.endsWith("/context")) {
      requested.resolve();
      await context.promise;
    }
    return original(path, body);
  };
  const showing = f.call("jugglework:office:show", f.main, {
    workspaceId: "ws",
    documentId: "od_A",
    activate: true,
    bounds: { x: 0, y: 86, width: 1000, height: 700 },
  });
  await requested.promise;
  const view = [...f.main.children][0];
  f.main.webContents.emit("before-input-event", {}, { type: "keyDown" });
  context.resolve();
  await showing;
  expect(view.visible).toBe(true);
  expect(view.webContents.focusCalls).toBe(0);
  f.panel.destroy();
});

test("刷新、隐藏或重新聚焦发生在文档查询期间，旧 show 返回不能重新挂载视图", async () => {
  for (const event of ["did-start-navigation", "hide", "focus"]) {
    const f = await fixture();
    let complete!: (value: any) => void;
    const getJson = f.client.getJson;
    f.client.getJson = (path: string) =>
      path.endsWith("/od_A")
        ? new Promise<any>((resolve) => {
            complete = resolve;
          })
        : getJson(path);
    const pending = f.show(f.main);
    if (event === "hide" || event === "focus") f.main.emit(event);
    else f.main.webContents.emit(event, {}, "http://fixture", false, true);
    complete({ document: { ...f.document } });
    await pending;
    expect(f.main.children.size).toBe(0);
    f.client.getJson = getJson;
    await f.show(f.main);
    expect(f.main.children.size).toBe(1);
    f.panel.destroy();
  }
});

test("四种 Office 格式独立窗口另存共用任务准备及目标保护，拒绝后不保存或复制", async () => {
  for (const name of ["报告.docx", "数据.csv", "预算.xlsx", "汇报.pptx"]) {
    const f = await fixture(name);
    const destination = join(f.root, "copy-" + name);
    await writeFile(join(f.root, name), "saved source");
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path: name });
    const window = f.files.windows()[0]!;
    for (const reason of ["任务运行中", "交付尚未完成"]) {
      f.preparation.error = reason;
      await expect(f.action(window, "save-copy")).rejects.toThrow(reason);
      await expect(access(destination)).rejects.toThrow();
      expect(f.saves).toEqual([]);
      expect(f.preparation.targets).toEqual([]);
    }
    f.preparation.error = null;
    answers.save = { canceled: false, filePath: destination };
    f.preparation.targetError = "目标文档仍在编辑";
    await expect(f.action(window, "save-copy")).rejects.toThrow("仍在编辑");
    await expect(access(destination)).rejects.toThrow();
    f.preparation.targetError = null;
    await f.action(window, "save-copy");
    expect(f.preparation.calls).toEqual(
      Array(4).fill({ sessionId: "ses", path: name }),
    );
    expect(f.preparation.targets).toEqual([
      { path: destination },
      { path: destination },
    ]);
    expect(await readFile(destination, "utf8")).toBe("saved source");
  }
});

for (const target of [
  { platform: "win32", arch: "x64" },
  { platform: "win32", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
] as const) {
  test(`${target.platform}-${target.arch} 首次独立打开可用，跨窗口迁移保留原页面并提示保存关闭`, async () => {
    for (const name of ["报告.docx", "数据.csv", "预算.xlsx", "汇报.pptx"]) {
      const f = await fixture(name, undefined, target);
      await f.show(f.main);
      const original = [...f.main.children][0];
      f.document.dirty = true;
      await expect(
        f.files.open({ workspaceId: "ws", sessionId: "ses", path: name }),
      ).rejects.toThrow("请先保存并关闭文档");
      expect(f.files.windows()).toHaveLength(0);
      expect([...f.main.children]).toEqual([original]);
      expect(original.visible).toBe(true);
      expect(original.webContents.loads).toHaveLength(1);
      expect(f.document).toMatchObject({
        dirty: true,
        engineFileId: "actual_A",
        state: "ready",
      });
      expect(f.transfer.checks).toBe(0);
      expect(f.saves).toEqual([]);

      const fresh = await fixture(name, undefined, target);
      await fresh.files.open({
        workspaceId: "ws",
        sessionId: "ses",
        path: name,
      });
      const window = fresh.files.windows()[0];
      expect(await fresh.show(window)).toEqual({ here: true });
      const page = [...window.children][0];
      await expect(
        fresh.call("jugglework:office:show", fresh.main, {
          workspaceId: "ws",
          documentId: "od_A",
          activate: true,
          bounds: { x: 0, y: 30, width: 600, height: 800 },
        }),
      ).rejects.toThrow("请先保存并关闭文档");
      expect([...window.children]).toEqual([page]);
      expect(() => fresh.panel.assign("od_A", fresh.main)).toThrow(
        "请先保存并关闭文档",
      );
      expect(fresh.saves).toEqual([]);
    }
  });
}

test("透视表只读文件可在独立窗口打开，不迁移原生模型；其他打开错误仍抛出", async () => {
  const f = await fixture("透视表.xlsx");
  answers.openError = "office_readonly_required";
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "透视表.xlsx",
  });
  const window = f.files.windows()[0];
  expect((await f.state(window)).tabs).toEqual([
    { path: "透视表.xlsx", name: "透视表.xlsx", readOnly: true },
  ]);
  expect(window.children.size).toBe(0);
  expect(f.saves).toEqual([]);
  answers.openError = "office_document_in_use";
  await expect(
    f.files.open({ workspaceId: "ws", sessionId: "ses", path: "其他.xlsx" }),
  ).rejects.toThrow("Open failed");
  expect((await f.state(window)).tabs).toHaveLength(1);
});

test("实时选区只读取所属可见页面，隐藏、旧代次及读取中销毁均不返回旧坐标", async () => {
  const f = await fixture("客户.csv");
  await f.show(f.main);
  const view = [...f.main.children][0] as FakeView;
  const input = {
    workspaceId: "ws",
    documentId: "od_A",
    pageId: f.document.pageId,
  };
  const value = { sheetId: "sheet_A", ranges: [] };
  view.webContents.evaluationResult = value;
  expect(await f.panel.readSelection(input)).toEqual(value);
  expect(
    await f.panel.readSelection({ ...input, workspaceId: "other" }),
  ).toBeNull();
  expect(await f.panel.readSelection({ ...input, pageId: "old" })).toBeNull();
  await f.call("jugglework:office:hide", f.main, "od_A");
  expect(await f.panel.readSelection(input)).toBeNull();
  await f.show(f.main);
  let release!: () => void;
  view.webContents.evaluationGate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = f.panel.readSelection(input);
  f.panel.destroy();
  release();
  expect(await pending).toBeNull();
});

test("打开独立窗口迁移同一存活页面，主面板不能抢回或隐藏新窗口的页面", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  f.document.dirty = true;
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  expect(f.main.children.size).toBe(0);
  expect([...window.children][0]).toBe(original);
  expect(original.webContents.loads).toHaveLength(1);
  expect(f.saves).toEqual([]);
  expect(await f.show(f.main)).toEqual({ here: false });
  await f.show(window);
  await f.call("jugglework:office:hide", f.main, "od_A");
  expect(original.visible).toBe(true);
  expect(f.document.dirty).toBe(true);
});

test("运行中取消等待不迁移页面，清理空窗口并保留 dirty 内容", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  f.document.dirty = true;
  f.transfer.reasons = ["running"];
  answers.wait = async () => ({ response: 0 });
  try {
    await f.files.open({
      workspaceId: "ws",
      sessionId: "ses",
      path: "报告.docx",
    });
    expect(f.files.windows()).toHaveLength(0);
    expect([...f.main.children]).toEqual([original]);
    expect(original.visible).toBe(true);
    expect(f.document.dirty).toBe(true);
    expect(f.transfer.checks).toBe(1);
    expect(f.saves).toEqual([]);
  } finally {
    answers.wait = undefined;
  }
});

test("运行和交付结束后迁移同一页面，等待期间保留原宿主", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  f.transfer.reasons = ["running", "finalizing", null];
  answers.wait = async (options) => {
    expect([...f.main.children]).toEqual([original]);
    return new Promise((resolve) =>
      options.signal.addEventListener("abort", () => resolve({ response: 0 }), {
        once: true,
      }),
    );
  };
  try {
    await f.files.open({
      workspaceId: "ws",
      sessionId: "ses",
      path: "报告.docx",
    });
    expect(f.transfer.checks).toBe(3);
    expect([...f.files.windows()[0].children]).toEqual([original]);
    expect(original.webContents.loads).toHaveLength(1);
    expect(f.saves).toEqual([]);
  } finally {
    answers.wait = undefined;
  }
});

test("输入法组合中阻止原生文档快捷键且不执行宿主动作，组合结束后仍能保存", async () => {
  const f = await fixture();
  await f.show(f.main);
  const contents = [...f.main.children][0].webContents;
  const prevented: string[] = [];
  for (const key of ["s", "w", "o"])
    contents.emit(
      "before-input-event",
      {
        preventDefault() {
          prevented.push(key);
        },
      },
      { meta: true, isComposing: true, type: "keyDown", key },
    );
  expect(prevented).toEqual(["s", "w", "o"]);
  expect(f.saves).toEqual([]);
  expect(f.opens).toEqual([]);
  expect(f.document.state).toBe("ready");
  contents.emit(
    "before-input-event",
    { preventDefault() {} },
    { meta: true, isComposing: false, type: "keyDown", key: "s" },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toHaveLength(1);
});

test("CSV 独立窗口与 Word 共用 Office 页面、模型迁移及保存", async () => {
  const f = await fixture("客户.csv");
  await f.show(f.main);
  const original = [...f.main.children][0];
  expect(original.webContents.loads[0]).toContain("/static/sheet/pc.html");
  expect(await f.call("jugglework:file-window:available", f.main)).toBe(true);
  await f.call("jugglework:file-window:open", f.main, {
    workspaceId: "ws",
    sessionId: "ses",
    path: "客户.csv",
  });
  const window = f.files.windows()[0];
  expect((await f.state(window)).tabs).toEqual([
    { path: "客户.csv", name: "客户.csv", documentId: "od_A" },
  ]);
  expect([...window.children][0]).toBe(original);
  expect(original.webContents.loads).toHaveLength(1);
  expect(await f.show(f.main)).toEqual({ here: false });
  f.document.dirty = true;
  original.webContents.emit(
    "before-input-event",
    { preventDefault() {} },
    { meta: true, type: "keyDown", key: "s" },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toEqual(["actual_A"]);
});

test("重挂失败恢复原宿主、可见性及页面，后续仍可迁移同一未保存模型", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  f.document.dirty = true;
  const target = new FakeWindow();
  const attach = target.contentView.addChildView;
  target.contentView.addChildView = () => {
    throw new Error("attach failed");
  };
  expect(() => f.panel.assign("od_A", target as any)).toThrow("attach failed");
  expect([...f.main.children]).toEqual([original]);
  expect(original.visible).toBe(true);
  expect(await f.show(f.main)).toEqual({ here: true });
  expect(original.webContents.loads).toHaveLength(1);
  expect(f.document.dirty).toBe(true);
  expect(f.saves).toEqual([]);
  target.contentView.addChildView = attach;
  f.panel.assign("od_A", target as any);
  expect([...target.children]).toEqual([original]);
  expect(await f.show(f.main)).toEqual({ here: false });
});

test("文件窗口页面准备失败时不迁移原生页，移除失败窗口并保留原宿主编辑", async () => {
  const f = await fixture("报告.docx", async () => {
    throw new Error("window load failed");
  });
  await f.show(f.main);
  const original = [...f.main.children][0];
  await expect(
    f.files.open({ workspaceId: "ws", sessionId: "ses", path: "报告.docx" }),
  ).rejects.toThrow("window load failed");
  expect(f.files.windows()).toHaveLength(0);
  expect([...f.main.children]).toEqual([original]);
  expect(original.visible).toBe(true);
  expect(original.webContents.loads).toHaveLength(1);
});

test("故障恢复取消保留页面，确认后两处收到同一文档身份并加载新页面", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  f.document.state = "error";
  f.document.dirty = true;
  answers.close = 1;
  expect(
    await f.call("jugglework:office:recover", window, {
      workspaceId: "ws",
      documentId: "od_A",
    }),
  ).toBeNull();
  expect(original.webContents.destroyed).toBe(false);
  expect(f.document.dirty).toBe(true);
  answers.close = 0;
  try {
    expect(
      await f.call("jugglework:office:recover", window, {
        workspaceId: "ws",
        documentId: "od_A",
      }),
    ).toMatchObject({ documentId: "od_A", state: "opening" });
    expect(original.webContents.destroyed).toBe(true);
    for (const host of [f.main, window])
      expect(
        host.webContents.messages.findLast(
          (message: any) => message.name === "jugglework:office:document",
        )?.value,
      ).toMatchObject({ documentId: "od_A", state: "opening" });
    expect((await f.state(window)).tabs[0].documentId).toBe("od_A");
    await f.show(window);
    const replacement = [...window.children][0];
    expect(replacement).not.toBe(original);
    original.webContents.emit("render-process-gone");
    expect([...window.children][0]).toBe(replacement);
    expect(replacement.webContents.destroyed).toBe(false);
    expect(await f.show(f.main)).toEqual({ here: false });
  } finally {
    answers.close = 2;
  }
});

for (const independent of [false, true])
  test(`原生页面崩溃同步两处故障状态，确认恢复复用文档标签且可重新注册协议 (${independent})`, async () => {
    const f = await fixture();
    await f.files.open({
      workspaceId: "ws",
      sessionId: "ses",
      path: "报告.docx",
    });
    const window = f.files.windows()[0];
    if (!independent) f.panel.assign("od_A", f.main as any);
    const host = independent ? window : f.main;
    await f.show(host);
    const original = [...host.children][0];
    original.webContents.emit("render-process-gone");
    await Promise.resolve();
    await Promise.resolve();
    expect(host.children.size).toBe(0);
    for (const target of [f.main, window])
      expect(
        target.webContents.messages.findLast(
          (item: any) => item.name === "jugglework:office:document",
        )?.value,
      ).toMatchObject({
        state: "error",
        documentId: "od_A",
        engineFileId: null,
      });
    expect((await f.state(window)).tabs[0].documentId).toBe("od_A");
    answers.close = 1;
    expect(
      await f.call("jugglework:office:recover", host, {
        workspaceId: "ws",
        documentId: "od_A",
      }),
    ).toBeNull();
    expect(f.document.state).toBe("error");
    answers.close = 0;
    try {
      await f.call("jugglework:office:recover", host, {
        workspaceId: "ws",
        documentId: "od_A",
      });
      expect(await f.show(host)).toEqual({ here: true });
      expect([...host.children][0]).not.toBe(original);
      original.webContents.emit("render-process-gone");
      expect(host.children.size).toBe(1);
    } finally {
      answers.close = 2;
    }
  });

test("页面加载失败同样转为可恢复故障，不能隐藏空白页后仍声称 ready", async () => {
  const f = await fixture();
  const load = FakeContents.prototype.loadURL;
  FakeContents.prototype.loadURL = async () => {
    throw new Error("load failed");
  };
  try {
    await f.show(f.main);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.document.state).toBe("error");
    expect(f.main.children.size).toBe(0);
    expect(f.main.webContents.messages.at(-1)).toMatchObject({
      name: "jugglework:office:document",
      value: { state: "error" },
    });
  } finally {
    FakeContents.prototype.loadURL = load;
  }
});

test("菜单使用页面快照遮挡原生视图，恢复后复用相同页面", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  const snapshot = await f.call("jugglework:office:hide", f.main, "od_A", true);
  expect(snapshot).toStartWith("data:image/png");
  expect(original.visible).toBe(false);
  expect(f.main.children.size).toBe(0);
  await f.show(f.main);
  expect(original.visible).toBe(true);
  expect(f.main.children.size).toBe(1);
  expect(original.webContents.loads).toHaveLength(1);
});

test("两处显示同一 Word 内容，显式点击可交接编辑页面而后台更新不能抢占", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  expect(await f.show(f.main)).toEqual({ here: false });
  expect(
    await f.call("jugglework:office:snapshot", f.main, "od_A"),
  ).toStartWith("data:image/png");
  expect(
    await f.call("jugglework:office:show", f.main, {
      workspaceId: "ws",
      documentId: "od_A",
      activate: true,
      bounds: { x: 0, y: 30, width: 600, height: 800 },
    }),
  ).toEqual({ here: true });
  expect([...f.main.children][0]).toBe(original);
  expect(original.webContents.loads).toHaveLength(1);
  expect(await f.show(window)).toEqual({ here: false });
  expect(f.document.engineFileId).toBe("actual_A");
});

test("重复打开激活已有窗口，关闭一个文件保留其他标签，最近文件不保存令牌", async () => {
  const f = await fixture();
  for (const path of ["报告.docx", "说明.md", "报告.docx"])
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path });
  expect(f.files.windows()).toHaveLength(1);
  const window = f.files.windows()[0];
  expect((await f.state(window)).tabs.map((tab: any) => tab.path)).toEqual([
    "报告.docx",
    "说明.md",
  ]);
  await f.action(window, "close", "说明.md");
  const state = await f.state(window);
  expect(state.tabs.map((tab: any) => tab.path)).toEqual(["报告.docx"]);
  expect(state.activePath).toBe("报告.docx");
  expect(window.title).toBe("JuggleWork 文件浏览器");
  expect(state.recent.map((tab: any) => tab.path)).toEqual([
    "报告.docx",
    "说明.md",
  ]);
});

test("关闭全部 tab 后保留文件浏览器主页和窗口归属，再打开复用原窗口", async () => {
  const f = await fixture();
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "报告.docx" });
  const window = f.files.windows()[0];
  await f.action(window, "close", "报告.docx");
  const home = await f.state(window);
  expect(home.tabs).toEqual([]);
  expect(home.activePath).toBeNull();
  expect(window.title).toBe("JuggleWork 文件浏览器");
  expect(window.isDestroyed()).toBe(false);
  // TIPS: macOS 菜单按宿主窗口归属命名，空白主页仍是文件窗口，不能按 tab 数量降级成聊天窗口。
  expect(f.files.windowFor(window.webContents)).toBe(window);
  expect(f.files.windowFor(f.main.webContents)).toBeNull();
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "说明.md" });
  expect(f.files.windows()).toEqual([window]);
  expect((await f.state(window)).activePath).toBe("说明.md");
});

test("原生编辑区的打开快捷键按当前宿主复用右侧或独立窗口标签，取消不改变文档", async () => {
  const f = await fixture();
  await f.show(f.main);
  const original = [...f.main.children][0];
  const pressOpen = async () => {
    original.webContents.emit(
      "before-input-event",
      { preventDefault() {} },
      {
        meta: true,
        type: "keyDown",
        key: "o",
      },
    );
    await Promise.all(f.opens);
  };
  await pressOpen();
  expect(f.main.webContents.messages).toEqual([]);
  answers.open = { canceled: false, filePaths: [join(f.root, "说明.md")] };
  await pressOpen();
  expect(f.main.webContents.messages.at(-1)).toMatchObject({
    name: "jugglework:file-window:open-in-panel",
    value: { workspaceId: "ws", sessionId: "ses", path: "说明.md" },
  });
  expect(f.files.windows()).toHaveLength(0);
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  await pressOpen();
  expect((await f.state(window)).tabs.map((tab: any) => tab.path)).toEqual([
    "报告.docx",
    "说明.md",
  ]);
  expect((await f.state(window)).activePath).toBe("说明.md");
  expect([...window.children][0]).toBe(original);
  expect(f.document.state).toBe("ready");
  expect(f.saves).toEqual([]);
});

test("dirty 文档取消关闭保留标签与页面，保存并关闭后才移除", async () => {
  const f = await fixture();
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  await f.show(window);
  f.document.dirty = true;
  answers.close = 2;
  await f.action(window, "close", "报告.docx");
  expect((await f.state(window)).tabs).toHaveLength(1);
  expect(window.children.size).toBe(1);
  answers.close = 0;
  await f.action(window, "close", "报告.docx");
  expect((await f.state(window)).tabs).toHaveLength(0);
  expect(window.children.size).toBe(0);
  answers.close = 2;
});

for (const name of ["报告.docx", "数据.csv", "预算.xlsx", "汇报.pptx"]) {
  test(`${name} 关闭前提交页面缓冲，最新修改必须由用户确认`, async () => {
    const f = await fixture(name);
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path: name });
    const window = f.files.windows()[0]!;
    await f.show(window);
    const page = [...window.children][0];
    // 模拟 native 尚未收到输入/重做，读取模型暂时为 clean。
    page.webContents.evaluationGate = async () => { f.document.dirty = true; };
    answers.close = 2;
    await f.action(window, "close", name);
    expect(f.document).toMatchObject({ state: "ready", dirty: true });
    expect((await f.state(window)).tabs).toHaveLength(1);
    expect(page.webContents.isDestroyed()).toBe(false);
    expect(f.saves).toEqual([]);
    expect(f.closes).toEqual([]);
    answers.close = 1;
    await f.action(window, "close", name);
    expect((await f.state(window)).tabs).toHaveLength(0);
    expect(page.webContents.isDestroyed()).toBe(true);
    expect(f.closes).toEqual([{ decision: "discard" }]);
    answers.close = 2;
  });
}

test("关闭前页面提交失败保留文档、标签和修改，不执行默认保存", async () => {
  const f = await fixture();
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "报告.docx" });
  const window = f.files.windows()[0]!;
  await f.show(window);
  const page = [...window.children][0];
  page.webContents.evaluationGate = async () => { throw new Error("文字尚未提交完成"); };
  await expect(f.action(window, "close", "报告.docx")).rejects.toThrow("文字尚未提交完成");
  expect(f.document.state).toBe("ready");
  expect((await f.state(window)).tabs).toHaveLength(1);
  expect(page.webContents.isDestroyed()).toBe(false);
  expect(f.saves).toEqual([]);
  expect(f.closes).toEqual([]);
});

test("已知 dirty 文档的页面提交失败不阻止用户明确放弃修改", async () => {
  const f = await fixture();
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: "报告.docx" });
  const window = f.files.windows()[0]!;
  await f.show(window);
  const page = [...window.children][0];
  f.document.dirty = true;
  page.webContents.evaluationGate = async () => { throw new Error("页面无法提交"); };
  try {
    answers.close = 2;
    await f.action(window, "close", "报告.docx");
    expect(f.document.state).toBe("ready");
    answers.close = 1;
    await f.action(window, "close", "报告.docx");
    expect(f.document.state).toBe("closed");
    expect(page.webContents.isDestroyed()).toBe(true);
    expect(f.saves).toEqual([]);
    expect(f.closes).toEqual([{ decision: "discard" }]);
  } finally {
    answers.close = 2;
  }
});

test("Dock 显示真实标题、激活原窗口，取消退出保留入口，清理窗口不重复调用已停止的服务", async () => {
  const f = await fixture();
  await f.files.open({
    workspaceId: "ws",
    sessionId: "ses",
    path: "报告.docx",
  });
  const window = f.files.windows()[0];
  expect(f.dockStates.at(-1)).toEqual([{ id: window.id, title: "报告.docx" }]);
  window.focused = false;
  f.files.activate(window.id);
  expect(window.focused).toBe(true);
  f.document.dirty = true;
  answers.close = 2;
  expect(await f.files.closeAll()).toBe(false);
  expect(f.files.windows()).toHaveLength(1);
  expect(window.destroyed).toBe(false);
  f.files.dispose();
  expect(f.files.windows()).toHaveLength(0);
  expect(f.dockStates.at(-1)).toEqual([]);
  expect(f.saves).toEqual([]);
});

for (const name of ["报告.docx", "数据.csv", "预算.xlsx", "汇报.pptx"]) {
  test(`${name} 更新退出取消或保存失败保留页面，成功关闭后才启动安装器`, async () => {
    const f = await fixture(name);
    await f.files.open({ workspaceId: "ws", sessionId: "ses", path: name });
    const window = f.files.windows()[0]!;
    await f.show(window);
    const page = [...window.children][0];
    f.document.dirty = true;
    const calls: string[] = [];
    const install = () =>
      triggerUpdaterInstall(
        { quitAndInstall: () => calls.push("install") },
        async () => {
          if (!(await f.panel.prepareQuit())) throw new Error("已取消更新");
          f.files.dispose();
          calls.push("runtime:stop");
        },
      );
    try {
      answers.close = 2;
      await expect(install()).rejects.toThrow("已取消更新");
      answers.close = 0;
      f.preparation.closeError = "文档保存失败";
      await expect(install()).rejects.toThrow("文档保存失败");
      expect(calls).toEqual([]);
      expect(f.files.windows()).toEqual([window]);
      expect([...window.children]).toEqual([page]);
      expect(page.webContents.isDestroyed()).toBe(false);
      expect(f.document).toMatchObject({ state: "ready", dirty: true });
      f.preparation.closeError = null;
      await install();
      expect(f.document.state).toBe("closed");
      expect(page.webContents.isDestroyed()).toBe(true);
      expect(f.files.windows()).toEqual([]);
      expect(calls).toEqual(["runtime:stop", "install"]);
    } finally {
      answers.close = 2;
    }
  });
}

for (const name of ["预算.xlsx", "汇报.pptx"]) {
  test(`${name} 的独立窗口复用对应原生页面与模型，迁移不重新加载`, async () => {
    const f = await fixture(name);
    await f.show(f.main);
    const original = [...f.main.children][0];
    expect(original.webContents.loads[0]).toContain(
      `/static/${getOfficeDocumentKind(name)}/pc.html`,
    );
    await f.call("jugglework:file-window:open", f.main, {
      workspaceId: "ws",
      sessionId: "ses",
      path: name,
    });
    const window = f.files.windows()[0];
    expect((await f.state(window)).tabs).toEqual([
      { path: name, name, documentId: "od_A" },
    ]);
    expect([...window.children][0]).toBe(original);
    expect(original.webContents.loads).toHaveLength(1);
    expect(await f.show(f.main)).toEqual({ here: false });
  });
}

test("保存页面确认绑定 workspace 和 pageId，等待中页面失效不能继续确认", async () => {
  const f = await fixture();
  await f.show(f.main);
  const view = [...f.main.children][0];
  await expect(
    f.panel.prepareSave({
      workspaceId: "other",
      documentId: "od_A",
      pageId: "page_A",
    }),
  ).rejects.toThrow("页面已失效");
  await expect(
    f.panel.prepareSave({
      workspaceId: "ws",
      documentId: "od_A",
      pageId: "old_page",
    }),
  ).rejects.toThrow("页面已失效");
  expect(view.webContents.evaluations).toEqual([]);
  await f.panel.prepareSave({
    workspaceId: "ws",
    documentId: "od_A",
    pageId: "page_A",
  });
  expect(view.webContents.evaluations).toHaveLength(1);
  let release!: () => void;
  view.webContents.evaluationGate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = f.panel.prepareSave({
    workspaceId: "ws",
    documentId: "od_A",
    pageId: "page_A",
  });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  f.panel.destroy();
  release();
  await expect(pending).rejects.toThrow("页面已失效");
});

test.each(["输入.csv", "输入.xlsx"])(
  "%s 保存采用表格提交契约",
  async (name) => {
    const f = await fixture(name);
    await f.show(f.main);
    await f.panel.prepareSave({
      workspaceId: "ws",
      documentId: "od_A",
      pageId: "page_A",
    });
    const view = [...f.main.children][0];
    expect(view.webContents.evaluations[0]).toContain("waitForSheetPageCommit");
    expect(view.webContents.evaluations[0]).not.toContain(
      "waitForWordPageCommit",
    );
  },
);

test("PPT 保存先确认文字与原生提交，历史提交失败不能被 SDK 的已结束队列掩盖", async () => {
  const f = await fixture("演示.pptx");
  await f.show(f.main);
  const partition = partitions.get("office-od_A");
  partition.fetch = async () =>
    Response.json({ code: -1, message: "原生提交失败" });
  const response = await partition.protocol.handler(
    new Request("http://127.0.0.1:39999/localapi/commitrevision", {
      method: "POST",
    }),
  );
  expect(await response.json()).toEqual({ code: -1, message: "原生提交失败" });
  await expect(
    f.panel.prepareSave({
      workspaceId: "ws",
      documentId: "od_A",
      pageId: "page_A",
    }),
  ).rejects.toThrow("原生提交失败");
  const view = [...f.main.children][0];
  expect(view.webContents.evaluations[0]).toContain("waitForSlidePageCommit");
  partition.fetch = async () => Response.json({ code: 0 });
  await partition.protocol.handler(
    new Request("http://127.0.0.1:39999/localapi/commitrevision", {
      method: "POST",
    }),
  );
  await expect(
    f.panel.prepareSave({
      workspaceId: "ws",
      documentId: "od_A",
      pageId: "page_A",
    }),
  ).rejects.toThrow("原生提交失败");
  expect(f.saves).toEqual([]);
  f.panel.destroy();
  await f.show(f.main);
  await f.panel.prepareSave({
    workspaceId: "ws",
    documentId: "od_A",
    pageId: "page_A",
  });
});

test("PPT 文档快捷键按页面组合状态决定执行，原生缺少标志时仍不保存或关闭", async () => {
  const f = await fixture("演示.pptx");
  await f.show(f.main);
  const contents = [...f.main.children][0].webContents;
  contents.emit("dom-ready");
  expect(contents.evaluations[0]).toContain("installSlideKeyboardGuard");
  contents.evaluationResult = true;
  for (const key of ["s", "w", "o"])
    contents.emit(
      "before-input-event",
      { preventDefault() {} },
      { meta: true, key, type: "keyDown", isComposing: false },
    );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toEqual([]);
  expect(f.opens).toEqual([]);
  expect(f.document.state).toBe("ready");
  contents.evaluationResult = undefined;
  contents.emit(
    "before-input-event",
    { preventDefault() {} },
    { meta: true, key: "s", type: "keyDown" },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toEqual([]);
  contents.evaluationResult = false;
  contents.emit(
    "before-input-event",
    { preventDefault() {} },
    { meta: true, key: "s", type: "keyDown" },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.saves).toHaveLength(1);
});

test("批量关闭模型也同步清除文件标签，保留尚未销毁的文件浏览器主页", async () => {
  const f = await fixture();
  await f.files.open({
    workspaceId: "ws", sessionId: "ses", path: f.document.name,
  });
  const host = f.files.windows()[0];
  await f.show(host);
  expect(await f.panel.prepareQuit()).toBe(true);
  expect((await f.state(host)).tabs).toHaveLength(0);
  expect(host.destroyed).toBe(false);
  expect(host.title).toBe("JuggleWork 文件浏览器");
  f.panel.destroy();
  f.files.dispose();
});

test("运行任务时关闭 Word 不销毁模型、原生视图或标签，任务结束后可以重试", async () => {
  const f = await fixture("报告.docx");
  await f.files.open({ workspaceId: "ws", sessionId: "ses", path: f.document.name });
  const host = f.files.windows()[0];
  await f.show(host);
  const view = [...host.children][0];
  f.preparation.closeError = "office_run_active";
  await expect(f.call("jugglework:office:close", host, {
    workspaceId: "ws", documentId: f.document.documentId,
  })).rejects.toThrow("请等待文档相关任务结束及交付完成后重试");
  expect(f.document.state).toBe("ready");
  expect(view.webContents.destroyed).toBe(false);
  expect((await f.state(host)).tabs).toHaveLength(1);
  expect(host.webContents.messages.some((item: { name: string }) => item.name === "jugglework:office:closed")).toBe(false);

  f.preparation.closeError = null;
  expect(await f.call("jugglework:office:close", host, {
    workspaceId: "ws", documentId: f.document.documentId,
  })).toBe(true);
  expect(f.document.state).toBe("closed");
  expect(view.webContents.destroyed).toBe(true);
  expect((await f.state(host)).tabs).toHaveLength(0);
});

test("运行时重启先处理双宿主文档，取消或保存失败保留页面，确认后释放窗口和旧模型标签", async () => {
  for (const standalone of [false, true]) {
    const f = await fixture("数据.csv");
    if (standalone)
      await f.files.open({
        workspaceId: "ws", sessionId: "ses", path: "数据.csv",
      });
    const host = standalone ? f.files.windows()[0] : f.main;
    await f.show(host);
    const view = [...host.children][0];
    f.document.dirty = true;
    answers.close = 2;
    expect(await f.files.prepareRuntimeStop()).toBe(false);
    expect(view.webContents.destroyed).toBe(false);
    expect(host.destroyed).toBe(false);
    expect(f.document.state).toBe("ready");
    if (standalone) expect((await f.state(host)).tabs).toHaveLength(1);

    answers.close = 0;
    f.preparation.closeError = "保存失败";
    await expect(f.files.prepareRuntimeStop()).rejects.toThrow("保存失败");
    expect(view.webContents.destroyed).toBe(false);
    expect(host.destroyed).toBe(false);
    f.preparation.closeError = null;
    expect(await f.files.prepareRuntimeStop()).toBe(true);
    expect(f.document.state).toBe("closed");
    expect(view.webContents.destroyed).toBe(true);
    expect(f.files.windows()).toHaveLength(0);
    expect(
      host.webContents.messages.some(
        (item: { name: string }) => item.name === "jugglework:office:closed",
      ),
    ).toBe(true);
  }
});

test("系统外部文件复用一个多标签窗口，最近路径重新登记，关闭取消保留模型且副本使用原文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-file-window-"));
  roots.push(root);
  const source = join(root, "外部 预算.csv");
  await writeFile(source, "名称,金额\n预算,20\n");
  const main = new FakeWindow();
  const requests: string[] = [];
  const registrations: string[] = [];
  let canClose = false;
  const windows = createFileWindows({
    client: {
      async getJson(url: string) {
        requests.push(url);
        if (url === "/workspaces") return { items: [] };
        if (url.includes("/files/stat")) return { exists: true, kind: "file" };
        if (url.endsWith("/capabilities")) return { available: true };
        throw new Error(`不应读取工作区: ${url}`);
      },
      async postJson(url: string, body: any) {
        requests.push(url);
        return { document: { documentId: body.path, state: "opening" } };
      },
    },
    registerLocalFile: async (absolute: string) => {
      registrations.push(absolute);
      return {
        workspaceId: "local-context",
        sessionId: "file-browser",
        path: `id/${absolute.split("/").at(-1)}`,
        local: true,
        absolutePath: absolute,
      };
    },
    getAccess: async () => ({
      baseUrl: "http://127.0.0.1:1234",
      clientToken: "fixture",
    }),
    office: { transfer: async () => true, close: async () => canClose },
    getMainWindow: () => main,
    loadWindow: async () => {},
    preloadPath: "fixture",
    iconPath: "fixture",
    recentPath: join(root, "recent.json"),
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  windows.registerIpc({
    handle: (name: string, handler: any) => handlers.set(name, handler),
  });
  await windows.openLocal(source);
  await windows.openLocal(source);
  const window = windows.windows()[0];
  const call = (name: string, ...args: any[]) =>
    handlers.get(name)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  expect(windows.windows()).toHaveLength(1);
  let state = await call("jugglework:file-window:state");
  expect(state.local).toBe(true);
  expect(state.workspaceRoot).toBe("");
  expect(state.tabs).toHaveLength(1);
  expect(state.recent[0].path).toBe(source);
  await call("jugglework:file-window:action", "open", source);
  expect(registrations).toHaveLength(3);
  await expect(call("jugglework:file-window:action", "open", join(root, "未选择.csv"))).rejects.toThrow("文件选择框");
  expect(registrations).toHaveLength(3);
  const copy = join(root, "副本.csv");
  answers.save = { canceled: false, filePath: copy };
  await call("jugglework:file-window:action", "save-copy");
  expect(await readFile(copy, "utf8")).toBe(await readFile(source, "utf8"));
  await windows.openLocal(join(root, "报告.docx"));
  state = await call("jugglework:file-window:state");
  expect(state.tabs).toHaveLength(2);
  expect(await windows.closeAll()).toBe(false);
  expect(window.isDestroyed()).toBe(false);
  canClose = true;
  expect(await windows.closeAll()).toBe(true);
  expect(requests).toContain("/workspaces");
});
