import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { nativePaths, redact } from "./production-main-acceptance.mjs";

// Do not eagerly resolve Electron.safeStorage before use-mock-keychain is installed.
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const root = process.env.JUGGLEWORK_PRODUCTION_ACCEPTANCE_ROOT;
assert.ok(root && root === process.cwd() && os.homedir() === path.join(root, "home"), "Use isolated sandbox launcher");
assert.equal(process.env.JUGGLEWORK_DEV_MODE, "0");
for (const name of nativePaths) app.setPath(name, path.join(root, name));
app.setAppLogsPath(path.join(root, "logs"));
for (const name of nativePaths) assert.equal(app.getPath(name), path.join(root, name));
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", process.env.JUGGLEWORK_ELECTRON_REMOTE_DEBUG_PORT);
console.info("STAGE isolated Electron worker JavaScript entered");

let stage = "isolation", vite, failed = false, quitting = false, mainImported = false, quitEvents = 0;
const loginCalls = [], errors = [], checks = [], observed = [];
const pass = (label) => { checks.push(label); console.info(`PASS ${label}`); };
const mark = (label) => { stage = label; console.info(`STAGE ${label}`); };
// The only mocked OS boundary. No runtime, BrowserWindow, preload, IPC or fetch replacement.
app.setLoginItemSettings = (options) => { loginCalls.push({ openAtLogin: options.openAtLogin, openAsHidden: options.openAsHidden, args: options.args }); };
const evaluate = (window, expression) => window.webContents.executeJavaScript(expression, true);
async function wait(label, predicate, timeout = 25000) {
  mark(label); const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (failed) throw Error("Application error already recorded");
    if (await predicate()) return;
    await delay(100);
  }
  throw Error(`Timed out: ${label}`);
}
async function quit() {
  if (quitting) return; quitting = true;
  await vite?.close().catch(error => { failed = true; console.error(redact(error.stack)); });
  app.quit(); // Production before-quit owns service/window cleanup, including on failure.
}
function failure(error) {
  failed = true; process.exitCode = 1;
  console.error(`FAIL ${stage}: ${redact(error?.stack ?? error)}`);
  void quit();
}
process.on("uncaughtException", failure);
process.on("unhandledRejection", failure);
app.on("browser-window-created", (_event, window) => {
  observed.push(window);
  window.webContents.on("preload-error", (_event, _file, error) => failure(error));
  window.webContents.on("render-process-gone", (_event, details) => failure(Error(`Renderer gone: ${details.reason}`)));
  window.webContents.on("console-message", (_event, ...args) => {
    const detail = typeof args[0] === "object" ? args[0] : { level: args[0], message: args[1] };
    if (detail.level === "error" || detail.level === 3) {
      errors.push(redact(detail.message)); console.error(`RENDERER ERROR ${redact(detail.message)}`);
    }
  });
  window.webContents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) failure(Error(`Main frame load failed: ${code} ${description}`));
  });
});
app.on("before-quit", () => { quitEvents++; });
app.on("will-quit", () => {
  if (errors.length) failed = true;
  if (!quitting) { failed = true; console.error("FAIL unexpected app quit"); }
  if (mainImported && quitEvents < 2) { failed = true; console.error("FAIL production before-quit cleanup did not re-enter app.quit"); }
  if (existsSync(path.join(root, "userData/jugglework-ui-control.json"))) { failed = true; console.error("FAIL UI-control discovery survived production quit"); }
  if (!failed) { pass("normal app.quit cleanup"); pass("production-main acceptance complete"); }
  console.info(JSON.stringify({ scope: "startup-smoke", mainImported, checks, loginCalls, errors, productionWindows: observed.length, quitEvents }));
  process.exitCode = failed ? 1 : 0;
});
setTimeout(() => failure(Error("worker deadline (130s)")), 130000).unref();

try {
  const desktop = fileURLToPath(new URL("../", import.meta.url));
  const appRoot = path.resolve(desktop, "../app");
  const appRequire = createRequire(path.join(appRoot, "package.json"));
  const { createServer } = await import(appRequire.resolve("vite"));
  const { default: react } = await import(appRequire.resolve("@vitejs/plugin-react"));
  const { default: tailwindcss } = await import(appRequire.resolve("@tailwindcss/vite"));
  mark("ordinary source index.html with isolated Vite");
  vite = await createServer({ root: appRoot, configFile: false, envFile: false, envPrefix: "JUGGLEWORK_PRODUCTION_ACCEPTANCE_PUBLIC_",
    cacheDir: path.join(root, "vite-cache"), resolve: { alias: { "@": path.join(appRoot, "src") } },
    plugins: [tailwindcss(), react()], server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(appRoot, "../..")] } },
  });
  assert.equal(vite.config.configFile, undefined);
  assert.deepEqual(Object.keys(vite.config.env).filter(key => key.startsWith("VITE_")), []);
  await vite.listen();
  process.env.JUGGLEWORK_ELECTRON_START_URL = `http://127.0.0.1:${vite.httpServer.address().port}/index.html`;
  mark("await import production electron/main.mjs");
  await import("../electron/main.mjs");
  mainImported = true;
  console.info("OBSERVED actual production main module evaluated");
  assert.equal(failed, false, "Production main quit or reported an error during module evaluation");
  pass("actual production main module evaluated");
  await app.whenReady();
  let main;
  await wait("production main window + actual preload", async () => {
    main = BrowserWindow.getAllWindows().find(window => window.webContents.getLastWebPreferences().preload === path.join(desktop, "electron/preload.mjs"));
    return main && !main.webContents.isLoading() && await evaluate(main, "typeof window.__JUGGLEWORK_ELECTRON__?.invokeDesktop === 'function'");
  }, 45000);
  pass("production-created BrowserWindow and real preload bridge");
  const invoke = (command) => evaluate(main, `window.__JUGGLEWORK_ELECTRON__.invokeDesktop(${JSON.stringify(command)})`);
  const build = await invoke("appBuildInfo"); assert.equal(build.juggleworkDevMode, false);
  const workspaces = await invoke("workspaceBootstrap"); assert.deepEqual(workspaces.workspaces, []);
  const bootstrap = await invoke("runtimeBootstrap");
  assert.equal(bootstrap.ok, true); assert.equal(bootstrap.skipped, true); assert.equal(bootstrap.reason, "no-local-workspace");
  // Never print bootstrap, serverInfo, page storage, account state or credentials.
  pass("real IPC appBuildInfo / workspaceBootstrap / runtimeBootstrap: no-local-workspace");
  await wait("ordinary renderer anonymous signin surface", async () => {
    const state = await evaluate(main, `({hash:location.hash, populated:document.getElementById('root')?.childElementCount > 0})`);
    return state.populated && state.hash.includes("signin");
  }, 45000);
  pass("ordinary index anonymous signin route, no workspace/account fixture");
  assert.ok(loginCalls.length > 0, "launch-at-login boundary observed");
  assert.ok(loginCalls.every(call => call.openAtLogin === false));
  pass("launch-at-login recorded without changing OS login items");

  mark("system open-file temporary CSV, no chat session");
  // Exercise the registered production OS event, not a synthetic runtime or direct private handler.
  app.emit("open-file", { preventDefault() {} }, path.join(root, "fixture.csv"));
  let file;
  await wait("production file window", async () => {
    file = BrowserWindow.getAllWindows().find(window => window !== main && window.webContents.getLastWebPreferences().preload === path.join(desktop, "dist/preload/file-window-preload.cjs"));
    return file && !file.webContents.isLoading() && await evaluate(file, "typeof window.__JUGGLEWORK_ELECTRON__?.fileWindow?.state === 'function'");
  }, 30000);
  const state = await evaluate(file, "window.__JUGGLEWORK_ELECTRON__.fileWindow.state()");
  assert.equal(state.local, true); assert.equal(state.conversation ?? null, null);
  await wait("temporary CSV tab registered", async () => (await evaluate(file, "window.__JUGGLEWORK_ELECTRON__.fileWindow.state()")).tabs?.some(tab => tab.name === "fixture.csv"));
  assert.equal(file.webContents.session.isPersistent(), false);
  assert.notEqual(file.webContents.session, main.webContents.session);
  pass("production no-chat temporary CSV open + actual restricted file preload/state IPC");
  await evaluate(file, "window.__JUGGLEWORK_ELECTRON__.fileWindow.action('close')");
  file.close(); await wait("production file close", () => file.isDestroyed());
  assert.equal(await readFile(path.join(root, "fixture.csv"), "utf8"), "name,value\nstartup-smoke,1\n");
  pass("real file-window action(close), native close, fixture unchanged");
  assert.deepEqual(errors, [], "Renderer errors are acceptance failures");
  await quit();
} catch (error) { failure(error); }
