import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class Window extends EventEmitter {
  options: any;
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => this.destroyed,
    setWindowOpenHandler() {},
    send: (name: string, value: any) => { this.messages.push({ name, value: structuredClone(value) }); },
  });
  messages: any[] = [];
  constructor(options = {}) { super(); this.options = options; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  isMinimized() { return false; }
  setTitle() {} show() {} focus() {}
}
let dialogAnswer = async () => ({ response: 0 });
let saveDialog = async (_options: any) => ({ canceled: true });
let openDialog = async () => ({ canceled: true, filePaths: [] as string[] });
const revealed: string[] = [];
mock.module("electron", () => ({ clipboard: { writeText: async () => {} },
  BrowserWindow: Window,
  dialog: { showMessageBox: () => dialogAnswer(), showSaveDialog: (_window: any, options: any) => saveDialog(options), showOpenDialog: () => openDialog(), showErrorBox() {} },
  shell: { showItemInFolder: (path: string) => revealed.push(path) },
}));
// @ts-expect-error Main JS is checked by the desktop checkJs project.
const { createFileWindows } = await import("../../../desktop/electron/file-windows.mjs");
// @ts-expect-error Main JS is checked by the desktop checkJs project.
const { createFileEditor } = await import("../../../desktop/electron/file-editor.mjs");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run();
  dialogAnswer = async () => ({ response: 0 });
  saveDialog = async () => ({ canceled: true });
  openDialog = async () => ({ canceled: true, filePaths: [] });
  revealed.length = 0;
});

test.each([true, false])("从 Main 新增外部标签补齐原路径，最近文件和定位一致，取消副本不修改原件（首次本机入口=%s）", async (localFirst) => {
  const root = await mkdtemp(join(tmpdir(), "file-original-source-"));
  const paths = ["external-files/a/第一份.csv", "external-files/b/第二份.csv"];
  const originals = [join(root, "原件一.csv"), join(root, "原件二.csv")];
  for (const original of originals) await writeFile(original, "项目,数量\n原件,11\n");
  const dialogs: any[] = [];
  saveDialog = async (options) => { dialogs.push(options); return { canceled: true }; };
  const client = {
    getJson: async (url: string) => url === "/workspaces" ? { items: [{ id: "ws", path: join(root, "workspace") }] }
      : url.includes("/files/stat") ? { exists: true, kind: "file" } : { available: false },
    postJson: async (route: string, body: any) => {
      if (route === "/office/local-files/resolve") {
        const index = paths.indexOf(body.path);
        if (index < 0) throw new Error("文件未登记");
        return { absolutePath: originals[index] };
      }
      if (route.endsWith("/prepare-file")) return {};
      throw new Error(`Unexpected request: ${route}`);
    },
  };
  const files = createFileWindows({ client, office: {}, getMainWindow: () => null, loadWindow: async () => {},
    preloadPath: "fixture", recentPath: join(root, "recent.json"), getAccess: async () => ({ baseUrl: "http://127.0.0.1:1234" }) });
  cleanup.push(async () => { files.dispose(); await rm(root, { recursive: true, force: true }); });
  const handlers = new Map<string, (...args: any[]) => any>();
  files.registerIpc({ handle: (name: string, handler: any) => handlers.set(name, handler) });
  await files.open({ workspaceId: "ws", sessionId: "chat", path: paths[0], ...(localFirst ? { local: true, absolutePath: originals[0] } : {}) });
  await files.open({ workspaceId: "ws", sessionId: "chat", path: paths[1] });
  expect(files.windows()).toHaveLength(1);
  const window = files.windows()[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const state = await handlers.get("jugglework:file-window:state")!(event);
  expect(state.local).toBe(true);
  expect(state.tabs.map((tab: any) => tab.absolutePath)).toEqual(originals);
  expect(state.recent.map((item: any) => item.path)).toEqual([...originals].reverse());
  await handlers.get("jugglework:file-window:action")!(event, "reveal", state.tabs[1].tabId);
  expect(revealed).toEqual([originals[1]!]);
  await handlers.get("jugglework:file-window:action")!(event, "save-copy", state.tabs[1].tabId);
  expect(dialogs).toEqual([{ title: "另存为", defaultPath: "原件二.csv" }]);
  expect(await readFile(originals[1]!, "utf8")).toBe("项目,数量\n原件,11\n");
});

test.each([false, true])("原生选择器将工作区外原件交给文件助手，区内文件保持原聊天（独立窗口=%s）", async (standalone) => {
  const root = await mkdtemp(join(tmpdir(), "file-picker-routing-"));
  const workspaceRoot = join(root, "workspace");
  const original = join(root, "桌面原件.csv");
  await writeFile(original, "项目,数量\n原件,11\n");
  const main = new Window();
  const registrations: string[] = [];
  const key = "external-files/picker/桌面原件.csv";
  const files = createFileWindows({
    client: {
      getJson: async (url: string) => url === "/workspaces" ? { items: [{ id: "ws", path: workspaceRoot }, { id: "file-assistant", path: join(root, "assistant") }] }
        : url.includes("/files/stat") ? { exists: true, kind: "file" } : { available: false },
      postJson: async (_url: string, body: any) => ({ absolutePath: body.path === key ? original : null }),
    },
    registerLocalFile: async (absolute: string) => {
      registrations.push(absolute);
      return { workspaceId: "file-assistant", sessionId: "file-chat", path: key, local: true, absolutePath: absolute, group: { kind: "file-assistant" } };
    },
    office: {}, getMainWindow: () => main, loadWindow: async () => {}, preloadPath: "fixture",
    recentPath: join(root, "recent.json"), getAccess: async () => ({ baseUrl: "http://127.0.0.1:1234" }),
  });
  cleanup.push(async () => { files.dispose(); await rm(root, { recursive: true, force: true }); });
  const handlers = new Map<string, (...args: any[]) => any>();
  files.registerIpc({ handle: (name: string, handler: any) => handlers.set(name, handler) });
  const state = (window: Window) => handlers.get("jugglework:file-window:state")!({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  if (standalone) await files.open({ workspaceId: "ws", sessionId: "chat", path: "原文件.md" });
  const host = standalone ? files.windows()[0] : main;
  // TIPS: 混合多选同时验证外部文件的原件登记与区内文件的原聊天归属，不复制文件或改绑窗口。
  openDialog = async () => ({ canceled: false, filePaths: [original, join(workspaceRoot, "区内.md")] });
  await files.openDialog(host, { workspaceId: "ws", sessionId: "chat" });
  expect(registrations).toEqual([original]);
  const assistant = files.windows().find((window: Window) => window !== host);
  expect(await state(assistant)).toMatchObject({ workspaceId: "file-assistant", sessionId: "file-chat", activePath: key, local: true });
  expect((await state(assistant)).tabs[0].absolutePath).toBe(original);
  if (standalone) {
    const current = await state(host);
    expect(current).toMatchObject({ workspaceId: "ws", sessionId: "chat", activePath: "区内.md" });
    expect(current.tabs.map((tab: any) => tab.path)).toEqual(["原文件.md", "区内.md"]);
  } else {
    expect(main.messages).toContainEqual({ name: "jugglework:file-window:open-in-panel", value: { workspaceId: "ws", sessionId: "chat", path: "区内.md" } });
  }
  openDialog = async () => ({ canceled: true, filePaths: [original] });
  await files.openDialog(host, { workspaceId: "ws", sessionId: "chat" });
  expect(registrations).toEqual([original]);
  expect(await readFile(original, "utf8")).toBe("项目,数量\n原件,11\n");
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "file-isolation-"));
  const main = new Window();
  const posts: any[] = [];
  let saveGate: Promise<void> | undefined;
  let files: any;
  const editor = createFileEditor({
    getWindows: () => [main, ...files.windows()],
    authorizeFileEditor: (event: any, input: any, operation: string) => files.authorizeFileEditor(event, input, operation),
    canReceiveFileEditor: (window: any, input: any) => files.canReceiveFileEditor(window, input),
    client: { postJson: async (...args: any[]) => { posts.push(args); await saveGate; return { updatedAt: 2 }; } },
  });
  files = createFileWindows({
    client: { getJson: async (url: string) => url === "/workspaces"
      ? { items: [{ id: "ws", path: root }, { id: "other", path: root }] }
      : { exists: true, kind: "file" } },
    getMainWindow: () => main, getAccess: async () => ({ baseUrl: "http://127.0.0.1:1234", clientToken: "synthetic-not-exposed" }),
    getAppearance: async () => ({ lang: "zh", theme: "dark" }),
    office: {}, fileEditor: editor, loadWindow: async () => {},
    preloadPath: "fixture", iconPath: "fixture", recentPath: join(root, "recent.json"),
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = { handle: (name: string, fn: any) => handlers.set(name, fn) };
  editor.registerIpc(ipc); files.registerIpc(ipc);
  const event = (window: Window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const call = (action: string, ev: any, input: any, ...args: any[]) =>
    handlers.get(`jugglework:file-editor:${action}`)!(ev, input, ...args);
  cleanup.push(async () => { files.dispose(); await rm(root, { recursive: true, force: true }); });
  return { files, main, editor, handlers, event, call, posts, setSaveGate: (gate: Promise<void>) => { saveGate = gate; } };
}

test("actual file windows use unique non-persistent storage partitions and safe bootstrap state", async () => {
  const f = await fixture();
  await f.files.open({ workspaceId: "ws", sessionId: "a", path: "notes.md" });
  await f.files.open({ workspaceId: "ws", sessionId: "b", path: "notes.md" });
  const windows: Window[] = f.files.windows();
  const partitions = windows.map((window) => window.options.webPreferences.partition);
  expect(new Set(partitions).size).toBe(2);
  for (const partition of partitions) { expect(partition).toMatch(/^file-window-.+/); expect(partition).not.toStartWith("persist:"); }
  expect(f.main.options.webPreferences).toBeUndefined();
  const state = await f.handlers.get("jugglework:file-window:state")!(f.event(windows[0]!));
  expect(state.appearance).toEqual({ lang: "zh", theme: "dark" });
  expect(JSON.stringify(state)).not.toContain("synthetic-not-exposed");
});

test("all text IPCs require real top-frame sender plus registered workspace/path; main remains trusted", async () => {
  const f = await fixture();
  const target = { workspaceId: "ws", path: "notes.md" };
  await f.files.open({ ...target, sessionId: "a" });
  const window: Window = f.files.windows()[0];
  const ev = f.event(window);
  const stranger = new Window();
  const forged = { ...window.webContents, isDestroyed: () => false };
  const denied = [
    [ev, { ...target, workspaceId: "other" }], [ev, { ...target, path: "hidden.md" }],
    [ev, { ...target, path: "./notes.md" }], [ev, null],
    [{ ...ev, senderFrame: {} }, target], [{ ...ev, senderFrame: undefined }, target],
    [{ sender: forged, senderFrame: forged.mainFrame }, target], [f.event(stranger), target],
    [{ ...f.event(f.main), senderFrame: {} }, target],
  ];
  for (const action of ["state", "update", "save", "prepare", "close", "external"])
    for (const [event, input] of denied)
      await expect(Promise.resolve().then(() => f.call(action, event, input, { content: "denied", baseUpdatedAt: 1 }))).rejects.toThrow();
  expect(f.posts).toEqual([]);
  await f.call("update", ev, target, { content: "legitimate preview", baseUpdatedAt: 1 });
  expect((await f.call("state", ev, target)).draft.content).toBe("legitimate preview");
  await f.call("save", ev, target);
  expect(f.posts[0][0]).toBe("/workspace/ws/files/raw");
  expect(Buffer.from(f.posts[0][1].dataBase64, "base64").toString()).toBe("legitimate preview");
  expect((await f.call("state", f.event(f.main), { workspaceId: "other", path: "main-only.md" })).draft).toBeNull();
  const state = await f.handlers.get("jugglework:file-window:state")!(ev);
  await f.handlers.get("jugglework:file-window:action")!(ev, "close", state.activeTabId);
  expect(() => f.call("state", ev, target)).toThrow();
  expect(f.files.canReceiveFileEditor(window, target)).toBe(false);
  window.destroy();
  expect(() => f.call("state", ev, target)).toThrow();
});

test("只读 Markdown 保留读取且所有写 IPC 拒绝，同 key 可编辑标签不绕过", async () => {
  const f = await fixture();
  const target = { workspaceId: "ws", path: "readonly.md" };
  // 先保留一份草稿，证明 save 被拒绝时不会落到 raw POST。
  await f.call("update", f.event(f.main), target, { content: "旧草稿", baseUpdatedAt: 1 });
  await f.files.open({ ...target, sessionId: "readonly", readOnly: true });
  const readonly: Window = f.files.windows()[0];
  await f.files.open({ workspaceId: "ws", sessionId: "readonly", path: "editable.md" });
  await f.files.open({ ...target, sessionId: "other-editable" });
  const sameKey: Window = f.files.windows()[1];
  for (const window of [readonly, sameKey, f.main]) {
    expect((await f.call("state", f.event(window), target)).draft.content).toBe("旧草稿");
    for (const action of ["update", "save", "prepare", "close", "external"])
      await expect(Promise.resolve().then(() => f.call(action, f.event(window), target, action === "external" ? true : { content: "错误写入", baseUpdatedAt: 1 }))).rejects.toThrow("只读");
  }
  expect(f.posts).toEqual([]);
  const raw = await f.files.fetch(f.event(readonly), "http://127.0.0.1:1234/workspace/ws/files/raw?path=readonly.md", {}, async () => new Response("原件预览"));
  expect(new TextDecoder().decode(raw.body)).toBe("原件预览");
  const editable = { workspaceId: "ws", path: "editable.md" };
  await f.call("update", f.event(readonly), editable, { content: "正常修改", baseUpdatedAt: 1 });
  await f.call("save", f.event(readonly), editable);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0][0]).toBe("/workspace/ws/files/raw");
  expect(f.posts[0][1].path).toBe(editable.path);
  expect(Buffer.from(f.posts[0][1].dataBase64, "base64").toString()).toBe("正常修改");
  // 非活动只读标签关闭时不触发旧草稿的保存确认。
  const state = await f.handlers.get("jugglework:file-window:state")!(f.event(readonly));
  const tab = state.tabs.find((tab: any) => tab.path === target.path);
  await f.handlers.get("jugglework:file-window:action")!(f.event(readonly), "close", tab.tabId);
  expect(f.posts).toHaveLength(1);
  await f.call("save", f.event(sameKey), target);
  expect(f.posts).toHaveLength(2);
});

test("draft, save and external updates reach main and same-file windows only, including after revocation", async () => {
  const f = await fixture();
  const target = { workspaceId: "ws", path: "notes.md" };
  for (const input of [
    { ...target, sessionId: "a" }, { ...target, sessionId: "b" },
    { workspaceId: "ws", path: "different.md", sessionId: "c" },
    { workspaceId: "other", path: "notes.md", sessionId: "d" },
  ]) await f.files.open(input);
  const [a, b, unrelated, other]: Window[] = f.files.windows();
  const changes = (window: Window) => window.messages.filter((message) => message.name === "jugglework:file-editor:changed");
  await f.call("update", f.event(a!), target, { content: "private draft", baseUpdatedAt: 1 });
  await f.call("save", f.event(b!), target);
  await f.call("external", f.event(a!), target, true);
  for (const window of [f.main, a!, b!]) expect(changes(window).length).toBe(3);
  for (const window of [unrelated!, other!]) expect(changes(window)).toEqual([]);
  const state = await f.handlers.get("jugglework:file-window:state")!(f.event(b!));
  await f.handlers.get("jugglework:file-window:action")!(f.event(b!), "close", state.activeTabId);
  await f.call("external", f.event(a!), target, false);
  expect(changes(b!).length).toBe(3);
  a!.destroy();
  await f.call("update", f.event(f.main), target, { content: "main edit", baseUpdatedAt: 2 });
  expect(changes(a!).length).toBe(4);
  expect(changes(f.main).length).toBe(5);
});

test("只读 clean 文本允许真实 Main/文件窗 prepare 和 close，写入口仍拒绝", async () => {
  const f = await fixture();
  const target = { workspaceId: "ws", path: "readonly.md" };
  await f.files.open({ ...target, sessionId: "readonly", readOnly: true });
  await f.files.open({ ...target, sessionId: "editable" });
  for (const window of [f.main, ...f.files.windows()]) {
    expect((await f.call("state", f.event(window), target)).draft).toBeNull();
    for (const action of ["prepare", "close"])
      expect(await f.call(action, f.event(window), target)).toBe(true);
    for (const action of ["update", "save", "external"])
      await expect(Promise.resolve().then(() => f.call(action, f.event(window), target, { content: "拒绝写入", baseUpdatedAt: 1 }))).rejects.toThrow("只读");
  }
  expect(f.posts).toEqual([]);
});

test("revoking the sender while save confirmation is open prevents the later write", async () => {
  const f = await fixture();
  const target = { workspaceId: "ws", path: "notes.md" };
  await f.files.open({ ...target, sessionId: "a" });
  const window: Window = f.files.windows()[0];
  await f.call("update", f.event(window), target, { content: "draft", baseUpdatedAt: 1 });
  let release!: (answer: { response: number }) => void;
  dialogAnswer = () => new Promise((resolve) => { release = resolve; });
  const pending = f.call("prepare", f.event(window), target);
  window.destroy(); release({ response: 0 });
  await expect(pending).rejects.toThrow();
  expect(f.posts).toEqual([]);
});

test("a save started while authorized cannot return content or publish to a revoked window", async () => {
  const f = await fixture();
  const target = { workspaceId: "ws", path: "notes.md" };
  await f.files.open({ ...target, sessionId: "a" });
  const window: Window = f.files.windows()[0];
  await f.call("update", f.event(window), target, { content: "authorized save", baseUpdatedAt: 1 });
  let release!: () => void;
  f.setSaveGate(new Promise((resolve) => { release = resolve; }));
  const pending = f.call("save", f.event(window), target);
  window.destroy(); release();
  await expect(pending).rejects.toThrow();
  expect(window.messages.filter((message) => message.name === "jugglework:file-editor:changed").length).toBe(1);
  expect((await f.call("state", f.event(f.main), target)).saved.content).toBe("authorized save");
});

async function groupedFixture(options: any = {}) {
  const root = await mkdtemp(join(tmpdir(), "file-source-groups-"));
  const main = new Window();
  const sources = Object.fromEntries(["a", "b", "chat"].map(id => [id, { workspaceId: id, sessionId: `ses-${id}`, workspaceRoot: join(root, id) }]));
  const handlers = new Map<string, (...args: any[]) => any>();
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const cancelled: string[] = [];
  const navigated: any[] = [];
  const access = { baseUrl: "http://127.0.0.1:1234", clientToken: "fixture" };
  let accessGate: (() => Promise<void>) | undefined;
  let sessionGate: ((id: string) => Promise<void>) | undefined;
  let workspaceGate: (() => Promise<void>) | undefined;
  const files = createFileWindows({
    client: {
      getJson: async (url: string) => {
        if (url === "/workspaces") { await workspaceGate?.(); return { items: Object.values(sources).map(source => ({ id: source.workspaceId, path: source.workspaceRoot })) }; }
        if (url.includes("/sessions/")) {
          const id = decodeURIComponent(url.split("/").at(-1)!);
          await sessionGate?.(id);
          return { item: { id } };
        }
        if (url.endsWith("/capabilities")) return { available: true };
        return { exists: true, kind: "file" };
      },
      postJson: options.postJson ?? (async (url: string) => url.endsWith("/open") ? { document: { documentId: `doc-${url.split("/")[2]}` } } : { absolutePath: null }),
    },
    office: { transfer: async () => true, close: async () => true, confirmFileTarget: async () => true, ...options.office },
    getMainWindow: () => main, getDesktopConfig: async () => ({}),
    getAccess: async () => { await accessGate?.(); return access; },
    openSession: async (input: any) => { navigated.push(input); },
    registerLocalFile: async (absolute: string) => {
      const id = absolute.includes("chat") ? "chat" : absolute.includes("a.docx") ? "a" : "b";
      return { ...sources[id], path: "same.docx", absolutePath: absolute, local: id !== "chat",
        group: id === "chat" ? { kind: "conversation", workspaceId: "chat", sessionId: "ses-chat" } : { kind: "file-assistant" } };
    },
    fetcher: async (url: string) => {
      const id = new URL(url).pathname.split("/")[2]!;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.set(id, controller); }, cancel() { cancelled.push(id); } }), { headers: { "content-type": "text/event-stream" } });
    },
    loadWindow: options.loadWindow ?? (async () => {}), dock: options.dock,
    preloadPath: "fixture", recentPath: join(root, "recent.json"),
  });
  files.registerIpc({ handle: (name: string, fn: any) => handlers.set(name, fn) });
  const event = (window = files.windows()[0]) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const call = (name: string, ...args: any[]) => handlers.get(`jugglework:file-window:${name}`)!(event(), ...args);
  const invoke = (window: Window, name: string, ...args: any[]) => handlers.get(`jugglework:file-window:${name}`)!(event(window), ...args);
  const state = () => call("state");
  const url = (id: string, route: string) => `${access.baseUrl}/workspace/${id}/${route}`;
  const emit = (id: string, session: string, delta: string) => streams.get(id)!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: { type: "message.part.delta", properties: { sessionID: session, delta } } })}\n\n`));
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  cleanup.push(async () => { files.dispose(); await rm(root, { recursive: true, force: true }); });
  return { files, main, sources, root, event, call, invoke, state, url, streams, cancelled, navigated, emit, flush,
    setWorkspaceGate: (gate?: () => Promise<void>) => { workspaceGate = gate; },
    setAccessGate: (gate?: () => Promise<void>) => { accessGate = gate; },
    setSessionGate: (gate?: (id: string) => Promise<void>) => { sessionGate = gate; } };
}

test("可信分组让独立 child sources 共用文件助手窗、conversation 按原 pair 复用；Renderer 不可选组，空窗可复用", async () => {
  const f = await groupedFixture();
  await f.files.openLocal(join(f.root, "a.docx"));
  await f.files.openLocal(join(f.root, "b.docx"));
  const window = f.files.windows()[0];
  const initial = await f.state();
  expect(initial.group).toEqual({ kind: "file-assistant" });
  expect(initial.tabs.map((tab: any) => tab.source)).toEqual([f.sources.a, f.sources.b]);
  expect(new Set(initial.tabs.map((tab: any) => tab.tabId)).size).toBe(2);
  const [a, b] = initial.tabs;
  await f.call("action", "select", a.tabId);
  expect(await f.state()).toMatchObject({ ...f.sources.a, activeTabId: a.tabId });
  await f.call("action", "select", b.path); // path 不能冒充活标签身份。
  expect((await f.state()).activeTabId).toBe(a.tabId);
  await f.files.open({ source: f.sources.chat, path: "same.docx" });
  await f.files.openLocal(join(f.root, "chat.docx"));
  expect(f.files.windows()).toHaveLength(2);
  const chat = f.files.windows()[1];
  expect(chat.messages.filter((item: any) => item.name.endsWith(":changed")).at(-1).value.group).toEqual({ kind: "conversation", workspaceId: "chat", sessionId: "ses-chat" });
  await f.call("open", { source: f.sources.a, path: "same.docx", group: { kind: "conversation", workspaceId: "forged", sessionId: "forged" } });
  expect(f.files.windows()).toHaveLength(2);
  await f.call("action", "open-session", a.tabId);
  expect(f.navigated).toEqual([{ workspaceId: "a", sessionId: "ses-a", exact: true }]);
  for (const tab of initial.tabs) await f.call("action", "close", tab.tabId);
  expect(await f.state()).toMatchObject({ activeTabId: null, activePath: null, workspaceId: "", sessionId: "", workspaceRoot: "", tabs: [] });
  expect(await f.state()).not.toHaveProperty("conversation");
  await expect(f.call("session-subscribe", { workspaceId: "a" })).rejects.toThrow();
  await f.files.openLocal(join(f.root, "a.docx"));
  expect(f.files.windows()[0]).toBe(window);
  expect((await f.state()).activeTabId).not.toBe(a.tabId);
  await expect(f.files.fetch(f.event(), f.url("b", "opencode/provider"), {}, async () => Response.json({}))).rejects.toThrow();
});

test("每 source 单独保存首次 conversation options，同 workspace 的第二个 session 不能产生含糊请求身份", async () => {
  const f = await groupedFixture();
  const seedA = { model: { providerID: "p-a", modelID: "m-a" }, agent: "plan", variant: "high" };
  const seedB = { model: { providerID: "p-b", modelID: "m-b" }, agent: "build", variant: null };
  await f.files.open({ source: f.sources.a, path: "same.docx", group: { kind: "file-assistant" }, conversationOptions: seedA });
  await f.files.open({ source: f.sources.b, path: "same.docx", group: { kind: "file-assistant" }, conversationOptions: seedB });
  await f.files.open({ source: f.sources.a, path: "same.docx", group: { kind: "file-assistant" }, conversationOptions: seedB });
  const state = await f.state();
  expect(state.tabs.map((tab: any) => tab.conversation)).toEqual([{ ...seedA, desktopConfig: {} }, { ...seedB, desktopConfig: {} }]);
  await f.call("action", "select", state.tabs[1].tabId);
  expect((await f.state()).conversation).toEqual({ ...seedB, desktopConfig: {} });
  expect((await f.state()).tabs[0].source).toEqual(f.sources.a);
  await expect(f.files.open({ source: { ...f.sources.a, sessionId: "foreign" }, path: "same.docx", group: { kind: "file-assistant" } })).rejects.toThrow("唯一聊天");
  const fetcher = mock(async () => Response.json({}));
  await expect(f.files.fetch(f.event(), f.url("a", "sessions/ses-b/snapshot"), {}, fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

test("文件助手空窗仍通过系统选择器 openLocal 登记；不能用空身份或伪造 conversation 新建", async () => {
  const f = await groupedFixture();
  await f.files.openLocal(join(f.root, "a.docx"));
  const window = f.files.windows()[0];
  await f.call("action", "close", (await f.state()).activeTabId);
  expect(await f.state()).toMatchObject({ tabs: [], workspaceId: "", sessionId: "", activeTabId: null });
  for (const input of [{ workspaceId: "", sessionId: "" }, f.sources.chat]) {
    await expect(f.call("create", { ...input, kind: "docx" })).rejects.toThrow("聊天工作区");
  }
  openDialog = async () => ({ canceled: false, filePaths: [join(f.root, "b.docx")] });
  await f.call("action", "open");
  expect(f.files.windows()).toEqual([window]);
  expect((await f.state()).tabs[0]).toMatchObject({ source: f.sources.b, documentId: "doc-b" });
});

test.each(["access", "session", "response"])("A 请求等待 %s 时切 B，迟到响应、descendants 和 Office refs 始终归 A", async phase => {
  const f = await groupedFixture();
  await f.files.openLocal(join(f.root, "a.docx"));
  await f.files.openLocal(join(f.root, "b.docx"));
  const [a, b] = (await f.state()).tabs;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  if (phase === "access") f.setAccessGate(async () => { started(); await gate; });
  if (phase === "session") f.setSessionGate(async id => { if (id === "ses-a") { started(); await gate; } });
  const interaction = { id: "q", sessionID: "child-a", targetSessionId: "child-a", rootSessionId: "ses-a", ancestryPath: ["ses-a", "child-a"], parentSessionId: "ses-a" };
  const pending = f.files.fetch(f.event(), f.url("a", "sessions/ses-a/interactions/snapshot"), {}, async () => {
    if (phase === "response") { started(); await gate; }
    return Response.json({ item: { rootSessionId: "ses-a", includeDescendants: true, permissions: [], questions: [interaction] } });
  });
  await waiting;
  await f.call("action", "select", a.tabId);
  await f.call("action", "select", b.tabId);
  release(); f.setAccessGate(); f.setSessionGate();
  expect(JSON.parse(Buffer.from((await pending).body).toString()).item.rootSessionId).toBe("ses-a");
  expect((await f.state()).activeTabId).toBe(b.tabId);
  const input = { action: "append", windowId: f.files.windows()[0].id, ...f.sources.a,
    reference: { referenceId: "ref-a", workspaceId: "a", ownerSessionId: "ses-a", documentId: "doc-a" } };
  expect(f.files.officeComposerWindow(input)).toBe(f.files.windows()[0]);
  expect(() => f.files.authorizeOfficeReferences(f.event(), { ...f.sources.b, referenceIds: ["ref-a"] })).toThrow();
  expect(() => f.files.authorizeOfficeTarget(f.event(), { workspaceId: "b", documentId: "doc-a" })).toThrow();
  const ids = await Promise.all([f.call("session-subscribe", { workspaceId: "a" }), f.call("session-subscribe", { workspaceId: "b" })]);
  await f.flush();
  f.emit("a", "child-a", "owned-child"); f.emit("b", "child-a", "foreign-child");
  await f.flush();
  const events = f.files.windows()[0].messages.filter((item: any) => item.name.endsWith(":session-event"));
  expect(events.map((item: any) => [item.value.id, item.value.event.properties.delta])).toEqual([[ids[0], "owned-child"]]);
  await f.call("action", "close", a.tabId);
  expect(() => f.files.authorizeOfficeReferences(f.event(), { ...f.sources.a, referenceIds: ["ref-a"] })).toThrow();
});

test("关闭 A 只取消 A transport/SSE，不停止已接受 run，B 请求与订阅继续；切 tab 不取消", async () => {
  const f = await groupedFixture();
  await f.files.openLocal(join(f.root, "a.docx")); await f.files.openLocal(join(f.root, "b.docx"));
  const [a, b] = (await f.state()).tabs;
  const posts: string[] = [];
  await f.files.fetch(f.event(), f.url("a", "sessions/ses-a/runs/start"), { method: "POST", body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: null, prompt: { model: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "run" }] } }) }, async (url: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json({ all: [{ id: "p", source: "api", models: { m: {} } }], connected: ["p"] });
    posts.push(url); return Response.json({ run: { workspaceId: "a", sessionId: "ses-a", runId: "accepted" } });
  });
  await f.call("session-subscribe", { workspaceId: "a" }); await f.call("session-subscribe", { workspaceId: "b" }); await f.flush();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  let aCancelled = false;
  const pendingA = f.files.fetch(f.event(), f.url("a", "files/raw?path=same.docx"), {}, async () => new Response(new ReadableStream({ start() { started(); }, cancel() { aCancelled = true; } })));
  const settledA = pendingA.then(() => null, (error: unknown) => error);
  await reading;
  const pendingB = f.files.fetch(f.event(), f.url("b", "files/raw?path=same.docx"), {}, async () => { await gate; return new Response("B"); });
  await f.call("action", "select", a.tabId); await f.call("action", "select", b.tabId);
  expect(aCancelled).toBe(false); expect(f.cancelled).toEqual([]);
  await f.call("action", "close", a.tabId); await f.flush();
  expect(await settledA).toBeInstanceOf(Error); expect(aCancelled).toBe(true); expect(f.cancelled).toEqual(["a"]);
  release(); expect(Buffer.from((await pendingB).body).toString()).toBe("B");
  f.emit("b", "ses-b", "B-still-live"); await f.flush();
  expect(f.files.windows()[0].messages.filter((item: any) => item.name.endsWith(":session-event")).at(-1).value.event.properties.delta).toBe("B-still-live");
  expect(posts).toEqual([f.url("a", "sessions/ses-a/runs/start")]);
});

test.each(["access", "session"])("A 等待 %s 时关闭并重新打开，旧请求不能借新标签恢复授权", async phase => {
  const f = await groupedFixture();
  await f.files.openLocal(join(f.root, "a.docx")); await f.files.openLocal(join(f.root, "b.docx"));
  const [a, b] = (await f.state()).tabs;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  if (phase === "access") f.setAccessGate(async () => { started(); await gate; });
  else f.setSessionGate(async id => { if (id === "ses-a") { started(); await gate; } });
  const transport = mock(async () => Response.json({ item: { id: "ses-a" } }));
  const pending = f.files.fetch(f.event(), f.url("a", "sessions/ses-a"), {}, transport);
  const settled = pending.then(() => null, (error: unknown) => error);
  await waiting;
  await f.call("action", "close", a.tabId);
  f.setAccessGate(); f.setSessionGate();
  await f.files.openLocal(join(f.root, "a.docx"));
  release();
  expect(await settled).toBeInstanceOf(Error);
  expect(transport).not.toHaveBeenCalled();
  const state = await f.state();
  expect(state.tabs.find((tab: any) => tab.source.workspaceId === "a").tabId).not.toBe(a.tabId);
  expect(state.tabs.find((tab: any) => tab.source.workspaceId === "b").tabId).toBe(b.tabId);
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test.each([true, false])("Office open 迟到时仅清理本次新建模型（created=%s），不恢复已撤销来源", async created => {
  const opening = deferred(), result = deferred();
  const closes: unknown[] = [];
  const f = await groupedFixture({ postJson: async (url: string, body: any) => {
    if (url.endsWith("/open")) {
      if (body.path === "late.docx") { opening.resolve(); await result.promise; }
      const workspaceId = url.split("/")[2];
      return { document: { documentId: body.path === "late.docx" ? "doc-late" : `doc-${workspaceId}`, workspaceId, ownerSessionId: `ses-${workspaceId}` }, created };
    }
    if (url.endsWith("/close")) closes.push({ url, body });
    return { absolutePath: null };
  } });
  await f.files.openLocal(join(f.root, "a.docx"));
  await f.files.openLocal(join(f.root, "b.docx"));
  const [a, b] = (await f.state()).tabs;
  const pending = f.invoke(f.files.windows()[0], "open", { source: f.sources.a, path: "late.docx" });
  const settled = pending.then(() => null, (error: unknown) => error);
  await opening.promise;
  await f.call("action", "close", a.tabId);
  result.resolve();
  expect(await settled).toMatchObject({ message: "文件窗口来源已关闭" });
  expect((await f.state()).tabs).toEqual([b]);
  expect(closes).toEqual(created ? [{ url: "/workspace/a/office/doc-late/close", body: { decision: "discard", onlyIfClean: true, sessionId: "ses-a" } }] : []);
});

test.each(["cancel", "failure"])("首次 A transfer %s 仅回滚 A，已成功加入的 B 保持标签、活动身份及关闭确认", async ending => {
  const transferring = deferred(), result = deferred<boolean>();
  const close = mock(async () => false);
  const f = await groupedFixture({ office: {
    transfer: async (id: string) => {
      if (id !== "doc-a") return true;
      transferring.resolve(); return result.promise;
    }, close,
  } });
  const a = f.files.open({ source: f.sources.a, path: "same.docx", group: { kind: "file-assistant" } });
  const settled = a.then(() => null, (error: unknown) => error);
  await transferring.promise;
  const window = f.files.windows()[0];
  await f.files.openLocal(join(f.root, "b.docx"));
  const b = (await f.state()).tabs[1];
  if (ending === "cancel") result.resolve(false); else result.reject(new Error("transfer failed"));
  if (ending === "failure") expect(await settled).toBeInstanceOf(Error); else expect(await settled).toBeNull();
  expect(f.files.windows()).toEqual([window]);
  expect(await f.state()).toMatchObject({ tabs: [b], activeTabId: b.tabId, workspaceId: "b" });
  expect(f.files.canReceiveFileEditor(window, { workspaceId: "a", path: "same.docx" })).toBe(false);
  expect(await f.files.closeAll()).toBe(false);
  expect(close).toHaveBeenCalledWith("b", "doc-b", expect.any(Function));
  expect(window.isDestroyed()).toBe(false);
});

test.each(["success", "failure"])("首次加载 %s 的共享 promise 同时约束所有复用者，不提前迁移 Office", async ending => {
  const loading = deferred(), result = deferred();
  const loadWindow = mock(async () => { loading.resolve(); await result.promise; });
  const transfer = mock(async () => true);
  const f = await groupedFixture({ loadWindow, office: { transfer } });
  const a = f.files.open({ source: f.sources.a, path: "same.docx", group: { kind: "file-assistant" } });
  const settledA = a.then(() => null, (error: unknown) => error);
  await loading.promise;
  const b = f.files.openLocal(join(f.root, "b.docx"));
  let bFinished = false;
  const settledB = b.then(() => { bFinished = true; return null; }, (error: unknown) => { bFinished = true; return error; });
  await f.flush();
  expect((await f.state()).tabs).toHaveLength(2);
  expect(bFinished).toBe(false);
  expect(transfer).not.toHaveBeenCalled();
  expect(loadWindow).toHaveBeenCalledTimes(1);
  if (ending === "failure") result.reject(new Error("shared load failed")); else result.resolve();
  const results = await Promise.all([settledA, settledB]);
  if (ending === "failure") {
    for (const error of results) expect(error).toMatchObject({ message: "shared load failed" });
    expect(transfer).not.toHaveBeenCalled();
    expect(f.files.windows()).toEqual([]);
  } else {
    expect(results).toEqual([null, null]);
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(f.files.windows()).toHaveLength(1);
    expect((await f.state()).tabs).toHaveLength(2);
  }
});

test.each(["source", "source-reopen", "window", "window-reopen"])("真实 open IPC 读取工作区期间关闭 %s，迟到调用不能恢复来源或另建窗口", async ending => {
  const f = await groupedFixture();
  await f.files.openLocal(join(f.root, "a.docx"));
  await f.files.openLocal(join(f.root, "b.docx"));
  const window = f.files.windows()[0];
  const [a, b] = (await f.state()).tabs;
  const reading = deferred(), result = deferred();
  f.setWorkspaceGate(async () => { reading.resolve(); await result.promise; });
  const pending = f.invoke(window, "open", { source: f.sources.a, path: "late.docx" });
  const settled = pending.then(() => null, (error: unknown) => error);
  await reading.promise;
  f.setWorkspaceGate();
  if (ending.startsWith("source")) await f.invoke(window, "action", "close", a.tabId);
  else window.destroy();
  if (ending.endsWith("reopen")) await f.files.openLocal(join(f.root, "a.docx"));
  const before = f.files.windows();
  result.resolve();
  expect(await settled).toBeInstanceOf(Error);
  expect(f.files.windows()).toEqual(before);
  if (before.length) {
    const state = await f.state();
    expect(state.tabs.some((tab: any) => tab.path === "late.docx")).toBe(false);
    if (ending.startsWith("source")) expect(state.tabs.find((tab: any) => tab.source.workspaceId === "b").tabId).toBe(b.tabId);
    if (ending.endsWith("reopen")) expect(state.tabs.find((tab: any) => tab.source.workspaceId === "a").tabId).not.toBe(a.tabId);
    else expect(state.tabs.map((tab: any) => tab.source.workspaceId)).toEqual(["b"]);
  }
});

test("Main exact chat 返回同文件复用已登记文件助手 source/group/tab，伪造 group/root 不参与路由", async () => {
  const f = await groupedFixture();
  await f.files.openLocal(join(f.root, "a.docx"));
  await f.files.openLocal(join(f.root, "b.docx"));
  const window = f.files.windows()[0];
  const [a, b] = (await f.state()).tabs;
  await f.call("action", "open-session", a.tabId);
  expect(f.navigated).toEqual([{ workspaceId: "a", sessionId: "ses-a", exact: true }]);
  await f.invoke(f.main, "open", { source: { ...f.sources.a, workspaceRoot: "/forged" }, path: a.path,
    group: { kind: "conversation", workspaceId: "a", sessionId: "ses-a" } });
  expect(f.files.windows()).toEqual([window]);
  expect(await f.state()).toMatchObject({ group: { kind: "file-assistant" }, tabs: [a, b], activeTabId: a.tabId });
  await f.invoke(f.main, "open", { source: f.sources.a, path: "another.md", group: { kind: "conversation" } });
  expect(f.files.windows()).toEqual([window]);
  expect((await f.state()).tabs.map((tab: any) => tab.source)).toEqual([f.sources.a, f.sources.b, f.sources.a]);
  await f.invoke(f.main, "open", { source: f.sources.chat, path: "same.docx", group: { kind: "file-assistant" } });
  expect(f.files.windows()).toHaveLength(2);
  expect((await f.invoke(f.files.windows()[1], "state")).group).toEqual({ kind: "conversation", workspaceId: "chat", sessionId: "ses-chat" });
});
