// Startup smoke only: real production main, not a packaged-build acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const repo = path.resolve(desktop, "../..");
export const nativePaths = ["home", "appData", "userData", "sessionData", "downloads", "desktop", "documents", "logs", "crashDumps"];

/** Only synthetic values enter the child; never inherit shell/CA/provider state. */
export function acceptanceEnv(root, port) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8",
    HOME: path.join(root, "home"), CFFIXED_USER_HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"), APPDATA: path.join(root, "appData"), LOCALAPPDATA: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    // Chromium GetTempDir on macOS uses this ahead of NSTemporaryDirectory, not TMPDIR.
    MAC_CHROMIUM_TMPDIR: path.join(root, "tmp"),
    JUGGLEWORK_PRODUCTION_ACCEPTANCE_ROOT: root,
    JUGGLEWORK_ELECTRON_USERDATA: path.join(root, "userData"),
    JUGGLEWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1", JUGGLEWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1",
    JUGGLEWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY: "1", JUGGLEWORK_DEV_MODE: "0",
    JUGGLEWORK_ELECTRON_REMOTE_DEBUG_PORT: String(port),
    JUGGLEWORK_SERVER_CONFIG: path.join(root, "config/server.json"),
    JUGGLEWORK_DESKTOP_BOOTSTRAP_PATH: path.join(root, "config/desktop-bootstrap.json"),
    JUGGLEWORK_BOOTSTRAP_BUNDLE_DIR: path.join(root, "bundle"),
    JUGGLEWORK_ENV_STORE: path.join(root, "config/env.json"),
    JUGGLEWORK_RUNTIME_DB: path.join(root, "data/runtime.sqlite"),
    JUGGLEWORK_DATA_DIR: path.join(root, "data"),
    OPENCODE_DB: path.join(root, "data/opencode.sqlite"), OPENCODE_TEST_HOME: path.join(root, "home"),
    OPENCODE_CONFIG: path.join(root, "opencode/opencode.json"), OPENCODE_CONFIG_DIR: path.join(root, "opencode"),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    // Presence prevents runtime.resolveSystemCaEnv from consulting the OS trust store.
    NODE_EXTRA_CA_CERTS: path.join(root, "empty-ca.pem"), SSL_CERT_FILE: path.join(root, "empty-ca.pem"),
    SSL_CERT_DIR: path.join(root, "empty-ca"),
  };
}

/** Seatbelt restrictions survive exec, including native helpers and engine children. */
export function ancestorPaths(target) {
  const result = [];
  for (let current = path.dirname(target); ; current = path.dirname(current)) {
    result.push(current);
    if (current === path.dirname(current)) return result;
  }
}

export function sandboxProfile(root, realHome, repository = repo) {
  const q = JSON.stringify;
  // NSBundle / FILE_EXE canonicalization walks ancestors before reading the bundle.
  // Exact directory metadata only: no directory enumeration or user file contents.
  const metadataAncestors = ancestorPaths(repository).map(dir => `(require-not (literal ${q(dir)}))`).join(" ");
  const privateFiles = `(require-all (subpath ${q(path.dirname(realHome))}) (require-not (subpath ${q(repository)})) (require-not (subpath ${q(root)})))`;
  return `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(deny network-bind)
(allow network-bind (local ip "localhost:*"))
; Path-filtered UNIX sockets, following /usr/share/sandbox/com.apple.smbd.sb WSP rules.
; Trailing slash excludes sibling roots with a matching textual prefix.
(allow network-bind (prefix ${q(root + "/")}))
(allow network-outbound (prefix ${q(root + "/")}))
(deny file-write* (require-all (require-not (subpath ${q(root)})) (require-not (literal "/dev/null"))))
(deny file-read-data ${privateFiles})
(deny file-read-metadata (require-all ${privateFiles} ${metadataAncestors}))
(deny file-read* (regex #"(^|/)\\.env($|[./])") (regex #"(^|/)Keychains(/|$)"))
(deny process-exec (literal "/usr/bin/security") (literal "/usr/bin/codesign"))
(deny file-read* (literal ${q(path.join(root, "denied-read"))}))
(deny file-write* (literal ${q(path.join(root, "denied-write"))}))`;
}

/** Redact credentials before any child output reaches the transcript. */
export function redact(value) {
  return String(value)
    .replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, "$1 <redacted>")
    .replace(/(["']?[\w-]*(?:token|password|secret|authorization|api[_-]?key)[\w-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,}\n]+)/gi, "$1<redacted>")
    .replace(/\b[a-f0-9]{32,}\b/gi, "<redacted-id>")
    .replace(/((?:https?|wss?):\/\/)[^\s/@]+:[^\s/@]+@/g, "$1<redacted>@")
    .replace(/((?:https?|wss?):\/\/[^\s?#"']+)\?[^\s"']*/g, "$1?<redacted>");
}

/** A zero native exit code does not erase application or subprocess failures. */
export function assertStartupOutput(output) {
  assert.doesNotMatch(output, /(?:^|\n)(?:FAIL |RENDERER ERROR )|\[quit\] (?:cleanup timed out|one or more cleanup tasks failed)|sandbox initialization failed|Failed to initialize sandbox|Failed to (?:create socket directory|bind\(\))|Unable to find helper app|:FATAL:/,
    "Application/native subprocess/cleanup errors cannot pass startup smoke");
  assert.match(output, /PASS normal app.quit cleanup/);
  assert.match(output, /PASS production-main acceptance complete/);
}

export async function seed(root, port) {
  const env = acceptanceEnv(root, port);
  for (const dir of [...nativePaths, "config", "data", "cache", "state", "tmp", "bundle", "opencode", "empty-ca"])
    await mkdir(path.join(root, dir), { recursive: true });
  const json = async (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await json(env.JUGGLEWORK_SERVER_CONFIG, { workspaces: [], authorizedRoots: [] });
  // Empty account state, no handoff/brand/provider; local unreachable deployment prevents cloud discovery.
  await json(env.JUGGLEWORK_DESKTOP_BOOTSTRAP_PATH, { baseUrl: "http://127.0.0.1:1", requireSignin: true, handoff: null });
  await json(env.JUGGLEWORK_ENV_STORE, { schemaVersion: 1, variables: [] });
  await json(env.OPENCODE_CONFIG, {});
  await json(path.join(root, "userData/jugglework-workspaces.json"), { selectedId: "", activeId: null, watchedId: null, workspaces: [] });
  await json(path.join(root, "userData/jugglework-server-tokens.json"), { version: 1, workspaces: {} });
  await writeFile(path.join(root, "empty-ca.pem"), "");
  await writeFile(path.join(root, "denied-read"), "synthetic-filesystem-canary");
  await writeFile(path.join(root, ".env"), "synthetic-env-canary");
  await writeFile(path.join(root, "fixture.csv"), "name,value\nstartup-smoke,1\n");
  // DB paths deliberately do not exist: production owns schema creation.
  return env;
}

function runChild(executable, args, { root, env, timeout = 150_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false;
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const interrupt = () => { timedOut = true; kill(); };
    const timer = setTimeout(interrupt, timeout);
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    // Buffer across chunks: a split credential must never escape line redaction.
    const pending = { stdout: "", stderr: "" };
    for (const name of ["stdout", "stderr"]) child[name].on("data", (chunk) => {
      pending[name] += chunk.toString();
      let end;
      while ((end = pending[name].indexOf("\n")) >= 0) {
        const line = redact(pending[name].slice(0, end)); pending[name] = pending[name].slice(end + 1);
        output = (output + line + "\n").slice(-24000);
        console.info(line);
      }
      // Discard an overlong unterminated record rather than expose a partial secret.
      if (pending[name].length > 64000) pending[name] = "<overlong record omitted>";
    });
    child.once("error", (error) => {
      clearTimeout(timer); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
      for (const text of Object.values(pending)) if (text) { const line = redact(text); output += line; console.info(line); }
      let residualGroup = false;
      try { process.kill(-child.pid, 0); residualGroup = true; } catch {}
      kill(); // Reap descendants, but never mistake forced cleanup for normal quit.
      resolve({ code, signal, timedOut, output, residualGroup });
    });
  });
}

const probe = `
const assert = require('node:assert/strict');
const fs = require('node:fs'); const net = require('node:net');
const {spawnSync} = require('node:child_process');
const root = process.env.JUGGLEWORK_PRODUCTION_ACCEPTANCE_ROOT;
assert.throws(()=>fs.readFileSync(root+'/denied-read'), e=>['EPERM','EACCES'].includes(e.code));
assert.throws(()=>fs.readFileSync(root+'/.env'), e=>['EPERM','EACCES'].includes(e.code));
assert.throws(()=>fs.writeFileSync(root+'/denied-write',''), e=>['EPERM','EACCES'].includes(e.code));
fs.writeFileSync(root+'/allowed-write','synthetic'); fs.unlinkSync(root+'/allowed-write');
const unixPath=root+(process.argv.includes('--descendant')?'/uc':'/up');
const unix=net.createServer(s=>s.end());
unix.listen(unixPath,()=>{
 const client=net.connect(unixPath); client.on('error',e=>{throw e;});
 client.on('connect',()=>client.end()); client.on('close',()=>unix.close(()=>console.log('PASS fixture-root UNIX socket bind/connect')));
});
const outside=net.connect(root+'-x');
outside.on('connect',()=>{throw Error('UNIX socket escaped fixture root');});
outside.on('error',e=>{assert.ok(['EPERM','EACCES'].includes(e.code),e.code);console.log('PASS sibling UNIX socket denied');});
if (!process.argv.includes('--descendant')) {
 const child=spawnSync(process.execPath,['-e',${JSON.stringify("PLACEHOLDER")},'--','--descendant'],{env:process.env,cwd:root,encoding:'utf8',timeout:8000});
 assert.equal(child.status,0,child.stderr);
}
const server=net.createServer(s=>s.end());
server.listen(0,'127.0.0.1',()=>{
 const local=net.connect(server.address().port,'127.0.0.1');
 local.on('connect',()=>local.end()); local.on('close',()=>server.close());
});
const socket=net.connect(443,'203.0.113.1');
socket.once('connect',()=>{throw Error('OS sandbox allowed non-loopback');});
socket.once('error',e=>{assert.ok(['EPERM','EACCES'].includes(e.code),e.code);console.log('PASS inherited OS sandbox: loopback only, file denials');});
setTimeout(()=>{throw Error('sandbox probe timeout');},5000).unref();
`;

export async function runAcceptance({ preJsProbe = false } = {}) {
  assert.equal(process.platform, "darwin", "Requires macOS sandbox-exec; no unsandboxed fallback");
  await access("/usr/bin/sandbox-exec");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "juggle-production-main-")));
  let outsideSocket;
  try {
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const env = await seed(root, port);
    const require = createRequire(import.meta.url);
    // Loading electron/index.js can run its downloader and honors inherited overrides.
    const electronPackage = path.dirname(require.resolve("electron/package.json"));
    const relativeExecutable = (await readFile(path.join(electronPackage, "path.txt"), "utf8")).trim();
    assert.ok(relativeExecutable && !path.isAbsolute(relativeExecutable) && !relativeExecutable.split(path.sep).includes(".."));
    const electron = await realpath(path.join(electronPackage, "dist", relativeExecutable));
    const contents = path.resolve(path.dirname(electron), "..");
    const artifacts = [electron, path.join(contents, "Info.plist"),
      path.join(contents, "Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"),
      path.join(contents, "Frameworks/Electron Helper.app/Contents/Info.plist")];
    const profile = sandboxProfile(root, await realpath(homedir()));
    const descendantProbe = probe.replace(/if \(!process.argv.includes\('--descendant'\)\) \{[\s\S]*?\n\}/, "");
    const artifactProbe = `for(const dir of ${JSON.stringify(ancestorPaths(electron))}) { assert.ok(fs.statSync(dir).isDirectory()); } for(const file of ${JSON.stringify(artifacts)}) { assert.ok(fs.statSync(file).isFile()); const fd=fs.openSync(file,'r'); fs.closeSync(fd); } console.log('PASS installed Electron/helper artifacts + exact ancestor metadata readable inside OS sandbox');`;
    // A real synthetic sibling endpoint distinguishes policy denial from ENOENT.
    // Only the unsandboxed launcher owns it; children must never connect to it.
    outsideSocket = net.createServer(socket => { socket.destroy(); });
    await new Promise((resolve, reject) => { outsideSocket.once("error", reject); outsideSocket.listen(root + "-x", resolve); });
    const checked = await runChild("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", probe.replace(JSON.stringify("PLACEHOLDER"), JSON.stringify(descendantProbe)) + artifactProbe], { root, env, timeout: 12_000 });
    await new Promise(resolve => outsideSocket.close(resolve));
    assert.equal(checked.code, 0, "OS sandbox preflight failed; production main was NOT launched");
    assert.equal(checked.timedOut, false);
    if (preJsProbe) {
      const entry = path.join(root, "pre-js-probe.mjs");
      await writeFile(entry, `import {createRequire} from 'node:module'; const {app}=createRequire(import.meta.url)('electron'); app.commandLine.appendSwitch('use-mock-keychain'); console.log('PASS Electron pre-JS boundary reached JavaScript'); app.quit();`);
      const result = await runChild("/usr/bin/sandbox-exec", ["-p", profile, electron, entry], { root, env, timeout: 15000 });
      assert.equal(result.code, 0, "Minimal sandboxed Electron probe failed");
      assert.match(result.output, /PASS Electron pre-JS boundary reached JavaScript/);
      console.info("SCOPE pre-JS boundary probe only; native subprocess errors above remain failures for startup acceptance");
      return;
    }
    // No build or alternate loader. Missing artifacts must remain explicit failures.
    for (const artifact of ["electron/main.mjs", "electron/preload.mjs", "dist/preload/file-window-preload.cjs", "server/dist/embedded.js"])
      await access(path.join(desktop, artifact)).catch(() => { throw Error(`Missing artifact: ${artifact}; production main NOT launched`); });
    console.info("SCOPE startup smoke; source index.html via isolated Vite; existing staged server + file preload; unpackaged Electron; no complete-build claim");
    const result = await runChild("/usr/bin/sandbox-exec", ["-p", profile, electron, fileURLToPath(new URL("./production-main-acceptance-electron.mjs", import.meta.url))], { root, env });
    assert.equal(result.timedOut, false, "Production main acceptance exceeded 150s; process group killed");
    if (!result.output.includes("STAGE isolated Electron worker JavaScript entered"))
      console.error("DIAGNOSTIC Electron failed before harness JavaScript; production main/IPC/windows NOT exercised. No unsandboxed fallback.");
    assert.equal(result.code, 0, `Production main failed (signal ${result.signal ?? "none"}); see redacted diagnostics above`);
    assert.equal(result.residualGroup, false, "Electron quit left descendants; parent forcibly reaped them, NOT graceful cleanup");
    assertStartupOutput(result.output);
  } finally {
    if (outsideSocket?.listening) await new Promise(resolve => outsideSocket.close(resolve));
    await rm(root + "-x", { force: true });
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    console.info("CLEANUP disposable profile, fixtures, DBs, caches and logs removed; child process group reaped");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--pre-js-probe"), "Usage: node production-main-acceptance.mjs [--pre-js-probe]"); await runAcceptance({ preJsProbe: process.argv[2] === "--pre-js-probe" }); }
  catch (error) { console.error(redact(error.stack ?? error)); process.exitCode = 1; }
}
