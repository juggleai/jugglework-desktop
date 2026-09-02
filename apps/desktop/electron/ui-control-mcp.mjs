import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_CONTROL_MCP_RESOURCE_DIRECTORY = "jugglework-ui-mcp";
const UI_CONTROL_MCP_ENTRY = "index.mjs";
const installPromises = new Map();

export function bundledUiControlMcpPath(resourcesPath) {
  const root = String(resourcesPath ?? "").trim();
  return root ? path.join(root, UI_CONTROL_MCP_RESOURCE_DIRECTORY, UI_CONTROL_MCP_ENTRY) : null;
}

export function sourceUiControlMcpPath() {
  return path.resolve(__dirname, "../../..", "packages", "jugglework-ui-mcp", UI_CONTROL_MCP_ENTRY);
}

export function packagedUiControlMcpRuntime({
  platform = process.platform,
  executablePath = process.execPath,
  appImagePath = process.env.APPIMAGE,
} = {}) {
  const runtime = platform === "linux" && String(appImagePath ?? "").trim()
    ? String(appImagePath).trim()
    : String(executablePath ?? "").trim();
  if (!runtime) {
    throw new Error("JuggleWork UI control MCP cannot start because the application runtime path is unavailable.");
  }
  return runtime;
}

async function installBundledUiControlMcpOnce({ resourcesPath, userDataPath, version }) {
  const source = bundledUiControlMcpPath(resourcesPath);
  const profileRoot = String(userDataPath ?? "").trim();
  const release = String(version ?? "").trim();
  if (!source || !profileRoot || !release || !existsSync(source)) {
    throw new Error(`JuggleWork UI control MCP is missing from this JuggleWork build: ${source ?? "<missing resources path>"}`);
  }
  const destinationDirectory = path.join(profileRoot, "runtime", "jugglework-ui-mcp", release);
  const destination = path.join(destinationDirectory, UI_CONTROL_MCP_ENTRY);
  const sourceBytes = await readFile(source);
  const existingBytes = await readFile(destination).catch(() => null);
  if (existingBytes?.equals(sourceBytes)) return destination;

  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, sourceBytes, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return destination;
}

export async function installBundledUiControlMcp(options) {
  const key = [options?.resourcesPath, options?.userDataPath, options?.version].map((value) => String(value ?? "")).join("\0");
  const active = installPromises.get(key);
  if (active) return active;
  const installation = installBundledUiControlMcpOnce(options).finally(() => {
    if (installPromises.get(key) === installation) installPromises.delete(key);
  });
  installPromises.set(key, installation);
  return installation;
}

/**
 * Resolve the built-in UI MCP without consulting PATH or a package registry.
 * The caller adds ELECTRON_RUN_AS_NODE=1 through getJuggleWorkUiMcpEnvironment.
 */
export function getJuggleWorkUiMcpCommand({
  packaged = false,
  executablePath = process.execPath,
  resourcesPath = process.resourcesPath,
  sourcePath = sourceUiControlMcpPath(),
  bundledPath = null,
  platform = process.platform,
  appImagePath = process.env.APPIMAGE,
  pathExists = existsSync,
} = {}) {
  const entryPath = packaged ? bundledPath ?? bundledUiControlMcpPath(resourcesPath) : sourcePath;
  if (!entryPath || !pathExists(entryPath)) {
    const location = entryPath ?? "<missing resources path>";
    throw new Error(`JuggleWork UI control MCP is missing from this JuggleWork build: ${location}`);
  }

  const runtime = packaged
    ? packagedUiControlMcpRuntime({ platform, executablePath, appImagePath })
    : String(executablePath ?? "").trim();
  if (!runtime) throw new Error("JuggleWork UI control MCP cannot start because the application runtime path is unavailable.");
  return [runtime, entryPath];
}

export function getJuggleWorkUiMcpEnvironment(userDataPath) {
  const root = String(userDataPath ?? "").trim();
  if (!root) {
    throw new Error("JuggleWork UI control MCP cannot resolve the current application profile.");
  }
  return {
    ELECTRON_RUN_AS_NODE: "1",
    JUGGLEWORK_UI_CONTROL_DISCOVERY: path.join(root, "jugglework-ui-control.json"),
  };
}
