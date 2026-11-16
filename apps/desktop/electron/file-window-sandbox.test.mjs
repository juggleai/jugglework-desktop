import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This file is both a Node test and an isolated Electron entry; never import Main
// (which starts the user's runtime). Exercise its real window factory instead.
if (process.versions.electron) {
  const { app, BrowserWindow, clipboard, ipcMain } = await import("electron");
  const root = process.argv.at(-1);
  app.setPath("userData", root);
  app.setPath("sessionData", root);
  app.on("window-all-closed", () => {});
  const { createFileWindows } = await import("./file-windows.mjs");
  const { createOfficePanel } = await import("./office-panel.mjs");
  const { createOfficeResources } = await import("./office-resources.mjs");
  const preloadErrors = [];
  app.on("web-contents-created", (_event, contents) => {
    contents.on("preload-error", (_event, preload, error) => preloadErrors.push({ preload, message: error.message }));
  });
  const timeout = setTimeout(() => { console.error("sandbox fixture timed out"); app.exit(1); }, 40000);
  async function run() {
    let server, files, panel, main;
    let exitCode = 0;
    try {
      await app.whenReady();
      server = createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end("<!doctype html><html><head><title>sandbox fixture</title></head><body></body></html>");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const html = path.join(root, "file-window.html");
      await writeFile(html, "<!doctype html><title>packaged fixture</title>");
      main = new BrowserWindow({ show: false });
      const document = { documentId: "sandbox-doc", pageId: "fixture-page", workspaceId: "ws", ownerSessionId: "dev", relativePath: "fixture.docx", state: "ready", previewUrl: `${origin}/static/doc/pc.html?localFilePath=/fixture.docx` };
      const client = {
        getJson: async (url) => url === "/workspaces" ? { items: [{ id: "ws", path: root }] }
          : url.endsWith("/capabilities") ? { available: true }
          : url.includes("/files/stat") ? { exists: true, kind: "file" } : { document },
        postJson: async () => ({ document }),
      };
      const resources = createOfficeResources({
        assetsDirectory: fileURLToPath(new URL("../resources/office-assets", import.meta.url)),
        cacheDirectory: path.join(root, "fonts"),
      });
      panel = createOfficePanel({ client, resources, getWindow: () => main, getWindows: () => files.windows(),
        resolveWindow: (sender) => sender === main.webContents ? main : files.windowFor(sender),
        composer: { request: async ({ action }) => {
          assert.equal(action, "guard", "fixture must not submit selections");
          return { needsConfirmation: false };
        } },
      });
      // Derive the path from the actual Main wiring, including for an asar layout.
      const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
      const relative = source.match(/preloadPath: path\.join\(__dirname, "([^"\n]*file-window-preload\.cjs)"\)/)?.[1];
      assert.ok(relative, "Main must point at bundled CJS");
      const devPreload = fileURLToPath(new URL(relative, import.meta.url));
      const packagedPreload = path.resolve(root, "app.asar/electron", relative);
      // One factory per layout keeps the production constructor and all IPC checks.
      files = createFileWindows({ client, office: panel, getMainWindow: () => main,
        getAccess: async () => ({ baseUrl: origin }), recentPath: path.join(root, "recent.json"),
        preloadPath: devPreload, loadWindow: (window) => window.loadURL(`${origin}/file-window.html`),
      });
      const handlers = new Map();
      const registry = { handle(name, handler) { handlers.set(name, handler); ipcMain.handle(name, handler); }, on: ipcMain.on.bind(ipcMain) };
      files.registerIpc(registry);
      panel.registerIpc(registry);
      ipcMain.handle("jugglework:file-editor:state", (event) => {
        assert.ok(files.windowFor(event.sender));
        return { fixture: "editor" };
      });
      ipcMain.handle("jugglework:desktop", (event, command) => {
        assert.ok(files.windowFor(event.sender));
        assert.equal(command, "__fetch");
        return { fixture: "fetch" };
      });
      const verify = async (window) => {
        const prefs = window.webContents.getLastWebPreferences();
        assert.equal(prefs.sandbox, true);
        assert.equal(prefs.contextIsolation, true);
        assert.equal(prefs.nodeIntegration, false);
        if (["darwin", "win32"].includes(process.platform)) {
          const renderer = app.getAppMetrics().find((entry) => entry.pid === window.webContents.getOSProcessId());
          assert.equal(renderer?.sandboxed, true, "renderer must be sandboxed at OS level");
        }
        const result = await window.webContents.executeJavaScript(`(async () => {
          const b = window.__JUGGLEWORK_ELECTRON__;
          if (!b) throw new Error('missing file-window bridge');
          let denied = false;
          try { await b.invokeDesktop('__arbitraryCommand'); } catch { denied = true; }
          await b.invokeDesktop('__setNativeTheme', 'dark');
          await b.invokeDesktop('__setApplicationMenuVisible', false);
          const events = [];
          window.fixtureEvents = events;
          window.fixtureStop = b.fileWindow.onChanged(value => events.push(value));
          return { keys: Object.keys(b).sort(), cloudKeys: Object.keys(b.cloudDocs).sort(), node: typeof require, process: typeof process,
            selection: typeof window.juggleworkOfficeSelection, cloudOpen: typeof b.fileWindow.openCloud, denied,
            available: await b.fileWindow.available(), state: await b.fileWindow.state(),
            resources: await b.office.resources('missing'), editor: await b.fileEditor.state({}),
            fetch: await b.invokeDesktop('__fetch', 'fixture') };
        })()`);
        assert.deepEqual(result.keys, ["cloudDocs", "fileEditor", "fileWindow", "invokeDesktop", "office", "platform"]);
        assert.deepEqual(result.cloudKeys, ["api", "highlightBlocks", "layoutCommand", "onAiReference", "onLayout", "onState", "setAppearance", "setBounds", "snapshot", "status"]);
        assert.equal(result.node, "undefined");
        assert.equal(result.process, "undefined");
        assert.equal(result.selection, "undefined");
        assert.equal(result.cloudOpen, "undefined");
        assert.equal(result.denied, true);
        assert.equal(result.available, true);
        assert.equal(result.state.activePath, "notes.md");
        assert.equal(result.resources, null);
        assert.deepEqual(result.editor, { fixture: "editor" });
        assert.deepEqual(result.fetch, { fixture: "fetch" });
        window.webContents.send("jugglework:file-window:changed", { fixture: "event" });
        assert.equal(await window.webContents.executeJavaScript("new Promise(resolve => { const poll = () => fixtureEvents.length ? resolve(fixtureEvents[0].fixture) : setTimeout(poll, 10); poll(); })"), "event");
        await window.webContents.executeJavaScript("fixtureStop(); fixtureEvents.length = 0;");
        window.webContents.send("jugglework:file-window:changed", { fixture: "unsubscribed" });
        assert.equal(await window.webContents.executeJavaScript("fixtureEvents.length"), 0);
      };
      await files.open({ workspaceId: "ws", sessionId: "dev", path: "notes.md" });
      const dev = files.windows()[0];
      await verify(dev);

      // 真实受限窗口只可复制 Main 发布的当前范围链接，不能伪造上传结果。
      const uploadEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
      const fileUploadEvent = { sender: dev.webContents, senderFrame: dev.webContents.mainFrame };
      const shareUrl = "https://t-fixture.docs.example/workspace/workspace/doc";
      const previousClipboard = await clipboard.readText();
      try {
        await handlers.get("jugglework:file-window:cloud-uploads")(uploadEvent, { scope: "current", records: [{ localWorkspaceId: "ws", path: "notes.md", tenantId: "org", url: shareUrl }] });
        const shareState = await dev.webContents.executeJavaScript("__JUGGLEWORK_ELECTRON__.fileWindow.state()");
        assert.equal(shareState.tabs.find(tab => tab.path === "notes.md").cloudUpload.url, shareUrl);
        await dev.webContents.executeJavaScript("__JUGGLEWORK_ELECTRON__.fileWindow.action('share-cloud')");
        assert.equal(await clipboard.readText(), shareUrl);
        assert.throws(() => handlers.get("jugglework:file-window:cloud-uploads")(fileUploadEvent, { scope: "forged", records: [] }), /来源无效/);
        await handlers.get("jugglework:file-window:cloud-uploads")(uploadEvent, { scope: null, records: [] });
        const cleared = await dev.webContents.executeJavaScript("__JUGGLEWORK_ELECTRON__.fileWindow.state()");
        assert.equal(cleared.tabs.find(tab => tab.path === "notes.md").cloudUpload, undefined);
        await assert.rejects(dev.webContents.executeJavaScript("__JUGGLEWORK_ELECTRON__.fileWindow.action('share-cloud')"));
      } finally { if (typeof previousClipboard === "string") await clipboard.writeText(previousClipboard); }

      // Real Office view in the file host: keep its existing preload and partition.
      await dev.webContents.executeJavaScript(`__JUGGLEWORK_ELECTRON__.office.show({ workspaceId: 'ws', documentId: 'sandbox-doc', bounds: { x: 0, y: 0, width: 200, height: 200 } })`);
      const view = dev.contentView.children[0];
      assert.ok(view?.webContents, "actual Office WebContentsView attached to file host");
      if (view.webContents.isLoading()) await once(view.webContents, "did-finish-load");
      const officePrefs = view.webContents.getLastWebPreferences();
      assert.equal(officePrefs.sandbox, true);
      assert.notEqual(view.webContents.session, dev.webContents.session);
      assert.equal(view.webContents.session.isPersistent(), false);
      assert.deepEqual(await view.webContents.executeJavaScript(`({ fileBridge: typeof window.__JUGGLEWORK_ELECTRON__, selection: Object.keys(window.juggleworkOfficeSelection).sort(), node: typeof require })`),
        { fileBridge: "undefined", selection: ["cancel", "capture", "onReview", "submit"], node: "undefined" });
      const officeEvent = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
      await files.open({ workspaceId: "ws", sessionId: "dev", path: "fixture.docx" });
      const fileEvent = { sender: dev.webContents, senderFrame: dev.webContents.mainFrame };
      await assert.rejects(handlers.get("jugglework:file-window:state")(officeEvent), /文件窗口已关闭/);
      await assert.rejects(handlers.get("jugglework:office:show")(officeEvent, {}), /Office view requires its host window/);
      panel.destroy();
      files.dispose();
      for (const name of handlers.keys()) ipcMain.removeHandler(name);
      files = createFileWindows({ client, office: panel, getMainWindow: () => main,
        getAccess: async () => ({ baseUrl: origin }), recentPath: path.join(root, "packaged-recent.json"),
        preloadPath: packagedPreload, loadWindow: (window) => window.loadFile(html),
      });
      files.registerIpc(ipcMain);
      panel.registerIpc(ipcMain);
      await files.open({ workspaceId: "ws", sessionId: "packaged", path: "notes.md" });
      await verify(files.windows()[0]);
      assert.deepEqual(preloadErrors, []);
      console.info(JSON.stringify({ result: "pass", electron: process.versions.electron, sandbox: true,
        checks: ["real-file-window-constructor", "dev-http-bridge", "packaged-asar-cjs-bridge", "ipc-event-cleanup", "no-renderer-node", "office-independent-preload-and-session", "office-not-host-authorized", "no-preload-errors"] }));
    } catch (error) { console.error(error); exitCode = 1; }
    finally {
      clearTimeout(timeout);
      panel?.destroy(); files?.dispose();
      if (main && !main.isDestroyed()) main.destroy();
      server?.closeAllConnections();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      app.exit(exitCode);
    }
  }
  void run();
} else {
  const { test } = await import("node:test");
  const { spawnSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { createPackage } = await import("@electron/asar");
  const { buildFileWindowPreload } = await import("../scripts/build-file-window-preload.mjs");
  const require = createRequire(import.meta.url);
  test("real Electron loads sandboxed file-window CJS in dev and asar layouts with independent Office permissions", { timeout: 55000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "file-window-sandbox-"));
    try {
      const preload = await buildFileWindowPreload();
      const staging = path.join(root, "staging");
      await mkdir(path.join(staging, "dist/preload"), { recursive: true });
      await copyFile(preload, path.join(staging, "dist/preload/file-window-preload.cjs"));
      await createPackage(staging, path.join(root, "app.asar"));
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(require("electron"), [fileURLToPath(import.meta.url), root], {
        env, encoding: "utf8", timeout: 50000,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /"result":"pass"/);
      console.info(result.stdout.trim());
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
