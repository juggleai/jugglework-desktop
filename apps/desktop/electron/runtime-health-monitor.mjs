import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;

function envValue(env, name) {
  return String(env?.[name] ?? "").trim();
}

function opencodeDataDirectories({ env, homedir, platform }) {
  const directories = [];
  const xdgDataHome = envValue(env, "XDG_DATA_HOME");
  if (xdgDataHome) directories.push(path.join(xdgDataHome, "opencode"));
  directories.push(path.join(homedir, ".local", "share", "opencode"));
  if (platform === "darwin") directories.push(path.join(homedir, "Library", "Application Support", "opencode"));
  if (platform === "win32") {
    const appData = envValue(env, "APPDATA") || path.join(homedir, "AppData", "Roaming");
    directories.push(path.join(appData, "opencode"));
  }
  return [...new Set(directories)];
}

/** Resolve the database OpenCode itself will prefer without opening or mutating it. */
export function resolveOpencodeDatabasePath({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  const directories = opencodeDataDirectories({ env, homedir, platform });
  const override = envValue(env, "OPENCODE_DB");
  if (override) {
    const candidates = path.isAbsolute(override)
      ? [override]
      : directories.map((directory) => path.join(directory, override));
    return candidates.find(fileExists) ?? candidates[0] ?? null;
  }

  const channel = envValue(env, "OPENCODE_CHANNEL") || "local";
  const disableChannelDb = /^(1|true|yes|on)$/i.test(envValue(env, "OPENCODE_DISABLE_CHANNEL_DB"));
  const names = channel === "latest" || channel === "beta" || disableChannelDb
    ? ["opencode.db"]
    : [`opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`, "opencode.db"];
  const candidates = directories.flatMap((directory) => names.map((name) => path.join(directory, name)));
  return candidates.find(fileExists) ?? candidates[0] ?? null;
}

export function parsePsProcessMetrics(stdout) {
  const match = String(stdout ?? "").trim().match(/^(\d+)\s+([\d.]+)$/);
  if (!match) return null;
  if (!Number.isFinite(Number(match[1]) * 1024) || !Number.isFinite(Number(match[2]))) return null;
  return {
    rssBytes: Number(match[1]) * 1024,
    cpuPercent: Number(match[2]),
  };
}

export async function sampleProcessMetrics(pid, {
  platform = process.platform,
  run = execFileAsync,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") {
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop | Select-Object WorkingSet64,CPU | ConvertTo-Json -Compress)`;
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      const value = JSON.parse(String(stdout ?? "{}"));
      const rssBytes = Number(value.WorkingSet64);
      return Number.isFinite(rssBytes) ? { rssBytes, cpuPercent: null } : null;
    }
    const { stdout } = await run("ps", ["-o", "rss=,pcpu=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return parsePsProcessMetrics(stdout);
  } catch {
    return null;
  }
}

export function classifyRuntimePressure({ rssBytes = 0, databaseBytes = 0 } = {}) {
  const rss = Number.isFinite(rssBytes) ? rssBytes : 0;
  const database = Number.isFinite(databaseBytes) ? databaseBytes : 0;
  if (rss >= 4 * GIB || (rss >= 2 * GIB && database >= 3 * GIB)) return "critical";
  if (rss >= 2 * GIB || database >= 1 * GIB) return "warning";
  return "normal";
}

/**
 * @param {string | null} databasePath
 * @param {(path: string) => Promise<{size: number}>} statFile
 */
async function databaseDiskUsage(databasePath, statFile = stat) {
  if (!databasePath) return 0;
  let total = 0;
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      total += (await statFile(candidate)).size;
    } catch {
      // The database or transient WAL file may not exist yet.
    }
  }
  return total;
}

/**
 * Samples the managed OpenCode process without changing its lifecycle.
 * Diagnostics are emitted on pressure transitions and periodically while stable.
 */
/**
 * @param {{
 *   runtimeManager: {engineInfo: () => Promise<{pid?: number | null}>},
 *   record?: (event: string, data?: Record<string, unknown>) => void,
 *   env?: NodeJS.ProcessEnv,
 *   homedir?: string,
 *   platform?: NodeJS.Platform,
 *   intervalMs?: number,
 *   stableRecordMs?: number,
 *   processSampler?: (pid: number, options: {platform: NodeJS.Platform}) => Promise<{rssBytes: number, cpuPercent: number | null} | null>,
 *   statFile?: (path: string) => Promise<{size: number}>,
 *   now?: () => number,
 *   setIntervalFn?: (callback: () => void, delay?: number) => any,
 *   clearIntervalFn?: (timer: any) => void,
 * }} options
 */
export function installRuntimeHealthMonitor(options) {
  const {
    runtimeManager,
    record = () => {},
    env = process.env,
    homedir = os.homedir(),
    platform = process.platform,
    intervalMs = 60_000,
    stableRecordMs = 10 * 60_000,
    processSampler = sampleProcessMetrics,
    statFile = stat,
    now = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options ?? {};
  if (!runtimeManager?.engineInfo) throw new Error("runtimeManager.engineInfo is required");
  const databasePath = resolveOpencodeDatabasePath({ env, homedir, platform });
  let disposed = false;
  let latest = null;
  let inFlight = null;
  let lastRecordedLevel = null;
  let lastRecordedAt = 0;

  const sampleNow = () => {
    if (disposed) return Promise.resolve(null);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const engine = await runtimeManager.engineInfo().catch(() => null);
      const pid = Number(engine?.pid);
      const [processMetrics, databaseBytes] = await Promise.all([
        processSampler(pid, { platform }).catch(() => null),
        databaseDiskUsage(databasePath, statFile),
      ]);
      if (disposed) return null;
      const sampledAt = now();
      const sample = {
        at: new Date(sampledAt).toISOString(),
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        rssBytes: processMetrics?.rssBytes ?? null,
        cpuPercent: processMetrics?.cpuPercent ?? null,
        databaseBytes,
        databasePath,
        pressure: classifyRuntimePressure({
          rssBytes: processMetrics?.rssBytes ?? 0,
          databaseBytes,
        }),
      };
      latest = sample;
      if (sample.pressure !== lastRecordedLevel || sampledAt - lastRecordedAt >= stableRecordMs) {
        record("runtime.health", {
          pid: sample.pid,
          rssBytes: sample.rssBytes,
          cpuPercent: sample.cpuPercent,
          databaseBytes: sample.databaseBytes,
          pressure: sample.pressure,
        });
        lastRecordedLevel = sample.pressure;
        lastRecordedAt = sampledAt;
      }
      return sample;
    })().catch(() => null).finally(() => { inFlight = null; });
    return inFlight;
  };

  const timer = setIntervalFn(() => { void sampleNow(); }, intervalMs);
  timer?.unref?.();
  void sampleNow();

  return {
    latest: () => latest,
    sampleNow,
    dispose() {
      disposed = true;
      clearIntervalFn(timer);
    },
  };
}
