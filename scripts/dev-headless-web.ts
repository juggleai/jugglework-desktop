import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDirectServerHeadlessLaunch } from "./direct-server-headless.js";

const cwd = process.cwd();
const tmpDir = path.join(cwd, "tmp");

const ensureTmp = async () => {
  await mkdir(tmpDir, { recursive: true });
};

const isPortFree = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });

const getFreePort = (host: string) =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve free port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

const resolvePort = async (value: string | undefined, host: string) => {
  if (value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      const free = await isPortFree(parsed, host);
      if (free) return parsed;
    }
  }
  return await getFreePort(host);
};

const logLine = (message: string) => {
  process.stdout.write(`${message}\n`);
};

const readBool = (value: string | undefined) => {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const silent = process.argv.includes("--silent");

const autoBuildEnabled =
  process.env.JUGGLEWORK_DEV_HEADLESS_WEB_AUTOBUILD == null
    ? true
    : readBool(process.env.JUGGLEWORK_DEV_HEADLESS_WEB_AUTOBUILD);

const runCommand = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: silent ? "ignore" : "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });

const spawnLogged = (
  command: string,
  args: string[],
  logPath: string,
  env: NodeJS.ProcessEnv,
) => {
  const logFd = openSync(logPath, "w");
  return spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", logFd, logFd],
  });
};

let stopping = false;
const shutdown = (
  label: string,
  code: number | null,
  signal: NodeJS.Signals | null,
) => {
  if (stopping) return;
  stopping = true;
  const reason =
    code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
  logLine(`[dev:headless-web] ${label} exited (${reason})`);
  stopAll("SIGTERM");
  process.exitCode = code ?? 1;
};

await ensureTmp();

const remoteAccessEnabled = readBool(process.env.JUGGLEWORK_REMOTE_ACCESS);
const host = remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";
const viteHost = process.env.VITE_HOST ?? process.env.HOST ?? host;
const publicHost = process.env.JUGGLEWORK_PUBLIC_HOST ?? null;
const clientHost = publicHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
const workspace = process.env.JUGGLEWORK_WORKSPACE ?? cwd;
const juggleworkPort = await resolvePort(process.env.JUGGLEWORK_PORT, "127.0.0.1");
const webPort = await resolvePort(process.env.JUGGLEWORK_WEB_PORT, "127.0.0.1");
const juggleworkToken = process.env.JUGGLEWORK_TOKEN ?? randomUUID();
const juggleworkHostToken = process.env.JUGGLEWORK_HOST_TOKEN ?? randomUUID();
const juggleworkServerEntry = path.join(cwd, "apps/server/src/cli.ts");
const juggleworkPluginDir = path.join(cwd, "apps/server/dist/opencode-plugins");

const ensureJuggleWorkServer = async () => {
  try {
    await access(juggleworkServerEntry);
    await access(juggleworkPluginDir);
  } catch {
    if (!autoBuildEnabled) {
      logLine(
        `[dev:headless-web] Missing JuggleWork Server build output at ${juggleworkPluginDir}`,
      );
      logLine(
        "[dev:headless-web] Auto-build disabled (JUGGLEWORK_DEV_HEADLESS_WEB_AUTOBUILD=0)",
      );
      logLine(
        "[dev:headless-web] Run: pnpm --filter jugglework-server build",
      );
      logLine(
        "[dev:headless-web] Or unset/enable JUGGLEWORK_DEV_HEADLESS_WEB_AUTOBUILD to auto-build.",
      );
      process.exit(1);
    }

    logLine(
      `[dev:headless-web] Missing JuggleWork Server build output at ${juggleworkPluginDir}`,
    );
    logLine(
      "[dev:headless-web] Auto-building JuggleWork Server",
    );
    try {
      await runCommand("pnpm", ["--filter", "jugglework-server", "build"]);
      await access(juggleworkServerEntry);
      await access(juggleworkPluginDir);
    } catch (error) {
      logLine(
        `[dev:headless-web] Auto-build failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }
};

const juggleworkUrl = `http://${clientHost}:${juggleworkPort}`;
const webUrl = `http://${clientHost}:${webPort}`;
const viteEnv = {
  ...process.env,
  HOST: viteHost,
  PORT: String(webPort),
  VITE_JUGGLEWORK_URL: process.env.VITE_JUGGLEWORK_URL ?? juggleworkUrl,
  VITE_JUGGLEWORK_PORT: process.env.VITE_JUGGLEWORK_PORT ?? String(juggleworkPort),
  VITE_JUGGLEWORK_TOKEN: process.env.VITE_JUGGLEWORK_TOKEN ?? juggleworkToken,
};
await ensureJuggleWorkServer();
const directServer = await createDirectServerHeadlessLaunch({
  workspace,
  host,
  port: juggleworkPort,
  token: juggleworkToken,
  hostToken: juggleworkHostToken,
  approval: "auto",
  cors: "*",
}, {
  ...process.env,
  JUGGLEWORK_EXTENSIONS_PLUGIN_DIR: juggleworkPluginDir,
});

logLine("[dev:headless-web] Starting services");
logLine(`[dev:headless-web] Workspace: ${workspace}`);
logLine(`[dev:headless-web] JuggleWork server: ${juggleworkUrl}`);
logLine(`[dev:headless-web] Web host: ${viteHost}`);
logLine(`[dev:headless-web] Web port: ${webPort}`);
logLine(`[dev:headless-web] Web URL: ${webUrl}`);
logLine("[dev:headless-web] JUGGLEWORK_TOKEN: [REDACTED]");
logLine("[dev:headless-web] JUGGLEWORK_HOST_TOKEN: [REDACTED]");
logLine(
  `[dev:headless-web] Web logs: ${path.relative(cwd, path.join(tmpDir, "dev-web.log"))}`,
);
logLine(
  `[dev:headless-web] Headless logs: ${path.relative(cwd, path.join(tmpDir, "dev-headless.log"))}`,
);

const webProcess = spawnLogged(
  "pnpm",
  [
    "--filter",
    "@jugglework/app",
    "exec",
    "vite",
    "--host",
    viteHost,
    "--port",
    String(webPort),
    "--strictPort",
  ],
  path.join(tmpDir, "dev-web.log"),
  viteEnv,
);

const headlessProcess = spawnLogged(
  "bun",
  [juggleworkServerEntry, ...directServer.args],
  path.join(tmpDir, "dev-headless.log"),
  directServer.env,
);

const stopAll = (signal: NodeJS.Signals) => {
  webProcess.kill(signal);
  headlessProcess.kill(signal);
};

process.on("SIGINT", () => {
  stopAll("SIGINT");
});
process.on("SIGTERM", () => {
  stopAll("SIGTERM");
});

webProcess.on("exit", (code, signal) => shutdown("web", code, signal));
headlessProcess.on("exit", (code, signal) =>
  shutdown("jugglework-server", code, signal),
);
