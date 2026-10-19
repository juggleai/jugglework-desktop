import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import electron from "electron";

const root = await mkdtemp(join(tmpdir(), "jugglework-selection-page-"));
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const child = spawn(electron, [join(desktop, "scripts/verify-office-selection-worker.mjs"), root, ...process.argv.slice(2)], {
    cwd: desktop, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
  clearTimeout(timer); process.exitCode = Number(code);
} finally { await rm(root, { recursive: true, force: true }); }
