import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class Window extends EventEmitter {
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => this.destroyed,
    setWindowOpenHandler() {},
    send() {},
  });
  constructor(_options = {}) { super(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  isMinimized() { return false; }
  setTitle() {} show() {} focus() {}
}

mock.module("electron", () => ({ clipboard: { writeText: async () => {} }, BrowserWindow: Window, dialog: {}, shell: {} }));
// @ts-expect-error Main JS is checked by the desktop checkJs project.
const { createFileWindows } = await import("../../../desktop/electron/file-windows.mjs");

test("first Main open accepts a namespaced agent seed and forwards it intact on start", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-window-options-"));
  const main = new Window();
  const handlers = new Map<string, (...args: any[]) => any>();
  const event = (window: Window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const seed = { model: { providerID: "provider", modelID: "model" }, agent: "team/reviewer", variant: "high effort" };
  const posted: any[] = [];
  let initial: any;
  const files = createFileWindows({
    client: { getJson: async (path: string) => path === "/workspaces" ? { items: [{ id: "ws", path: root }] }
      : path.endsWith("/sessions/ses") ? { item: { id: "ses" } } : { exists: true, kind: "file" } },
    getMainWindow: () => main,
    getAccess: async () => ({ baseUrl: "http://127.0.0.1:1234", clientToken: "synthetic-options-only" }),
    getDesktopConfig: async () => ({}),
    office: {}, preloadPath: "fixture", iconPath: "fixture", recentPath: join(root, "recent.json"),
    loadWindow: async (window: Window) => { initial = await handlers.get("jugglework:file-window:state")!(event(window)); },
  });
  files.registerIpc({ handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) });
  try {
    await handlers.get("jugglework:file-window:open")!(event(main), {
      workspaceId: "ws", sessionId: "ses", path: "notes.md", conversationOptions: seed,
    });
    expect(files.windows()).toHaveLength(1);
    expect(initial.conversation).toEqual({ ...seed, desktopConfig: {} });
    const window = files.windows()[0];
    const state = await handlers.get("jugglework:file-window:state")!(event(window));
    expect(state.tabs.map((tab: { path: string }) => tab.path)).toEqual(["notes.md"]);
    const response = await files.fetch(event(window), "http://127.0.0.1:1234/workspace/ws/sessions/ses/runs/start", {
      method: "POST", body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: null,
        prompt: { ...seed, parts: [{ type: "text", text: "review this file" }] } }),
    }, async (_url: string, init: RequestInit) => {
      if (init.method === "GET") return Response.json({ all: [{ id: "provider", source: "api", models: { model: { id: "model" } } }], connected: ["provider"] });
      posted.push(JSON.parse(String(init.body)));
      return Response.json({ run: { workspaceId: "ws", sessionId: "ses", runId: "run" } });
    });
    expect(response.status).toBe(200);
    expect(posted).toHaveLength(1);
    expect(posted[0].prompt).toMatchObject(seed);
    expect(posted[0].whenBusy).toBe("reject");
  } finally {
    files.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
