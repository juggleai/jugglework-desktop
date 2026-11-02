// Run with Node, never with the user's normal Electron main/userData.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRealEngine, childRun } from "./real-engine-acceptance.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const repo = path.resolve(desktop, "../..");
const mode = process.argv[2] ?? "--full-app";
const realEngine = mode === "--real-engine";
const negative = realEngine && process.argv[3] === "--drop-terminal-events";
if (!["--full-app", "--real-engine", "--legacy-smoke", "--regression", "--server-regression"].includes(mode) || process.argv.length > (negative ? 4 : 3)) {
  throw new Error("Usage: node session-real-server-acceptance.mjs [--full-app|--real-engine [--drop-terminal-events]|--legacy-smoke|--regression|--server-regression]");
}
const root = await realpath(await mkdtemp(path.join(tmpdir(), "juggle-real-server-")));
for (const name of ["home", "config", "data", "cache", "tmp", "workspace"]) await mkdir(path.join(root, name));
await writeFile(path.join(root, "bunfig.toml"), "# Disposable acceptance configuration\n");
const bunFlags = ["--no-env-file", `--config=${path.join(root, "bunfig.toml")}`, "--no-install"];
// Deliberate allowlist, not a copy of process.env. No login shell, env file,
// inherited provider credentials, real HOME, existing userData or existing DB.
const env = {
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
  TMPDIR: path.join(root, "tmp"), JUGGLEWORK_RUNTIME_DB: path.join(root, "runtime.sqlite"),
  JUGGLEWORK_SESSION_ACCEPTANCE_ROOT: root,
};
let executable = path.join(desktop, "node_modules/.bin/electron");
let args = [fileURLToPath(new URL(mode === "--legacy-smoke" ? "./session-workbench-smoke.mjs" : "./session-real-server-electron.mjs", import.meta.url))];
if (mode === "--regression") {
  executable = "bun";
  args = [...bunFlags, "--conditions=development", "test", "--isolate", ...[
    "apps/app/tests/file-window-session-stop-root.test.tsx", "apps/app/tests/session-draft-sender.test.tsx",
    "apps/app/tests/file-window-conversation-client.test.ts", "apps/app/tests/file-window-conversation.test.tsx",
    "apps/app/tests/file-window-client.test.ts", "apps/app/tests/file-window-options.test.ts",
    "apps/app/tests/session-agent-selection-integration.test.ts", "apps/app/tests/task-submission-startup.test.ts",
    "apps/desktop/scripts/session-workbench-smoke-fixture.test.mjs",
  ].map(p => path.join(repo, p))];
} else if (mode === "--server-regression") {
  executable = "bun";
  // Existing harnesses own per-test configPath/DB paths. Their fallback HOME
  // is still disposable; don't force unrelated cases into one shared DB.
  delete env.JUGGLEWORK_RUNTIME_DB;
  args = [...bunFlags, "test", "--isolate", ...[
    "apps/server/src/session-mutation.e2e.test.ts", "apps/server/src/session-read-model.e2e.test.ts",
    "apps/server/src/opencode-admission.test.ts", "apps/server/src/remote-session-event-bridge.e2e.test.ts",
  ].map(p => path.join(repo, p))];
}
console.info(`ACCEPTANCE MODE ${mode}`);
if (realEngine) {
  try {
    const prepared = await prepareRealEngine(root);
    const require = createRequire(import.meta.url);
    const electronPackage = path.dirname(require.resolve("electron/package.json"));
    const relative = (await readFile(path.join(electronPackage, "path.txt"), "utf8")).trim();
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw Error("Invalid installed Electron path");
    executable = await realpath(path.join(electronPackage, "dist", relative));
    const profilePath = path.join(root, "engine.sb");
    await writeFile(profilePath, prepared.profile);
    Object.assign(env, prepared.env, { JUGGLEWORK_SESSION_ACCEPTANCE_ROOT: root,
      JUGGLEWORK_RUNTIME_DB: path.join(root, "runtime.sqlite"), SESSION_REAL_ENGINE: "1",
      SESSION_ENGINE_BUN: prepared.bun, SESSION_ENGINE_PROFILE: profilePath,
      SESSION_DROP_TERMINAL_EVENTS: negative ? "1" : "0" });
    console.info(`SCOPE full App dual renderer + source Server + managed OpenCode ${prepared.version}; synthetic bootstrap/Den/provider; NOT production main`);
    if (negative) console.info("NEGATIVE CONTROL: only observer terminal events dropped; HTTP/journal remain real; must fail SSE evidence");
    await childRun(executable, args, root, env, 240000);
    if (negative) throw Error("NEGATIVE CONTROL unexpectedly passed");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); console.info(`ACCEPTANCE CLEANUP removed ${root}`); }
} else {
const child = spawn(executable, args, { cwd: root, env, stdio: "inherit", detached: true });
let forced = false;
const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
const deadline = setTimeout(() => { forced = true; console.error("ACCEPTANCE parent timeout (240s)"); killGroup(); }, 240000);
const interrupt = () => { forced = true; killGroup(); };
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
try {
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  process.exitCode = forced ? 1 : code ?? 1;
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  clearTimeout(deadline); killGroup();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
  console.info(`ACCEPTANCE CLEANUP: process group reaped; removed ${root}`);
}
}
