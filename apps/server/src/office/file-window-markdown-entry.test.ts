import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_WINDOW_EXTENSIONS } from "@jugglework/types/file-window";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";

class Window extends EventEmitter {
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => this.destroyed, setWindowOpenHandler() {}, send() {},
  });
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  isMinimized() { return false; }
  setTitle() {} show() {} focus() {}
}
let picked: string[] = [];
const dialogs: any[] = [];
mock.module("electron", () => ({
  BrowserWindow: Window, clipboard: {}, shell: {},
  dialog: {
    showOpenDialog: async (_window: unknown, options: unknown) => { dialogs.push(options); return { canceled: false, filePaths: picked }; },
    showMessageBox: async () => ({ response: 0 }), showErrorBox() {},
  },
}));
// @ts-expect-error Production Main JavaScript is checked by the desktop checkJs project.
const { createFileWindows } = await import("../../../desktop/electron/file-windows.mjs");
// @ts-expect-error Production Main JavaScript is checked by the desktop checkJs project.
const { createFileEditor } = await import("../../../desktop/electron/file-editor.mjs");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  picked = []; dialogs.length = 0;
});

test("Main 选择工作区外 Markdown：真实 Server 每文件 workspace/session、raw 读写、AI GET 与最近文件重开", async () => {
  const root = await mkdtemp(join(tmpdir(), "markdown-main-entry-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace"), assistantRoot = join(root, "FileAssistant");
  await mkdir(workspaceRoot);
  const originals = [join(root, "桌面说明 # %.MD"), join(root, "另一份.md")];
  await writeFile(originals[0]!, "# 初始说明\n");
  await writeFile(originals[1]!, "# 另一份\n");
  const canonicalOriginals = await Promise.all(originals.map(path => realpath(path)));
  let created = 0;
  const upstream = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/session" && request.method === "POST") return Response.json({ id: `ses_md_${++created}`, title: "文件对话" });
    if (/^\/session\/[^/]+$/.test(url.pathname)) return Response.json({ id: url.pathname.split("/").at(-1), title: "文件对话" });
    if (url.pathname.endsWith("/message")) return Response.json([]);
    return Response.json({});
  } });
  cleanups.push(async () => { await upstream.stop(true); });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "client", hostToken: "host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], readOnly: false, startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    workspaces: [{ id: "ws", name: "Workspace", path: workspaceRoot, workspaceType: "local", preset: "starter" }],
    authorizedRoots: [workspaceRoot], opencodeBaseUrl: upstream.url.href,
  };
  const server = await startServer(config, { fileAssistantRoot: assistantRoot });
  cleanups.push(async () => { await server.stop(); });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const posts: Array<{ route: string; body: any }> = [];
  const json = async (route: string, body?: unknown, host = false) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer client", "content-type": "application/json", ...(host ? { "X-JuggleWork-Host-Token": "host" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(value)}`);
    return value as any;
  };
  const client = {
    getJson: (route: string) => json(route),
    postJson: (route: string, body: unknown) => { posts.push({ route, body }); return json(route, body); },
  };
  const main = new Window();
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = { handle: (name: string, handler: any) => handlers.set(name, handler) };
  let files: any;
  const editor = createFileEditor({ client, getWindows: () => [main, ...files.windows()],
    authorizeFileEditor: (...args: any[]) => files.authorizeFileEditor(...args),
    canReceiveFileEditor: (...args: any[]) => files.canReceiveFileEditor(...args),
  });
  const options = {
    client, office: {}, fileEditor: editor, getMainWindow: () => main,
    getDesktopConfig: async () => ({}), getAccess: async () => ({ baseUrl, clientToken: "client" }),
    registerLocalFile: (path: string) => json("/office/local-files/open", { path }, true),
    loadWindow: async () => {}, preloadPath: "fixture", recentPath: join(root, "recent.json"),
  };
  files = createFileWindows(options);
  cleanups.push(async () => { files.dispose(); });
  files.registerIpc(ipc); editor.registerIpc(ipc);
  const event = (window = files.windows()[0]) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const state = () => handlers.get("jugglework:file-window:state")!(event());
  const action = (...args: any[]) => handlers.get("jugglework:file-window:action")!(event(), ...args);
  const read = async (workspaceId: string, route: string) => {
    const result = await files.fetch(event(), `${baseUrl}/workspace/${workspaceId}/${route}`, {}, fetch);
    expect(result.status).toBe(200);
    return new TextDecoder().decode(result.body);
  };
  picked = [originals[0]!];
  await files.openDialog(main, { workspaceId: "ws", sessionId: "chat" });
  const first = (await state()).tabs[0];
  expect(first).toMatchObject({ absolutePath: canonicalOriginals[0], conversation: { desktopConfig: {} } });
  expect(first.documentId).toBeUndefined();
  expect(first.source.workspaceId).not.toBe("ws");
  expect(first.source.workspaceRoot).not.toBe(workspaceRoot);
  expect(first.source.sessionId).toBe("ses_md_1");
  expect((await state()).group).toEqual({ kind: "file-assistant" });
  expect(await read(first.source.workspaceId, `files/raw?path=${encodeURIComponent(first.path)}`)).toBe("# 初始说明\n");
  expect(JSON.parse(await read(first.source.workspaceId, `sessions/${first.source.sessionId}`)).item.id).toBe(first.source.sessionId);
  expect(JSON.parse(await read(first.source.workspaceId, `sessions/${first.source.sessionId}/messages`)).items).toEqual([]);

  // 文件助手自身 picker 使用相同格式集合，新增文件保留独立 source。
  picked = [originals[1]!];
  await action("open");
  const both = await state();
  const second = both.tabs[1];
  expect(files.windows()).toHaveLength(1);
  expect(second.source.workspaceId).not.toBe(first.source.workspaceId);
  expect(second.source.sessionId).not.toBe(first.source.sessionId);
  for (const options of dialogs) expect(options.filters).toEqual([{ name: "支持的文件", extensions: [...FILE_WINDOW_EXTENSIONS] }]);
  expect(both.recent.map((item: any) => item.path)).toEqual([...canonicalOriginals].reverse());
  expect(config.authorizedRoots).not.toContain(root);
  expect(config.authorizedRoots).not.toContain(originals[0]);
  expect(await read(first.source.workspaceId, `files/raw?path=${encodeURIComponent(first.path)}`)).toBe("# 初始说明\n");
  await expect(files.fetch(event(), `${baseUrl}/workspace/${first.source.workspaceId}/files/raw?path=${encodeURIComponent(second.path)}`, {}, fetch)).rejects.toThrow();
  await expect(files.fetch(event(), `${baseUrl}/workspace/${first.source.workspaceId}/sessions/${second.source.sessionId}`, {}, fetch)).rejects.toThrow();

  // 非活动标签保存仍走 Main file-editor 的 raw POST，写回明确原件。
  const target = { workspaceId: first.source.workspaceId, path: first.path };
  const content = "# 已保存的说明\n原件保存成功。\n";
  await handlers.get("jugglework:file-editor:update")!(event(), target, { content, baseUpdatedAt: (await stat(originals[0]!)).mtimeMs });
  await handlers.get("jugglework:file-editor:save")!(event(), target);
  expect(posts).toContainEqual({ route: `/workspace/${target.workspaceId}/files/raw`, body: expect.objectContaining({ path: first.path, dataBase64: Buffer.from(content).toString("base64") }) });
  expect(await readFile(originals[0]!, "utf8")).toBe(content);
  expect(await readFile(originals[1]!, "utf8")).toBe("# 另一份\n");
  await expect(files.fetch(event(), `${baseUrl}/workspace/${target.workspaceId}/files/raw`, {
    method: "POST", body: JSON.stringify({ path: first.path, dataBase64: "" }),
  }, fetch)).rejects.toThrow();
  expect((await state()).activeTabId).toBe(second.tabId);
  await action("close", first.tabId);
  await action("open", canonicalOriginals[0]);
  expect((await state()).tabs.at(-1).source).toEqual(first.source);
  expect(created).toBe(2);
  files.dispose();
  files = createFileWindows(options); files.registerIpc(ipc);
  await files.openLocal(originals[0]);
  expect((await state()).tabs[0].source).toEqual(first.source);
  expect((await state()).recent.map((item: any) => item.path)).toEqual(canonicalOriginals);
  expect(created).toBe(2);
}, 20_000);
