// Node launcher. No Electron, login shell, user config or inherited provider env.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptanceEnv, sandboxProfile, redact } from "./production-main-acceptance.mjs";
import { reapProcessGroup } from "./real-engine-acceptance-helpers.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));
export function isolatedEnv(root) {
  const base = acceptanceEnv(root, 0);
  return { ...base, REAL_ENGINE_ACCEPTANCE_ROOT: root,
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: path.join(root, "models.json"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_FFF: "1", BUN_CONFIG_NO_CLEAR_TERMINAL: "1", DO_NOT_TRACK: "1" };
}

export function parseOptions(args) {
  const options = { bun: "/opt/homebrew/bin/bun", dropTerminalEvents: false };
  let bunSeen = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--bun" && !bunSeen) {
      const value = args[++index];
      assert.ok(value && path.isAbsolute(value), "--bun requires an absolute executable path");
      options.bun = value; bunSeen = true;
    } else if (args[index] === "--drop-terminal-events" && !options.dropTerminalEvents) options.dropTerminalEvents = true;
    else throw Error("Usage: node real-engine-acceptance.mjs [--bun /absolute/path] [--drop-terminal-events]");
  }
  return options;
}

export function sidecarTarget(platform, arch) {
  assert.equal(platform, "darwin", "Requires sandbox-exec; no unsandboxed fallback");
  const target = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" }[arch];
  assert.ok(target, `Unsupported Darwin architecture: ${arch}`);
  return { binary: `opencode-${target}`, manifest: `versions-${target}.json` };
}

export async function childRun(executable, args, root, env, timeout) {
  const child = spawn(executable, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", timedOut = false, residualGroup = false, groupError;
  const kill = () => { if (child.pid) return reapProcessGroup(child.pid); return false; };
  const interrupt = () => {
    timedOut = true;
    console.error("FORCED CLEANUP timeout/interruption (FAIL)");
    try { kill(); } catch (error) { groupError = error; }
  };
  const timer = setTimeout(interrupt, timeout);
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  // Redact complete output, including split records. Bound log memory.
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-48000); });
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      // Inspect on exit, not close: surviving descendants may hold stdout open.
      child.once("exit", () => {
        try {
          residualGroup = kill();
          console.info(residualGroup ? "FORCED CLEANUP residual process group after child exit (FAIL)" : "CLEANUP child exit: no residual process group");
        } catch (error) { groupError = error; }
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    console.info(redact(output));
    assert.equal(timedOut, false, "acceptance deadline exceeded");
    if (groupError) throw groupError;
    assert.equal(residualGroup, false, "child exit left residual process group; forced cleanup is not a pass");
    assert.equal(result.code, 0, `child failed (${result.signal ?? result.code})`);
    return output;
  } finally {
    clearTimeout(timer); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (kill()) throw Error("FORCED CLEANUP finalizer found residual process group (FAIL)");
  }
}

export async function prepareRealEngine(root, bunPath = "/opt/homebrew/bin/bun") {
  const target = sidecarTarget(process.platform, process.arch);
  const sidecar = await realpath(path.join(desktop, "resources/sidecars", target.binary));
  const manifest = JSON.parse(await readFile(path.join(desktop, "resources/sidecars", target.manifest), "utf8")).opencode;
  assert.equal(createHash("sha256").update(await readFile(sidecar)).digest("hex"), manifest.sha256, "bundled sidecar hash mismatch");
  // Resolve a fixed installed executable, never PATH, a shell, or a user config.
  assert.ok(path.isAbsolute(bunPath), "--bun requires an absolute executable path");
  const bun = await realpath(bunPath);
  await access("/usr/bin/sandbox-exec");
    for (const dir of ["home", "appData", "config", "data", "cache", "state", "tmp", "workspace", "opencode", "empty-ca"])
      await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, "empty-ca.pem"), "");
    await writeFile(path.join(root, "denied-read"), "synthetic-canary");
    await writeFile(path.join(root, ".env"), "REAL_ENGINE_DOTENV_CANARY=must-not-load\n");
    await writeFile(path.join(root, "models.json"), "{}");
    const bunConfig = path.join(root, "bunfig.toml");
    await writeFile(bunConfig, "# Acceptance owns all Bun configuration; no user hooks.\n");
    const env = { ...isolatedEnv(root), REAL_ENGINE_BIN: sidecar, REAL_ENGINE_EXPECTED_VERSION: manifest.version };
    const profile = sandboxProfile(root, await realpath(homedir()));
    // Both parent and exec descendant must prove native network/file confinement
    // before any engine is launched. No request can reach an external peer.
    const probe = `const a=require('node:assert/strict'),f=require('node:fs'),n=require('node:net');
      const root=process.env.REAL_ENGINE_ACCEPTANCE_ROOT;
      a.throws(()=>f.readFileSync(root+'/denied-read'),e=>['EPERM','EACCES'].includes(e.code));
      a.throws(()=>f.readFileSync(root+'/.env'),e=>['EPERM','EACCES'].includes(e.code));
      a.throws(()=>f.writeFileSync(root+'/denied-write','x'),e=>['EPERM','EACCES'].includes(e.code));
      const s=n.connect(443,'203.0.113.1');s.on('connect',()=>{throw Error('external egress allowed')});
      s.on('error',e=>{a.ok(['EPERM','EACCES'].includes(e.code),e.code);console.log('PASS OS loopback-only/file sandbox')});
      setTimeout(()=>{throw Error('probe timeout')},4000).unref();`;
    const descendant = `const c=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(probe)}],{env:process.env,cwd:process.cwd(),encoding:'utf8',timeout:6000});require('node:assert/strict').equal(c.status,0,c.stderr);console.log('PASS exec descendant sandbox');`;
    await childRun("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", probe + descendant], root, env, 10000);
    const bunArgs = ["--no-env-file", `--config=${bunConfig}`, "--no-install"];
    const bunVersion = (await childRun("/usr/bin/sandbox-exec", ["-p", profile, bun, ...bunArgs, "--eval", "console.log(Bun.version)"], root, env, 10000)).trim();
    assert.match(bunVersion, /^1\.\d+\.\d+(?:[-+][\w.-]+)?$/, "Supported Bun: 1.x >= 1.2.0");
    assert.ok(Number(bunVersion.split(".")[1]) >= 2, "Supported Bun: 1.x >= 1.2.0");
    console.info(`BUN ${bunVersion} executable=${bun}; explicit disposable bunfig, dotenv disabled`);
    return { env, profile, bun, bunArgs, version: manifest.version };
}

export async function runAcceptance({ bun: bunPath = "/opt/homebrew/bin/bun", dropTerminalEvents = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "juggle-real-engine-")));
  try {
    const { env, profile, bun, bunArgs, version } = await prepareRealEngine(root, bunPath);
    console.info(`SCOPE real bundled OpenCode ${version} + source embedded Server API; synthetic provider; no UI`);
    if (dropTerminalEvents) console.info("NEGATIVE CONTROL: filtering terminal events only in worker SSE consumer; this command MUST exit nonzero");
    const output = await childRun("/usr/bin/sandbox-exec", ["-p", profile, bun, ...bunArgs, fileURLToPath(new URL("./real-engine-acceptance-worker.ts", import.meta.url)), ...(dropTerminalEvents ? ["--drop-terminal-events"] : [])], root, env, 110000);
    assert.equal(dropTerminalEvents, false, "NEGATIVE CONTROL unexpectedly passed");
    assert.match(output, /PASS real-engine acceptance complete/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    console.info("CLEANUP temporary HOME/configs/DBs/cwd removed (process-group results reported above)");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runAcceptance(parseOptions(process.argv.slice(2))); }
  catch (error) { console.error(redact(error.stack ?? error)); process.exitCode = 1; }
}
