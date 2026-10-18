// Run explicitly with: pnpm --dir apps/desktop exec electron scripts/toonFactorySmoke.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createToonFactoryRuntime } from "../electron/toonFactoryRuntime.mjs";

const { app, BrowserWindow } = electron;
const execute = promisify(execFile);
const smokeTimeoutMs = 120_000;

async function withTimeout(promise, label, timeoutMs = 20_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`, { cause: lastError });
}

async function sidecarPids(entry) {
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const { stdout } = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
    const processes = JSON.parse(stdout || "[]");
    return (Array.isArray(processes) ? processes : [processes])
      .filter((item) => String(item.CommandLine ?? "").includes(entry))
      .map((item) => Number(item.ProcessId));
  }
  const { stdout } = await execute("ps", ["-axo", "pid=,command="]);
  return stdout.split("\n").flatMap((line) => line.includes(entry) ? [Number(line.trim().split(/\s+/, 1)[0])] : []).filter(Number.isFinite);
}

async function pageJson(view, source) {
  return withTimeout(view.webContents.executeJavaScript(source), "WebContentsView evaluation");
}

async function run() {
  const temporary = await mkdtemp(path.join(tmpdir(), "toonflow-electron-"));
  const moduleRoot = fileURLToPath(new URL("../resources/toonFactoryV2", import.meta.url));
  const sidecarEntry = path.join(moduleRoot, "server", "jugglework.js");
  const originalSidecars = new Set(await sidecarPids(sidecarEntry));
  let host;
  let window;
  let runtime;
  let exitCode = 0;
  const hardTimeout = setTimeout(() => {
    console.error(`toonFactorySmoke exceeded its ${smokeTimeoutMs}ms hard timeout`);
    void runtime?.dispose().catch(() => {});
    host?.closeAllConnections();
    void rm(temporary, { recursive: true, force: true }).catch(() => {}).finally(() => app.exit(1));
    setTimeout(() => app.exit(1), 5000).unref();
  }, smokeTimeoutMs);
  hardTimeout.unref();

  try {
    app.setPath("userData", temporary);
    const selectedDirectory = path.join(temporary, "selected-project");
    const secondDirectory = path.join(temporary, "second-project");
    await mkdir(selectedDirectory);
    await mkdir(secondDirectory);
    await writeFile(path.join(secondDirectory, "第二画布.json"), JSON.stringify({ toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }));
    const directorySelections = [selectedDirectory, secondDirectory];
    let directoryPickerCalls = 0;
    await withTimeout(app.whenReady(), "Electron ready");
    host = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer smoke-only-host-token");
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/models")) {
        res.end(JSON.stringify({ models: [{ providerId: "smoke", providerLabel: "Smoke provider", modelId: "text", label: "Smoke text", type: "text", protocol: "openai-completions" }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unsupported smoke endpoint" }));
    });
    host.listen(0, "127.0.0.1");
    await withTimeout(once(host, "listening"), "fake managed server startup");
    window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    runtime = createToonFactoryRuntime({
      app,
      getWindow: () => window,
      getAccess: () => ({ baseUrl: `http://127.0.0.1:${host.address().port}`, clientToken: "smoke-only-host-token" }),
      moduleRoot,
      dependencies: { dialog: { showOpenDialog: async () => { directoryPickerCalls += 1; return { filePaths: [directorySelections.shift()] }; } } },
    });

    assert.deepEqual(runtime.state(), { running: false, workspaceId: null, error: null });
    const [first, second] = await withTimeout(Promise.all([runtime.open("workspace-a"), runtime.open("workspace-a")]), "workspace A startup", 60_000);
    assert.equal(first.running, true);
    assert.equal(second.running, true);
    assert.equal(window.contentView.children.length, 1);
    const firstClipView = window.contentView.children[0];
    const firstView = firstClipView.children[0];
    const firstUrl = new URL(firstView.webContents.getURL());
    assert.equal((await fetch(`${firstUrl.origin}/health`)).status, 403);
    assert.equal(await pageJson(firstView, "typeof require"), "undefined");
    assert.equal(await pageJson(firstView, "typeof window.__JUGGLEWORK_ELECTRON__"), "undefined");
    runtime.layout({ x: 48, y: 0, width: 1232, height: 900 });
    await waitFor(() => pageJson(firstView, "location.hash === '#/home' && Boolean(document.querySelector('.home .creationPanel'))"), "managed home render");
    const initialProjectState = await runtime.enter();
    assert.equal(initialProjectState.currentDirectory, null);
    const home = await pageJson(firstView, `(() => ({ hash: location.hash, text: document.body.innerText, href: location.href }))()`);
    assert.equal(home.hash, "#/home");
    assert.ok(home.text.includes("灵感创作模式") && home.text.includes("工作目录"), home.text);
    assert.ok(!home.href.includes("hello") && !home.text.includes("启动失败"), home.text);

    const directoryGrant = await pageJson(firstView, `(async () => {
      const before = await fetch('/api/workspaces/check?directory=' + encodeURIComponent(${JSON.stringify(selectedDirectory)}), { headers: { 'x-toonflow-workspace': '1' } });
      return { beforeStatus: before.status, beforeBody: await before.json() };
    })()`);
    assert.equal(directoryGrant.beforeStatus, 403);
    assert.equal(directoryGrant.beforeBody.data.code, "DIRECTORY_GRANT_REQUIRED");
    const createdProject = await runtime.chooseProject();
    assert.equal(createdProject.mode, "created");
    assert.equal(createdProject.currentDirectory, await realpath(selectedDirectory));
    assert.ok(createdProject.projects.some((project) => project.directory === createdProject.currentDirectory));
    const createdCanvas = JSON.parse(await readFile(path.join(selectedDirectory, "画布1.json"), "utf8"));
    assert.equal(createdCanvas.toonflowCanvas, true);
    const grantedAfterCreate = await pageJson(firstView, `(async () => {
      const response = await fetch('/api/workspaces/check?directory=' + encodeURIComponent(${JSON.stringify(selectedDirectory)}), { headers: { 'x-toonflow-workspace': '1' } });
      return response.status;
    })()`);
    assert.equal(grantedAfterCreate, 200);
    const importedProject = await runtime.chooseProject();
    assert.equal(importedProject.mode, "imported");
    assert.equal(importedProject.currentDirectory, await realpath(secondDirectory));
    assert.equal(directoryPickerCalls, 2);
    const stableProjectOrder = importedProject.projects.map(project => project.directory);
    await waitFor(() => pageJson(firstView, `Boolean(document.querySelector('.floatingAgent.docked')) && getComputedStyle(document.querySelector('.floatingAgent')).display !== 'none'`), "project B docked agent render");
    await waitFor(() => pageJson(firstView, `[...document.querySelectorAll('.canvasPanel:not(.backgroundPanel) .canvasRuntime:not(.backgroundCanvas) .canvasPrimaryTools')].some(element => element.getClientRects().length > 0)`), "project B primary canvas toolbar render");
    const toolbarLayout = () => pageJson(firstView, `(() => {
      const toolbar = [...document.querySelectorAll('.canvasPanel:not(.backgroundPanel) .canvasRuntime:not(.backgroundCanvas) .canvasPrimaryTools')].find(element => element.getClientRects().length > 0);
      const flow = toolbar?.closest('.vue-flow');
      const controls = flow ? [...flow.querySelectorAll('.canvasControls')].find(element => element.getClientRects().length > 0) : null;
      if (!toolbar || !flow || !controls) return null;
      const buttons = [...toolbar.querySelectorAll('button')];
      const toolbarRect = toolbar.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      const flowRect = flow.getBoundingClientRect();
      return {
        labels: buttons.map(button => button.getAttribute('aria-label')),
        width: toolbarRect.width,
        height: toolbarRect.height,
        primary: { left: toolbarRect.left, right: toolbarRect.right, top: toolbarRect.top, bottom: toolbarRect.bottom },
        secondary: { left: controlsRect.left, right: controlsRect.right, top: controlsRect.top, bottom: controlsRect.bottom },
        expectedCenter: flowRect.left + flowRect.width / 2,
      };
    })()`);
    const wideToolbarLayout = await toolbarLayout();
    assert.deepEqual(wideToolbarLayout.labels, ['添加节点', '切换抓手/移动工具']);
    assert.ok(wideToolbarLayout.width <= 74 && wideToolbarLayout.height <= 44, JSON.stringify(wideToolbarLayout));
    assert.ok(Math.abs(wideToolbarLayout.primary.bottom - wideToolbarLayout.secondary.bottom) <= 2, JSON.stringify(wideToolbarLayout));
    assert.ok(Math.abs((wideToolbarLayout.primary.left + wideToolbarLayout.primary.right) / 2 - wideToolbarLayout.expectedCenter) <= 2, JSON.stringify(wideToolbarLayout));
    assert.ok(wideToolbarLayout.primary.left - wideToolbarLayout.secondary.right >= 22, JSON.stringify(wideToolbarLayout));
    await pageJson(firstView, `(() => {
      const button = document.querySelector('.canvasPanel:not(.backgroundPanel) .canvasRuntime:not(.backgroundCanvas) [aria-label="切换抓手/移动工具"]');
      button?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      button?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      return Boolean(button);
    })()`);
    await waitFor(() => pageJson(firstView, `(() => {
      const button = document.querySelector('.canvasPanel:not(.backgroundPanel) .canvasRuntime:not(.backgroundCanvas) [aria-label="切换抓手/移动工具"]');
      const canvas = document.querySelector('.canvasPanel:not(.backgroundPanel) .canvasRuntime.canvas:not(.backgroundCanvas)');
      return button?.getAttribute('aria-pressed') === 'true'
        && canvas?.classList.contains('handMode')
        && Boolean(button?.querySelector('.tabler-icon-hand-stop'));
    })()`), "hand tool toggle");
    const previousControlsWidth = await pageJson(firstView, `(() => {
      const panel = document.querySelector('.canvasPanel:not(.backgroundPanel) .canvasControlsPanel');
      const previous = panel.style.width;
      panel.style.width = '700px';
      return previous;
    })()`);
    await waitFor(async () => {
      const layout = await toolbarLayout();
      return layout?.secondary.top - layout?.primary.bottom >= 10;
    }, "stacked primary canvas toolbar");
    const narrowToolbarLayout = await toolbarLayout();
    assert.ok(narrowToolbarLayout.secondary.top - narrowToolbarLayout.primary.bottom >= 10, JSON.stringify(narrowToolbarLayout));
    assert.ok(narrowToolbarLayout.primary.right > narrowToolbarLayout.secondary.left && narrowToolbarLayout.primary.left < narrowToolbarLayout.secondary.right, JSON.stringify(narrowToolbarLayout));
    await pageJson(firstView, `document.querySelector('.canvasPanel:not(.backgroundPanel) .canvasControlsPanel').style.width = ${JSON.stringify(previousControlsWidth)}`);
    await waitFor(async () => {
      const layout = await toolbarLayout();
      return Math.abs(layout?.primary.bottom - layout?.secondary.bottom) <= 2
        && Math.abs((layout?.primary.left + layout?.primary.right) / 2 - layout?.expectedCenter) <= 2
        && layout?.primary.left - layout?.secondary.right >= 22;
    }, "inline primary canvas toolbar restored");
    await waitFor(() => pageJson(firstView, `document.querySelector('.workspaceNameInput input')?.value === 'second-project' && document.querySelector('.canvasTrigger span')?.textContent === '第二画布'`), "project B canvas render");
    const reopenedProject = await runtime.openProject(selectedDirectory);
    assert.equal(reopenedProject.currentDirectory, await realpath(selectedDirectory));
    assert.deepEqual(reopenedProject.projects.map(project => project.directory), stableProjectOrder);
    await waitFor(() => pageJson(firstView, `Boolean(document.querySelector('.floatingAgent.docked')) && getComputedStyle(document.querySelector('.floatingAgent')).display !== 'none'`), "project A docked agent render");
    await waitFor(() => pageJson(firstView, `document.querySelector('.workspaceNameInput input')?.value === 'selected-project' && document.querySelector('.canvasTrigger span')?.textContent === '画布1'`), "project A canvas render");
    const switchedProject = await runtime.openProject(secondDirectory);
    assert.equal(switchedProject.currentDirectory, await realpath(secondDirectory));
    assert.deepEqual(switchedProject.projects.map(project => project.directory), stableProjectOrder);
    await waitFor(() => pageJson(firstView, `document.querySelector('.workspaceNameInput input')?.value === 'second-project' && document.querySelector('.canvasTrigger span')?.textContent === '第二画布'`), "project B canvas rerender");
    await pageJson(firstView, `document.querySelector('[aria-label="退出项目"]')?.click()`);
    await waitFor(() => pageJson(firstView, `Boolean([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent?.trim() === '退出项目'))`), "exit project confirmation");
    await pageJson(firstView, `[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent?.trim() === '退出项目')?.click()`);
    await waitFor(() => pageJson(firstView, `location.hash === '#/home' && window.__TOONFLOW_JUGGLEWORK_HOST__?.getProjectState().currentDirectory === null`), "project exit host state");
    const exitedProjectState = await runtime.projectState();
    assert.equal(exitedProjectState.currentDirectory, null);
    assert.deepEqual(exitedProjectState.projects.map(project => project.directory), stableProjectOrder);
    const selectedAgain = await runtime.openProject(secondDirectory);
    assert.equal(selectedAgain.currentDirectory, await realpath(secondDirectory));
    assert.deepEqual(selectedAgain.projects.map(project => project.directory), stableProjectOrder);
    await waitFor(() => pageJson(firstView, `location.hash === '#/workspace' && document.querySelector('.canvasTrigger span')?.textContent === '第二画布'`), "project B after exit selection");
    const canonicalSecondDirectory = await realpath(secondDirectory);
    const renamedProjectState = await runtime.renameProject(canonicalSecondDirectory, "自定义漫剧名称");
    assert.equal(renamedProjectState.projects.find(project => project.directory === canonicalSecondDirectory)?.name, "自定义漫剧名称");
    const removedProjectState = await runtime.removeProject(canonicalSecondDirectory);
    assert.equal(removedProjectState.currentDirectory, null);
    assert.ok(!removedProjectState.projects.some(project => project.directory === canonicalSecondDirectory));
    assert.equal(JSON.parse(await readFile(path.join(secondDirectory, "第二画布.json"), "utf8")).toonflowCanvas, true);
    await waitFor(() => pageJson(firstView, `location.hash === '#/home'`), "home after removing active project");
    const restoredRemovedProject = await runtime.openProject(secondDirectory);
    assert.equal(restoredRemovedProject.currentDirectory, await realpath(secondDirectory));
    const ffmpegStatuses = await pageJson(firstView, `(async () => Promise.all([
      '/api/ffmpeg/cancel', '/api/ffmpeg/download', '/api/ffmpeg/events',
      '/api/ffmpeg/execute', '/api/ffmpeg/progress', '/api/ffmpeg/status',
    ].map(async path => (await fetch(path, { method: 'POST' })).status)))()`);
    assert.deepEqual(ffmpegStatuses, [403, 403, 403, 403, 403, 403]);

    const catalog = await pageJson(firstView, `(async () => {
      const response = await fetch('/api/settings/get', { headers: { 'x-toonflow-workspace': '1', 'Cache-Control': 'no-cache' } });
      const body = await response.json();
      return { status: response.status, body };
    })()`);
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.data.juggleworkManaged, true);
    assert.deepEqual(catalog.body.data.customProviders, [{
      id: "smoke", label: "Smoke provider", protocol: "openai-completions", apiUrl: "", apiKey: "", models: [{ id: "text", label: "Smoke text" }],
    }]);
    assert.equal(JSON.stringify(catalog).includes("smoke-only-host-token"), false);

    const saveA = await pageJson(firstView, `(async () => {
      const response = await fetch('/api/settings/save', {
        method: 'PUT', headers: { 'x-toonflow-workspace': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { ui: { smokeWorkspace: 'A' } } }),
      });
      return { status: response.status, body: await response.json() };
    })()`);
    assert.equal(saveA.status, 200, JSON.stringify(saveA));
    const runningA = (await sidecarPids(sidecarEntry)).filter((pid) => !originalSidecars.has(pid));
    assert.equal(runningA.length, 1, `expected one workspace A Bun sidecar, found ${runningA.join(", ")}`);

    runtime.hide();
    assert.equal(firstClipView.getVisible(), false);
    await withTimeout(runtime.open("workspace-a"), "workspace A reopen");
    assert.equal(window.contentView.children[0], firstClipView);
    runtime.layout({ x: 48, y: 0, width: 1232, height: 900 });
    assert.equal(firstClipView.getVisible(), true);
    const navigationReturn = await runtime.enter();
    assert.equal(navigationReturn.currentDirectory, await realpath(secondDirectory));
    assert.deepEqual(navigationReturn.projects.map(project => project.directory), stableProjectOrder);
    await waitFor(() => pageJson(firstView, `location.hash === '#/workspace' && document.querySelector('.canvasTrigger span')?.textContent === '第二画布'`), "project B after navigation return");

    await withTimeout(runtime.open("workspace-b"), "workspace B startup", 60_000);
    assert.equal(window.contentView.children.length, 1);
    const secondClipView = window.contentView.children[0];
    const secondView = secondClipView.children[0];
    assert.notEqual(secondView, firstView);
    await waitFor(() => pageJson(secondView, "location.hash === '#/home' && Boolean(document.querySelector('.home .creationPanel'))"), "workspace B managed home render");
    const settingsB = await pageJson(secondView, `(async () => (await (await fetch('/api/settings/get', { headers: { 'x-toonflow-workspace': '1' } })).json()).data)()`);
    assert.notEqual(settingsB.ui?.smokeWorkspace, "A");
    const revokedGrant = await pageJson(secondView, `(async () => {
      const response = await fetch('/api/workspaces/check?directory=' + encodeURIComponent(${JSON.stringify(selectedDirectory)}), { headers: { 'x-toonflow-workspace': '1' } });
      return { status: response.status, body: await response.json() };
    })()`);
    assert.equal(revokedGrant.status, 403);
    assert.equal(revokedGrant.body.data.code, "DIRECTORY_GRANT_REQUIRED");
    await waitFor(async () => !(await sidecarPids(sidecarEntry)).includes(runningA[0]), "workspace A sidecar exit");
    const runningB = (await sidecarPids(sidecarEntry)).filter((pid) => !originalSidecars.has(pid));
    assert.equal(runningB.length, 1, `expected one workspace B Bun sidecar, found ${runningB.join(", ")}`);

    await withTimeout(runtime.open("workspace-a"), "workspace A isolation reopen", 60_000);
    const thirdView = window.contentView.children[0].children[0];
    const settingsA = await pageJson(thirdView, `(async () => (await (await fetch('/api/settings/get', { headers: { 'x-toonflow-workspace': '1' } })).json()).data)()`);
    assert.equal(settingsA.ui?.smokeWorkspace, "A");
    const reauthorizedProject = await runtime.openProject(await realpath(selectedDirectory));
    assert.equal(reauthorizedProject.currentDirectory, await realpath(selectedDirectory));
    assert.deepEqual(reauthorizedProject.projects.map(project => project.directory), stableProjectOrder);
    await waitFor(() => pageJson(thirdView, `document.querySelector('.workspaceNameInput input')?.value === 'selected-project' && document.querySelector('.canvasTrigger span')?.textContent === '画布1'`), "project A render after grant renewal");
    const restoredSecondProject = await runtime.openProject(await realpath(secondDirectory));
    assert.equal(restoredSecondProject.currentDirectory, await realpath(secondDirectory));
    assert.deepEqual(restoredSecondProject.projects.map(project => project.directory), stableProjectOrder);
    await waitFor(() => pageJson(thirdView, `document.querySelector('.workspaceNameInput input')?.value === 'second-project' && document.querySelector('.canvasTrigger span')?.textContent === '第二画布'`), "project B render after grant renewal");
    assert.equal(directoryPickerCalls, 2);
    const finalOrigin = new URL(thirdView.webContents.getURL()).origin;
    await withTimeout(runtime.dispose(), "runtime disposal");
    assert.deepEqual(runtime.state(), { running: false, workspaceId: null, error: null });
    assert.equal(window.contentView.children.length, 0);
    await assert.rejects(fetch(`${finalOrigin}/health`));
    await waitFor(async () => (await sidecarPids(sidecarEntry)).every((pid) => originalSidecars.has(pid)), "all smoke Bun sidecars to exit");

    console.log("PASS: real Electron/WebContentsView and Bun sidecar, directory grants, FFmpeg denial, managed home, secret-free catalog, workspace isolation, clean child shutdown");
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    exitCode = 1;
  } finally {
    clearTimeout(hardTimeout);
    await runtime?.dispose().catch(() => {});
    if (window && !window.isDestroyed()) window.destroy();
    host?.closeAllConnections();
    await new Promise((resolve) => host?.close(() => resolve()) ?? resolve());
    await rm(temporary, { recursive: true, force: true });
    app.exit(exitCode);
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  app.exit(1);
});
