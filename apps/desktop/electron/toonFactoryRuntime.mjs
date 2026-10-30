import * as electron from "electron";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, access, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import path from "node:path";
import { verifyToonFactoryBundle } from "./toonFactoryBundle.mjs";
import { createToonFactoryVideoEditor } from "./toonFactoryVideoEdit.mjs";

export const TOON_FACTORY_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const verifiedBundles = new Map();

export function verifyToonFactoryRuntimeBundle(moduleRoot, expected, verifyBundle = verifyToonFactoryBundle) {
  const manifestPath = path.join(moduleRoot, "build-manifest.json");
  const stat = statSync(manifestPath);
  const key = `${path.resolve(moduleRoot)}\0${expected.platform}\0${expected.arch}`;
  const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = verifiedBundles.get(key);
  if (cached?.fingerprint === fingerprint) return cached.result;
  const result = verifyBundle(moduleRoot, expected);
  verifiedBundles.set(key, { fingerprint, result });
  return result;
}

export function toonFactoryWorkspaceScopeKey(workspaceId) {
  return createHash("sha256").update(workspaceId, "utf8").digest("hex");
}

const directoryGrantsFileName = "directory-grants.json";

function directoryGrantKey(directory, platform = process.platform) {
  const key = path.resolve(directory);
  return platform === "win32" ? key.toLowerCase() : key;
}

async function readDirectoryGrants(dataDirectory, platform) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path.join(dataDirectory, directoryGrantsFileName), "utf8")); }
  catch { return new Map(); }
  if (parsed?.version !== 1 || !Array.isArray(parsed.directories) || parsed.directories.length > 1000) return new Map();
  const grants = new Map();
  for (const entry of parsed.directories) {
    if (typeof entry !== "string" || !path.isAbsolute(entry) || entry.length > 4096) continue;
    try {
      const canonical = await realpath(entry);
      if (!(await stat(canonical)).isDirectory()) continue;
      grants.set(directoryGrantKey(canonical, platform), canonical);
    } catch {}
  }
  return grants;
}

async function writeDirectoryGrants(dataDirectory, grants) {
  const target = path.join(dataDirectory, directoryGrantsFileName);
  await writeFile(target, `${JSON.stringify({ version: 1, directories: [...grants.values()] }, null, 2)}\n`, { mode: 0o600 });
}

function createSecretRedactor(secrets) {
  const values = secrets.filter(Boolean);
  const retainedLength = Math.max(0, ...values.map((value) => value.length - 1));
  let pending = "";
  const redact = (value) => values.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString();
      const redacted = redact(pending);
      const outputLength = Math.max(0, redacted.length - retainedLength);
      if (outputLength) this.push(redacted.slice(0, outputLength));
      pending = redacted.slice(outputLength);
      callback();
    },
    flush(callback) {
      if (pending) this.push(redact(pending));
      callback();
    },
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    const onError = () => finish(true);
    function finish(exited) {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    }
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null) finish(true);
  });
}

function waitForProcessGroupExit(processKill, pid, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      try { processKill(-pid, 0); }
      catch (error) {
        if (error?.code === "ESRCH") { resolve(true); return; }
      }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(check, 20);
    }
    check();
  });
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => finish(reject, signal.reason);
    const finish = (complete, value) => {
      signal.removeEventListener("abort", abort);
      complete(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function waitForPageReady(promise, signal, timeoutMs) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error("漫剧工厂页面启动超时，请检查模块日志")), timeoutMs);
    const abort = () => finish(reject, signal.reason);
    const finish = (complete, value) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      complete(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function runTaskkill(pid, force, spawnTaskkill = spawn) {
  return new Promise((resolve) => {
    const killer = spawnTaskkill("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { killer.kill(); finish(); }, 2000);
    function finish() {
      clearTimeout(timer);
      killer.off("error", finish);
      killer.off("exit", finish);
      resolve();
    }
    killer.once("error", finish);
    killer.once("exit", finish);
  });
}

export async function terminateSidecarProcess(child, {
  platform = process.platform,
  processKill = process.kill,
  spawnTaskkill = spawn,
  detached = false,
  parentPid = process.pid,
  gracefulTimeoutMs = 3000,
  forceTimeoutMs = 2000,
} = {}) {
  if (!child) return;
  const pid = child.pid;
  const canKillGroup = detached && Number.isSafeInteger(pid) && pid > 1 && pid !== parentPid;
  if (child.exitCode !== null && !canKillGroup) return;
  let groupSignaled = canKillGroup;
  if (platform === "win32" && Number.isSafeInteger(pid) && pid > 0) await runTaskkill(pid, false, spawnTaskkill);
  else if (canKillGroup) {
    try { processKill(-pid, "SIGTERM"); }
    catch {
      groupSignaled = false;
      try { child.kill("SIGTERM"); } catch {}
    }
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }
  const exited = groupSignaled
    ? await waitForProcessGroupExit(processKill, pid, gracefulTimeoutMs)
    : await waitForChildExit(child, gracefulTimeoutMs);
  if (exited) return;
  if (platform === "win32" && Number.isSafeInteger(pid) && pid > 0) await runTaskkill(pid, true, spawnTaskkill);
  else if (groupSignaled) {
    try { processKill(-pid, "SIGKILL"); }
    catch {
      groupSignaled = false;
      try { child.kill("SIGKILL"); } catch {}
    }
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
  if (groupSignaled) await Promise.all([
    waitForProcessGroupExit(processKill, pid, forceTimeoutMs),
    waitForChildExit(child, forceTimeoutMs),
  ]);
  else await waitForChildExit(child, forceTimeoutMs);
}

/**
 * @param {object} options
 * @param {Pick<import("electron").App, "getPath">} options.app
 * @param {() => ({ contentView: { addChildView(view: any): void, removeChildView(view: any): void }, getContentSize(): number[], webContents: { getZoomFactor(): number } } | null)} options.getWindow
 * @param {() => ({ baseUrl: string, clientToken: string } | null | Promise<{ baseUrl: string, clientToken: string } | null>)} options.getAccess
 * @param {string} options.moduleRoot
 * @param {Record<string, any>} [options.dependencies]
 * @param {number} [options.idleTimeoutMs]
 */
export function createToonFactoryRuntime({ app, getWindow, getAccess, moduleRoot, dependencies = {}, idleTimeoutMs = TOON_FACTORY_IDLE_TIMEOUT_MS }) {
  const View = dependencies.View ?? electron.View;
  const WebContentsView = dependencies.WebContentsView ?? electron.WebContentsView;
  const session = dependencies.session ?? electron.session;
  const dialog = dependencies.dialog ?? electron.dialog;
  const clipboard = dependencies.clipboard ?? electron.clipboard;
  const shell = dependencies.shell ?? electron.shell;
  const fetchImpl = dependencies.fetch ?? fetch;
  const spawnSidecar = dependencies.spawn ?? spawn;
  const processKill = dependencies.processKill ?? process.kill;
  const spawnTaskkill = dependencies.spawnTaskkill ?? spawn;
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const verifyBundle = dependencies.verifyToonFactoryBundle ?? verifyToonFactoryBundle;
  const setIdleTimeout = dependencies.setTimeout ?? setTimeout;
  const clearIdleTimeout = dependencies.clearTimeout ?? clearTimeout;
  const detachedSidecars = new WeakSet();
  let child, broker, clipView, view, log, origin, browserSession, stdoutRedactor, stderrRedactor, startup;
  let bridgeToken = null, pageToken = null, workspaceId = null, workspaceScopeKey = null, dataDirectory = null;
  let failure = null, ready = false;
  let disposed = false;
  /** @type {Promise<any>} */
  let lifecycle = Promise.resolve();
  let disposePromise = null;
  let requestedBounds = null;
  let hidden = false;
  let idleTimer = null;
  const saveTargets = new Map();
  let directoryGrants = new Map();
  const videoEditor = createToonFactoryVideoEditor({ isDirectoryGranted: directory => directoryGrants.has(directoryGrantKey(directory, platform)) });
  let approvedProjectDirectory = null;
  const enteredWorkspaceIds = new Set();
  const state = () => ({ running: Boolean(ready && child && child.exitCode === null && origin && !failure), workspaceId, error: failure });
  function cancelIdleClose() {
    if (idleTimer === null) return;
    clearIdleTimeout(idleTimer);
    idleTimer = null;
  }
  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  function enqueue(operation) {
    const pending = lifecycle.then(operation);
    lifecycle = pending.catch(() => {});
    return pending;
  }
  function scheduleIdleClose() {
    cancelIdleClose();
    if (disposed || !workspaceId) return;
    const timer = setIdleTimeout(() => {
      if (!hidden || idleTimer !== timer) return;
      idleTimer = null;
      void enqueue(async () => {
        await stop();
        failure = null;
      });
    }, idleTimeoutMs);
    idleTimer = timer;
  }
  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 140 * 1024 * 1024) throw new Error("请求内容过大"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }
  async function native(command, args) {
    const window = getWindow();
    if (command === "selectDirectory") {
      // A host-confirmed project authorization reuses the sidecar's normal grant flow once.
      const approved = approvedProjectDirectory;
      approvedProjectDirectory = null;
      const selected = approved ?? (await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] })).filePaths[0];
      if (!selected) return null;
      const canonical = await realpath(selected);
      if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录授权必须是文件夹");
      directoryGrants.set(directoryGrantKey(canonical, platform), canonical);
      if (!dataDirectory) throw new Error("漫剧工厂工作区尚未就绪");
      await writeDirectoryGrants(dataDirectory, directoryGrants);
      return canonical;
    }
    if (command === "directoryGrants") return [...directoryGrants.values()];
    if (command === "selectProviderFile") return null;
    if (command === "readClipboardText") return clipboard.readText();
    if (command === "writeClipboardText") { clipboard.writeText(String(args[0] ?? "")); return null; }
    if (command === "selectSaveFile") {
      const result = await dialog.showSaveDialog(window, { defaultPath: path.basename(String(args[0] ?? "export")) });
      if (result.canceled || !result.filePath) return null;
      const token = randomUUID(); saveTargets.set(token, result.filePath); return token;
    }
    if (command === "saveFile") {
      const target = saveTargets.get(args[0]); if (!target) throw new Error("保存授权已失效，请重新选择文件");
      saveTargets.delete(args[0]); await writeFile(target, Buffer.from(String(args[1]), "base64")); return true;
    }
    if (command === "ready") { startup?.pageReady(Boolean(args[0])); return null; }
    if (command === "openDevTools") { view?.webContents.openDevTools({ mode: "detach" }); return null; }
    throw new Error("不支持的桌面操作");
  }
  async function bridge(req, res) {
    const requestBridgeToken = bridgeToken;
    const requestWorkspaceId = workspaceId;
    if (!requestBridgeToken || !requestWorkspaceId || (req.headers.authorization !== `Bearer ${requestBridgeToken}` && req.headers["x-api-key"] !== requestBridgeToken) || req.headers.origin) { res.writeHead(403).end(); return; }
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/desktop/") && req.method === "POST") {
        const result = await native(url.pathname.slice(9), (await readJson(req)).args ?? []);
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ result })); return;
      }
      if (req.method === "POST" && url.pathname === "/videoEdit") {
        const input = await readJson(req);
        if (bridgeToken !== requestBridgeToken || workspaceId !== requestWorkspaceId) throw new Error("剪辑工作区授权已失效");
        const result = await videoEditor.execute(input, controller.signal);
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result)); return;
      }
      const access = await getAccess(); if (!access) throw new Error("JuggleWork 模型服务尚未就绪");
      const prefix = `${access.baseUrl}/workspace/${encodeURIComponent(requestWorkspaceId)}/toonflow`;
      let endpoint, body;
      if (req.method === "GET" && url.pathname === "/catalog") endpoint = `${prefix}/models`;
      else if (req.method === "POST" && url.pathname.startsWith("/model/")) {
        const match = url.pathname.match(/^\/model\/([^/]+)\/(chat\/completions|responses|(?:v1\/)?messages)$/);
        if (!match) throw new Error("不支持的模型协议");
        const payload = await readJson(req);
        endpoint = `${prefix}/proxy/${match[1]}/${match[2] === "chat/completions" ? "chat" : match[2].replace("v1/", "")}`;
        body = JSON.stringify({ modelId: payload.model, payload });
      } else if (req.method === "POST" && url.pathname === "/invoke") {
        const input = await readJson(req);
        if (!["image", "video", "videoStatus", "videoContent", "videoCancel"].includes(input.operation)) throw new Error("不支持的媒体操作");
        endpoint = `${prefix}/proxy/${encodeURIComponent(input.providerId)}/${input.operation}`;
        body = JSON.stringify(input);
      } else { res.writeHead(404).end(); return; }
      const response = await fetchImpl(endpoint, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${access.clientToken}`, "Content-Type": "application/json" }, body, signal: controller.signal, redirect: "error" });
      res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" });
      if (response.body) await pipeline(Readable.fromWeb(response.body), res); else res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      if (!res.destroyed) res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "模块请求失败" } }));
    }
  }
  async function callPage(method, args = []) {
    if (!ready || !view || view.webContents.isDestroyed()) throw new Error("漫剧工厂尚未就绪");
    const source = `(async () => {
      const bridge = globalThis.__TOONFLOW_JUGGLEWORK_HOST__;
      if (!bridge || typeof bridge[${JSON.stringify(method)}] !== "function") throw new Error("漫剧项目桥接尚未就绪");
      try {
        return await bridge[${JSON.stringify(method)}](...${JSON.stringify(args)});
      } catch (error) {
        // Electron only preserves the message when a page error crosses IPC.
        if (error?.response?.status === 403 && error.response.data?.data?.code === "DIRECTORY_GRANT_REQUIRED") {
          throw new Error("[DIRECTORY_GRANT_REQUIRED] 项目文件夹需要重新授权，请点击授权并打开。");
        }
        throw error;
      }
    })()`;
    return view.webContents.executeJavaScript(source, true);
  }
  function layout(bounds) {
    if (bounds) {
      hidden = false;
      cancelIdleClose();
    }
    requestedBounds = bounds;
    if (!clipView || !view || view.webContents.isDestroyed()) return;
    if (!bounds) { clipView.setVisible(false); return; }
    const window = getWindow(); if (!window) return;
    const [width, height] = window.getContentSize();
    const zoom = window.webContents.getZoomFactor();
    const x = Math.max(48, Math.round(Number(bounds.x) * zoom));
    const y = Math.max(0, Math.round(Number(bounds.y) * zoom));
    const w = Math.max(0, Math.min(width - x, Math.round(Number(bounds.width) * zoom)));
    const h = Math.max(0, Math.min(height - y, Math.round(Number(bounds.height) * zoom)));
    if (![x, y, w, h].every(Number.isFinite)) throw new Error("页面尺寸无效");
    const clipLeftValue = bounds.clipLeft === undefined ? 0 : Number(bounds.clipLeft);
    if (!Number.isFinite(clipLeftValue) || clipLeftValue < 0 || clipLeftValue > Number(bounds.width)) throw new Error("页面裁剪尺寸无效");
    const clipLeft = Math.max(0, Math.min(w, Math.round(clipLeftValue * zoom)));
    // Native child views are not clipped by the host DOM's overflow or radius.
    // The expanded secondary sidebar owns the left edge, so the content view becomes
    // square there just like the automation page. The collapsed layout keeps all corners.
    const borderRadius = bounds.borderRadius === undefined ? 17 : Number(bounds.borderRadius);
    if (!Number.isFinite(borderRadius) || borderRadius < 0 || borderRadius > 64) throw new Error("页面圆角无效");
    view.setBorderRadius(Math.round(borderRadius * zoom));
    // Keep the WebContentsView viewport fixed so temporary host overlays do not trigger
    // responsive reflow. Rail previews use an in-memory snapshot before hiding this view.
    clipView.setBounds({ x: x + clipLeft, y, width: w - clipLeft, height: h });
    view.setBounds({ x: clipLeft === 0 ? 0 : -clipLeft, y: 0, width: w, height: h });
    clipView.setVisible(w - clipLeft > 0 && h > 0 && !failure);
  }
  async function stop() {
    bridgeToken = null;
    await videoEditor.stop();
    startup?.controller.abort(new Error("漫剧工厂启动已取消"));
    cancelIdleClose();
    ready = false; origin = null; requestedBounds = null;
    const previousClipView = clipView; clipView = null;
    const previousView = view; view = null;
    const previousSession = browserSession; browserSession = null;
    const previousChild = child; child = null;
    const previousBroker = broker; broker = null;
    const previousLog = log; log = null;
    const previousStdoutRedactor = stdoutRedactor;
    const previousStderrRedactor = stderrRedactor;
    const redactors = [previousStdoutRedactor, previousStderrRedactor].filter(Boolean);
    stdoutRedactor = null; stderrRedactor = null;
    workspaceId = null; workspaceScopeKey = null;
    bridgeToken = null; pageToken = null;
    saveTargets.clear();

    try { previousSession?.setPermissionRequestHandler(null); } catch {}
    try { previousSession?.webRequest.onBeforeSendHeaders(null); } catch {}
    if (previousClipView) {
      try { getWindow()?.contentView.removeChildView(previousClipView); } catch {}
      try { if (previousView) previousClipView.removeChildView(previousView); } catch {}
    }
    if (previousView) {
      try { previousView.webContents.removeAllListeners("will-navigate"); previousView.webContents.removeAllListeners("render-process-gone"); } catch {}
      try { if (!previousView.webContents.isDestroyed()) previousView.webContents.close(); } catch {}
    }
    await terminateSidecarProcess(previousChild, {
      platform,
      processKill,
      spawnTaskkill,
      detached: Boolean(previousChild && detachedSidecars.has(previousChild)),
    });
    previousChild?.stdout?.unpipe(previousStdoutRedactor);
    previousChild?.stderr?.unpipe(previousStderrRedactor);
    if (previousBroker) {
      try { previousBroker.closeAllConnections(); } catch {}
      await Promise.race([new Promise((resolve) => {
        try { previousBroker.close(() => resolve()); } catch { resolve(); }
      }), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    const redactorEnds = redactors.map((redactor) => redactor.readableEnded ? Promise.resolve() : once(redactor, "end").catch(() => {}));
    for (const redactor of redactors) redactor.end();
    await Promise.all(redactorEnds);
    if (previousLog) {
      previousLog.end();
      await Promise.race([once(previousLog, "close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  }
  async function start(id) {
    if (disposed) throw new Error("应用正在退出");
    const controller = new AbortController();
    let resolvePageReady;
    const pageReady = new Promise((resolve) => { resolvePageReady = resolve; });
    const currentStartup = { controller, pageReady: resolvePageReady };
    startup = currentStartup;
    const signal = controller.signal;
    try {
    failure = null; workspaceId = id; workspaceScopeKey = toonFactoryWorkspaceScopeKey(id);
    bridgeToken = randomBytes(32).toString("hex"); pageToken = randomBytes(32).toString("hex");
    const verifiedBundle = verifyToonFactoryRuntimeBundle(moduleRoot, { platform, arch }, verifyBundle);
    const entry = path.join(moduleRoot, "server", "jugglework.js");
    await access(entry).catch(() => { throw new Error("漫剧工厂尚未构建，请先运行 pnpm build:toon-factory"); });
    dataDirectory = path.join(app.getPath("userData"), "toonFactoryV2", "workspaces", workspaceScopeKey);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    directoryGrants = await readDirectoryGrants(dataDirectory, platform);
    signal.throwIfAborted();
    broker = createServer((req, res) => { void bridge(req, res); });
    broker.listen(0, "127.0.0.1"); await once(broker, "listening", { signal });
    const bridgeAddress = broker.address();
    if (!bridgeAddress || typeof bridgeAddress === "string") throw new Error("模型桥接监听失败");
    const bundledBun = verifiedBundle.executablePath;
    log = createWriteStream(path.join(dataDirectory, "runtime.log"), { flags: "a", mode: 0o600 });
    await once(log, "open");
    // Do not inherit JuggleWork/provider secrets into the independently running module.
    const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "SystemRoot", "LANG", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    const detached = platform !== "win32";
    child = spawnSidecar(bundledBun, [entry], { cwd: moduleRoot, env: { ...env, NODE_ENV: "production", JUGGLEWORK_MANAGED: "1", TOONFLOW_DATA_DIR: dataDirectory,
      TOONFLOW_BRIDGE_URL: `http://127.0.0.1:${bridgeAddress.port}`, TOONFLOW_BRIDGE_TOKEN: bridgeToken, TOONFLOW_SESSION_TOKEN: pageToken }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached });
    // Keep the referenced child and its pipes attached to Electron's lifecycle; detached only creates a POSIX process group.
    if (detached) detachedSidecars.add(child);
    stdoutRedactor = createSecretRedactor([bridgeToken, pageToken]); stderrRedactor = createSecretRedactor([bridgeToken, pageToken]);
    child.stdout.pipe(stdoutRedactor).pipe(log, { end: false }); child.stderr.pipe(stderrRedactor).pipe(log, { end: false });
    const launched = child;
    child.on("exit", () => { if (child === launched) { ready = false; origin = null; failure = "漫剧工厂后端已退出，可点击重试重新启动"; clipView?.setVisible(false); } });
    child.on("error", () => { if (child === launched) { ready = false; origin = null; failure = "漫剧工厂后端启动失败，可点击重试重新启动"; clipView?.setVisible(false); } });
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("漫剧工厂启动超时，请检查模块日志")), 45_000);
      const onError = (error) => finish(error);
      const onExit = () => finish(new Error("漫剧工厂启动失败，请检查模块日志"));
      const onAbort = () => finish(signal.reason);
      const onData = (chunk) => { output = (output + chunk).slice(-8192); const match = output.match(/TOONFLOW_READY=(\d+)/); if (match) { origin = `http://127.0.0.1:${match[1]}`; finish(); } };
      function finish(error) { clearTimeout(timer); signal.removeEventListener("abort", onAbort); launched.stdout.off("data", onData); launched.off("error", onError); launched.off("exit", onExit); error ? reject(error) : resolve(); }
      signal.addEventListener("abort", onAbort, { once: true });
      launched.stdout.on("data", onData); launched.once("error", onError); launched.once("exit", onExit);
      if (signal.aborted) onAbort();
    });
    const health = await fetchImpl(`${origin}/health`, { headers: { "x-toonflow-session": pageToken }, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!health.ok) throw new Error("漫剧工厂健康检查失败");
    const sessionOrigin = origin;
    const sessionPageToken = pageToken;
    const isolatedSession = session.fromPartition(`persist:jugglework-toonflow-v2-${workspaceScopeKey}`);
    browserSession = isolatedSession;
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    isolatedSession.webRequest.onBeforeSendHeaders({ urls: [`${sessionOrigin}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, "x-toonflow-session": sessionPageToken } });
    });
    view = new WebContentsView({ webPreferences: { session: isolatedSession, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    clipView = new View();
    clipView.setBackgroundColor("#00000000");
    clipView.addChildView(view);
    getWindow().contentView.addChildView(clipView);
    clipView.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url) && new URL(url).origin !== sessionOrigin) void shell.openExternal(url); return { action: "deny" }; });
    view.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== sessionOrigin) event.preventDefault(); });
    view.webContents.on("render-process-gone", () => { failure = "漫剧工厂页面已退出，可点击重试重新启动"; clipView?.setVisible(false); });
    await abortable(view.webContents.loadURL(`${origin}/?desktop=1&jugglework=1`), signal);
    const pageFailed = await waitForPageReady(pageReady, signal, 45_000);
    if (pageFailed) throw new Error("漫剧工厂页面初始化失败，可点击重试重新启动");
    ready = true; layout(requestedBounds);
    if (hidden) scheduleIdleClose();
    return state();
    } finally {
      if (startup === currentStartup) startup = null;
    }
  }
  return {
    state, layout,
    async snapshot() {
      if (!ready || !view || view.webContents.isDestroyed()) throw new Error("漫剧工厂尚未就绪");
      const image = await view.webContents.capturePage();
      if (image.isEmpty()) throw new Error("漫剧工厂画面捕获失败");
      return image.toDataURL();
    },
    projectState() { return enqueue(() => callPage("getProjectState")); },
    enter() {
      return enqueue(async () => {
        if (!ready || !workspaceId) throw new Error("漫剧工厂尚未就绪");
        if (!enteredWorkspaceIds.has(workspaceId)) {
          const state = await callPage("showHome");
          enteredWorkspaceIds.add(workspaceId);
          return state;
        }
        const state = await callPage("getProjectState");
        return state.currentDirectory ? callPage("openProject", [state.currentDirectory]) : callPage("showHome");
      });
    },
    chooseProject() { return enqueue(() => callPage("chooseProject")); },
    openProject(directory) {
      const target = typeof directory === "string" ? directory.trim() : "";
      if (!target || target.length > 4096) return Promise.reject(new Error("漫剧项目目录无效"));
      return enqueue(() => callPage("openProject", [target]));
    },
    authorizeProject(directory) {
      const target = typeof directory === "string" ? directory.trim() : "";
      if (!target || target.length > 4096 || !path.isAbsolute(target)) return Promise.reject(new Error("漫剧项目目录无效"));
      return enqueue(async () => {
        const projectState = await callPage("getProjectState");
        if (!projectState.projects.some(project => project.directory === target)) throw new Error("请从漫剧项目列表中选择需要授权的项目");
        const canonical = await realpath(target).catch(() => { throw new Error("项目文件夹不存在，请确认文件夹未被移动或删除"); });
        if (!(await stat(canonical)).isDirectory()) throw new Error("漫剧项目路径必须是文件夹");
        approvedProjectDirectory = canonical;
        try { return await callPage("chooseProject"); }
        finally { approvedProjectDirectory = null; }
      });
    },
    renameProject(directory, name) {
      const target = typeof directory === "string" ? directory.trim() : "";
      const displayName = typeof name === "string" ? name.trim() : "";
      if (!target || target.length > 4096) return Promise.reject(new Error("漫剧项目目录无效"));
      if (!displayName || displayName.length > 120) return Promise.reject(new Error("漫剧项目名称无效"));
      return enqueue(() => callPage("renameProject", [target, displayName]));
    },
    removeProject(directory) {
      const target = typeof directory === "string" ? directory.trim() : "";
      if (!target || target.length > 4096) return Promise.reject(new Error("漫剧项目目录无效"));
      return enqueue(() => callPage("removeProject", [target]));
    },
    async clearProjectGrants(id) {
      const scopeKey = typeof id === "string" && id.trim() ? toonFactoryWorkspaceScopeKey(id.trim()) : workspaceScopeKey;
      if (!scopeKey) return;
      await rm(path.join(app.getPath("userData"), "toonFactoryV2", "workspaces", scopeKey, directoryGrantsFileName), { force: true });
      if (typeof id === "string" && id.trim()) enteredWorkspaceIds.delete(id.trim());
      else if (workspaceId) enteredWorkspaceIds.delete(workspaceId);
      if (scopeKey === workspaceScopeKey) directoryGrants = new Map();
    },
    async clearAllProjectGrants() {
      const workspacesRoot = path.join(app.getPath("userData"), "toonFactoryV2", "workspaces");
      const entries = await readdir(workspacesRoot, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => rm(path.join(workspacesRoot, entry.name, directoryGrantsFileName), { force: true })));
      directoryGrants = new Map();
      enteredWorkspaceIds.clear();
    },
    async open(id) {
      if (typeof id !== "string" || !id.trim() || id.length > 256) throw new Error("请先选择 JuggleWork 工作区以使用已配置的模型");
      hidden = false;
      cancelIdleClose();
      return enqueue(async () => {
        if (disposed) throw new Error("应用正在退出");
        if (state().running && workspaceId === id) return state();
        await stop();
        try { return await start(id); }
        catch (error) {
          failure = disposed ? null : error instanceof Error ? error.message : "漫剧工厂启动失败";
          await stop();
          throw error;
        }
      });
    },
    hide() {
      hidden = true;
      requestedBounds = null;
      if (clipView && view && !view.webContents.isDestroyed()) clipView.setVisible(false);
      scheduleIdleClose();
    },
    close() {
      hidden = true;
      cancelIdleClose();
      startup?.controller.abort(new Error("漫剧工厂启动已取消"));
      return enqueue(async () => {
        await stop();
        failure = null;
      });
    },
    async restart(id) {
      if (typeof id !== "string" || !id.trim() || id.length > 256) throw new Error("请先选择 JuggleWork 工作区以使用已配置的模型");
      hidden = false;
      cancelIdleClose();
      return enqueue(async () => {
        if (disposed) throw new Error("应用正在退出");
        await stop();
        try { return await start(id); }
        catch (error) {
          failure = disposed ? null : error instanceof Error ? error.message : "漫剧工厂启动失败";
          await stop();
          throw error;
        }
      });
    },
    async dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      hidden = true;
      cancelIdleClose();
      startup?.controller.abort(new Error("应用正在退出"));
      disposePromise = enqueue(() => stop());
      lifecycle = disposePromise.catch(() => {});
      return disposePromise;
    },
  };
}
