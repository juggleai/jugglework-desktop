// Run explicitly with Electron, not node: electron scripts/file-window-isolation-smoke.mjs
// Uses only a temporary userData directory, loopback fixture pages and synthetic canaries.
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { createFileWindows } from "../electron/file-windows.mjs";
import { createOfficePanel } from "../electron/office-panel.mjs";
import { createOfficeResources } from "../electron/office-resources.mjs";

const root = mkdtempSync(path.join(tmpdir(), "juggle-file-storage-canary-"));
app.setPath("userData", root);
async function run() {
let stage = "app ready";
const timer = setTimeout(() => { console.error(`Electron isolation smoke timed out: ${stage}`); app.exit(1); }, 30000);
let main, files, panel, server;
let exitCode = 0;
try {
  await app.whenReady();
  stage = "main fixture load";
  server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/resource-probe" ? "text/plain" : "text/html");
    res.end(req.url === "/resource-probe" ? "office-resource-canary" : "<!doctype html><html lang='zh' data-theme='dark'><head></head><body>storage isolation fixture</body></html>");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  main = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await main.loadURL(origin);
  await main.webContents.executeJavaScript(`localStorage.setItem('isolation-canary', 'main-only-synthetic'); document.cookie = 'isolationCanary=main-only; SameSite=Strict'`);
  const resources = createOfficeResources({
    assetsDirectory: fileURLToPath(new URL("../resources/office-assets", import.meta.url)),
    cacheDirectory: path.join(root, "fonts"),
  });
  const document = { documentId: "storage-canary-doc", pageId: "page-canary", workspaceId: "ws", ownerSessionId: "a", relativePath: "fixture.docx", state: "ready", previewUrl: `${origin}/static/doc/pc.html?localFilePath=/fixture.docx` };
  const client = {
    getJson: async (url) => url === "/workspaces" ? { items: [{ id: "ws", path: root }] }
      : url.includes("/files/stat") ? { exists: true, kind: "file" }
      : url.endsWith("/transfer-status") ? { documentId: document.documentId, reason: null }
      : { document },
    postJson: async () => ({ document }),
  };
  panel = createOfficePanel({ client, resources, getWindow: () => main, getWindows: () => files.windows(),
    resolveWindow: (sender) => sender === main.webContents ? main : files.windowFor(sender) });
  files = createFileWindows({ client, office: panel, getMainWindow: () => main,
    getAccess: async () => ({ baseUrl: origin }), recentPath: path.join(root, "recent.json"),
    preloadPath: undefined, iconPath: undefined, loadWindow: (window) => window.loadURL(origin),
  });
  stage = "file windows open";
  await files.open({ workspaceId: "ws", sessionId: "a", path: "notes.md" });
  await files.open({ workspaceId: "ws", sessionId: "b", path: "notes.md" });
  const [a, b] = files.windows();
  const read = (contents) => contents.executeJavaScript(`({ value: localStorage.getItem('isolation-canary'), cookie: document.cookie })`);
  for (const window of [a, b]) {
    assert.notEqual(window.webContents.session, main.webContents.session);
    assert.equal(window.webContents.session.isPersistent(), false);
    assert.deepEqual(await read(window.webContents), { value: null, cookie: "" });
  }
  await a.webContents.executeJavaScript(`localStorage.setItem('isolation-canary', 'file-a-only'); document.cookie = 'isolationCanary=file-a; SameSite=Strict'`);
  assert.deepEqual(await read(b.webContents), { value: null, cookie: "" });
  assert.equal((await read(main.webContents)).value, "main-only-synthetic");

  const handlers = new Map();
  stage = "Office create";
  panel.registerIpc({ handle: (name, fn) => handlers.set(name, fn) });
  const show = (window) => handlers.get("jugglework:office:show")({ sender: window.webContents, senderFrame: window.webContents.mainFrame },
    { workspaceId: "ws", documentId: document.documentId, prepareOnly: true, bounds: { x: 0, y: 0, width: 100, height: 100 } });
  // prepareOnly creates the actual Office WebContentsView without showing the hidden main window.
  await show(main);
  // The ready Office view is attached on the normal show path; make only the synthetic main visible.
  main.showInactive();
  await handlers.get("jugglework:office:show")({ sender: main.webContents, senderFrame: main.webContents.mainFrame },
    { workspaceId: "ws", documentId: document.documentId, bounds: { x: 0, y: 0, width: 100, height: 100 } });
  const view = main.contentView.children[0];
  assert.ok(view?.webContents, "actual Office view attached");
  stage = "Office load";
  if (view.webContents.isLoading()) await once(view.webContents, "did-finish-load");
  const partition = view.webContents.session;
  assert.notEqual(partition, main.webContents.session);
  assert.notEqual(partition, a.webContents.session);
  assert.equal(partition.isPersistent(), false);
  assert.deepEqual(await read(view.webContents), { value: null, cookie: "" });
  assert.equal(await partition.protocol.isProtocolHandled("http"), true);
  assert.equal(await partition.protocol.isProtocolHandled("https"), true);
  stage = "Office resources";
  assert.equal(await view.webContents.executeJavaScript(`fetch('/resource-probe').then(r=>r.text())`), "office-resource-canary");
  assert.equal(await view.webContents.executeJavaScript(`fetch('https://example.invalid/blocked').then(r=>r.status===410,()=>true)`), true);
  const pageId = view.webContents.id;
  stage = "Office transfer";
  if (process.platform === "darwin" && process.arch === "arm64") {
    assert.equal(await panel.transfer(document.documentId, a), true);
    await handlers.get("jugglework:office:show")({ sender: a.webContents, senderFrame: a.webContents.mainFrame },
      { workspaceId: "ws", documentId: document.documentId, bounds: { x: 0, y: 0, width: 100, height: 100 } });
    assert.equal(a.contentView.children[0].webContents.id, pageId);
    assert.equal(a.contentView.children[0].webContents.session, partition);
    assert.equal(await view.webContents.executeJavaScript(`fetch('/resource-probe').then(r=>r.text())`), "office-resource-canary");
  }
  stage = "file reopen";
  a.destroy();
  await files.open({ workspaceId: "ws", sessionId: "a", path: "notes.md" });
  const reopened = files.windows().find((window) => window !== b);
  assert.deepEqual(await read(reopened.webContents), { value: null, cookie: "" });
  console.info(JSON.stringify({ result: "pass", electron: process.versions.electron, chromium: process.versions.chrome,
    checks: ["default-session-canary-isolated", "file-windows-mutually-isolated", "nonpersistent-sessions", "reopen-fresh-storage", "office-isolated", "office-http-https-handlers", "office-loopback-resource", "office-network-denied"],
    officeTransfer: process.platform === "darwin" && process.arch === "arm64" ? "same-webContents-and-session-pass" : "not-tested-platform" }));
} catch (error) { console.error(`Electron isolation smoke failed: ${stage}`, error); exitCode = 1; }
finally {
  stage = "cleanup";
  clearTimeout(timer);
  panel?.destroy(); files?.dispose();
  if (main && !main.isDestroyed()) main.destroy();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  // Chromium can still hold temporary storage files until process exit; only this synthetic directory is removed.
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  app.exit(exitCode);
}
}
// Let Electron finish ESM entry initialization before awaiting its ready event.
void run();
