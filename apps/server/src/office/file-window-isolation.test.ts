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
  await handlers.get("jugglework:file-window:action")!(event, "reveal", paths[1]);
  expect(revealed).toEqual([originals[1]!]);
  await handlers.get("jugglework:file-window:action")!(event, "save-copy", paths[1]);
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
      return { workspaceId: "file-assistant", sessionId: "file-chat", path: key, local: true, absolutePath: absolute };
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
    authorizeFileEditor: (event: any, input: any) => files.authorizeFileEditor(event, input),
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
  await f.handlers.get("jugglework:file-window:action")!(ev, "close", target.path);
  expect(() => f.call("state", ev, target)).toThrow();
  expect(f.files.canReceiveFileEditor(window, target)).toBe(false);
  window.destroy();
  expect(() => f.call("state", ev, target)).toThrow();
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
  await f.handlers.get("jugglework:file-window:action")!(f.event(b!), "close", target.path);
  await f.call("external", f.event(a!), target, false);
  expect(changes(b!).length).toBe(3);
  a!.destroy();
  await f.call("update", f.event(f.main), target, { content: "main edit", baseUpdatedAt: 2 });
  expect(changes(a!).length).toBe(4);
  expect(changes(f.main).length).toBe(5);
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
