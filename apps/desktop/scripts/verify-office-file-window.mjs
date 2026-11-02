import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer as createPortProbe } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import { build } from "esbuild";
import { buildFileWindowPreload } from "./build-file-window-preload.mjs";
import { acceptanceOptions } from "./office-acceptance-options.mjs";

// Standalone acceptance: no application Main, config files, credentials or database.
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = resolve(desktop, "../app");
const requireApp = createRequire(join(appRoot, "package.json"));
const options = acceptanceOptions(process.argv.slice(2));
const root = await mkdtemp(join(tmpdir(), "jugglework-office-file-window-"));
let vite, child, timer, hardTimer;
try {
  const { createServer } = await import(pathToFileURL(requireApp.resolve("vite")).href);
  const { default: react } = await import(pathToFileURL(requireApp.resolve("@vitejs/plugin-react")).href);
  const { default: tailwind } = await import(pathToFileURL(requireApp.resolve("@tailwindcss/vite")).href);
  const port = await new Promise((resolve, reject) => {
    const probe = createPortProbe();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  // Do not load the normal Vite config: it can read release/env fragments.
  vite = await createServer({
    configFile: false, envFile: false, envPrefix: "OFFICE_ACCEPTANCE_PUBLIC_", root: appRoot,
    cacheDir: join(root, "vite-cache"), plugins: [tailwind(), react({ include: /\/src\/.*\.[jt]sx?$/ })],
    resolve: { alias: { "@": join(appRoot, "src") } },
    define: { "import.meta.env.VITE_JUGGLEWORK_APP_VERSION": JSON.stringify("acceptance") },
    server: { host: "127.0.0.1", port, strictPort: true, watch: null },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await build({ entryPoints: [resolve(desktop, "../server/src/office/engine.ts")], outfile: join(root, "engine.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  const preload = await buildFileWindowPreload({ output: join(root, "preload/file-window-preload.cjs") });
  child = spawn(electron, [join(desktop, "scripts/verify-office-file-window-worker.mjs"), root, origin, preload,
    `--format=${options.format}`, ...options.flags], {
    cwd: root, detached: true, stdio: "inherit",
    // Explicit environment: never pass provider keys, runtime ports or real HOME.
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: "en_US.UTF-8", ELECTRON_RUN_AS_NODE: undefined },
  });
  timer = setTimeout(() => {
    child.kill("SIGTERM");
    hardTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000);
  }, 150_000);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  clearTimeout(timer); clearTimeout(hardTimer);
  // Also reap SDK/Chromium descendants if Electron hit its hard exit deadline.
  if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  await vite?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
