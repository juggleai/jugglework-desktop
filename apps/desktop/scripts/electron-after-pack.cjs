const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");

const computerUseHelperAppName = "JuggleWork Computer Use.app";

const sidecarBases = ["opencode"];

function normalizeArch(arch) {
  if (typeof arch === "number") {
    // electron-builder's Arch enum: x64 = 1, arm64 = 3.
    if (arch === 1) return "x64";
    if (arch === 3) return "arm64";
    return null;
  }

  const value = String(arch ?? "").trim().toLowerCase();
  if (["x64", "x86_64", "amd64"].includes(value)) return "x64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  return null;
}

function targetTriple(platformName, arch) {
  const normalizedArch = normalizeArch(arch);
  if (platformName === "darwin") {
    if (normalizedArch === "arm64") return "aarch64-apple-darwin";
    if (normalizedArch === "x64") return "x86_64-apple-darwin";
  }
  if (platformName === "linux") {
    if (normalizedArch === "arm64") return "aarch64-unknown-linux-gnu";
    if (normalizedArch === "x64") return "x86_64-unknown-linux-gnu";
  }
  if (platformName === "win32") {
    if (normalizedArch === "arm64") return "aarch64-pc-windows-msvc";
    if (normalizedArch === "x64") return "x86_64-pc-windows-msvc";
  }
  return null;
}

function resolveSidecarsDir(context) {
  if (context.electronPlatformName === "darwin") {
    const entries = fs.existsSync(context.appOutDir) ? fs.readdirSync(context.appOutDir) : [];
    const appName = entries.find((entry) => entry.endsWith(".app"));
    return appName ? path.join(context.appOutDir, appName, "Contents", "Resources", "sidecars") : null;
  }
  return path.join(context.appOutDir, "resources", "sidecars");
}

function resolveMacAppPath(context) {
  if (context.electronPlatformName !== "darwin") return null;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const direct = path.join(context.appOutDir, appName);
  if (fs.existsSync(direct)) return direct;

  const entries = fs.existsSync(context.appOutDir) ? fs.readdirSync(context.appOutDir) : [];
  const fallback = entries.find((entry) => entry.endsWith(".app"));
  return fallback ? path.join(context.appOutDir, fallback) : null;
}

function resolvePackagedResourcesPath(context) {
  if (context.electronPlatformName === "darwin") {
    const appPath = resolveMacAppPath(context);
    return appPath ? path.join(appPath, "Contents", "Resources") : null;
  }
  return path.join(context.appOutDir, "resources");
}

function verifyCompiledRuntimeContracts(context) {
  const resourcesPath = resolvePackagedResourcesPath(context);
  const archivePath = resourcesPath ? path.join(resourcesPath, "app.asar") : null;
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`Missing packaged app.asar at ${archivePath ?? "unknown path"}`);
  }

  const entries = asar.listPackage(archivePath);
  const runtimePackageRoot = "/node_modules/@jugglework/types/";
  const compiledContract = "/dist/runtime/desktop-remote-control.js";
  const automationContract = `${runtimePackageRoot}dist/automation.js`;
  if (!entries.includes(compiledContract)) {
    throw new Error(`Missing compiled Electron runtime contract: ${compiledContract}`);
  }
  if (!entries.includes(automationContract)) {
    throw new Error(`Missing packaged automation runtime contract: ${automationContract}`);
  }

  const leakedSources = entries.filter((entry) => (
    (entry.startsWith(`${runtimePackageRoot}src/`) && /\.(?:ts|tsx|map)$/.test(entry)) ||
    (entry.startsWith("/dist/runtime/") && /\.(?:ts|tsx|map)$/.test(entry))
  ));
  if (leakedSources.length > 0) {
    throw new Error(`TypeScript sources leaked into the packaged runtime: ${leakedSources.join(", ")}`);
  }
}

function verifyBundledUiControlMcp(context) {
  const resourcesPath = resolvePackagedResourcesPath(context);
  const entryPath = resourcesPath
    ? path.join(resourcesPath, "jugglework-ui-mcp", "index.mjs")
    : null;
  if (!entryPath || !fs.existsSync(entryPath)) {
    throw new Error(`Missing packaged JuggleWork UI control MCP at ${entryPath ?? "unknown path"}`);
  }
  const source = fs.readFileSync(entryPath, "utf8");
  if (!source.includes("jugglework-ui")) {
    throw new Error(`Packaged JuggleWork UI control MCP has an unexpected payload: ${entryPath}`);
  }
}

function resolvePackagedExecutable(context) {
  if (context.electronPlatformName === "darwin") {
    const appPath = resolveMacAppPath(context);
    return appPath
      ? path.join(appPath, "Contents", "MacOS", context.packager.appInfo.productFilename)
      : null;
  }
  const suffix = context.electronPlatformName === "win32" ? ".exe" : "";
  const candidates = [
    context.packager.appInfo.productFilename,
    context.packager.appInfo.sanitizedProductName,
    "jugglework",
  ].filter(Boolean).map((name) => path.join(context.appOutDir, `${name}${suffix}`));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function verifyBundledUiControlMcpRuntime(context) {
  const resourcesPath = resolvePackagedResourcesPath(context);
  const entry = resourcesPath ? path.join(resourcesPath, "jugglework-ui-mcp", "index.mjs") : null;
  const runtime = resolvePackagedExecutable(context);
  if (!entry || !runtime || !fs.existsSync(entry) || !fs.existsSync(runtime)) {
    throw new Error(`Cannot run packaged JuggleWork UI control MCP verification (runtime=${runtime ?? "missing"}, entry=${entry ?? "missing"})`);
  }
  const { verifyJuggleWorkUiMcp } = await import("./verify-jugglework-ui-mcp.mjs");
  await verifyJuggleWorkUiMcp({
    runtime,
    entry,
    environment: { ELECTRON_RUN_AS_NODE: "1" },
    timeoutMs: 10_000,
  });
}

function pruneBetterSqlitePrebuilds(context, arch) {
  const resourcesPath = resolvePackagedResourcesPath(context);
  const prebuildsDir = resourcesPath
    ? path.join(resourcesPath, "app.asar.unpacked", "node_modules", "better-sqlite3", "prebuilds")
    : null;
  if (!prebuildsDir || !fs.existsSync(prebuildsDir)) return;

  const platformPrefix = context.electronPlatformName === "darwin"
    ? "darwin"
    : context.electronPlatformName === "linux"
      ? "linux"
      : context.electronPlatformName === "win32"
        ? "win32"
        : null;
  const normalizedArch = normalizeArch(arch);
  if (!platformPrefix || !normalizedArch) return;
  const keep = `${platformPrefix}-${normalizedArch}.node`;

  for (const entry of fs.readdirSync(prebuildsDir)) {
    if (entry !== keep) fs.rmSync(path.join(prebuildsDir, entry), { force: true });
  }
  if (!fs.existsSync(path.join(prebuildsDir, keep))) {
    throw new Error(`Missing packaged better-sqlite3 prebuild for target: ${keep}`);
  }
}

function signComputerUseHelper(context) {
  const appPath = resolveMacAppPath(context);
  if (!appPath) return;

  const helperPath = path.join(appPath, "Contents", "Resources", "helpers", computerUseHelperAppName);
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Missing Computer Use helper app at ${helperPath}`);
  }

  const identity = process.env.JUGGLEWORK_COMPUTER_USE_CODESIGN_IDENTITY
    || process.env.CSC_NAME
    || process.env.APPLE_CODESIGN_IDENTITY
    || "-";
  const args = ["--force", "--deep", "--options", "runtime", "--sign", identity];
  if (identity !== "-") args.push("--timestamp");
  args.push(helperPath);

  const result = spawnSync("codesign", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codesign failed for Computer Use helper app with status ${result.status}`);
  }
}

function copyExecutableTargetToAlias(sidecarsDir, targetName, aliasName) {
  const targetPath = path.join(sidecarsDir, targetName);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing packaged sidecar for target: ${targetName}`);
  }

  const aliasPath = path.join(sidecarsDir, aliasName);
  fs.copyFileSync(targetPath, aliasPath);
  try {
    fs.chmodSync(aliasPath, 0o755);
  } catch {
    // Windows and some filesystems may ignore chmod.
  }
}

async function runAfterPack(context, dependencies = {}) {
  const verifyContracts = dependencies.verifyContracts ?? verifyCompiledRuntimeContracts;
  const verifyUiControlMcp = dependencies.verifyUiControlMcp ?? verifyBundledUiControlMcp;
  const verifyUiControlMcpRuntime = dependencies.verifyUiControlMcpRuntime ?? verifyBundledUiControlMcpRuntime;
  const signHelper = dependencies.signHelper ?? signComputerUseHelper;
  verifyContracts(context);
  verifyUiControlMcp(context);
  await verifyUiControlMcpRuntime(context);

  const triple = targetTriple(context.electronPlatformName, context.arch);
  if (!triple) return;
  pruneBetterSqlitePrebuilds(context, context.arch);

  const sidecarsDir = resolveSidecarsDir(context);
  if (!sidecarsDir || !fs.existsSync(sidecarsDir)) return;

  const isWindows = context.electronPlatformName === "win32";
  const executableSuffix = isWindows ? ".exe" : "";
  const keep = new Set();

  for (const base of sidecarBases) {
    const aliasName = `${base}${executableSuffix}`;
    const targetName = `${base}-${triple}${executableSuffix}`;
    copyExecutableTargetToAlias(sidecarsDir, targetName, aliasName);
    keep.add(aliasName);
    keep.add(targetName);
  }

  const versionsAlias = "versions.json";
  const versionsTarget = `versions.json-${triple}${executableSuffix}`;
  const versionsTargetPath = path.join(sidecarsDir, versionsTarget);
  if (!fs.existsSync(versionsTargetPath)) {
    throw new Error(`Missing packaged sidecar metadata for target: ${versionsTarget}`);
  }
  fs.copyFileSync(versionsTargetPath, path.join(sidecarsDir, versionsAlias));
  keep.add(versionsAlias);
  keep.add(versionsTarget);

  for (const entry of fs.readdirSync(sidecarsDir)) {
    if (!keep.has(entry)) {
      fs.rmSync(path.join(sidecarsDir, entry), { force: true, recursive: true });
    }
  }

  signHelper(context);
}

async function afterPack(context) {
  await runAfterPack(context);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.normalizeArch = normalizeArch;
module.exports.pruneBetterSqlitePrebuilds = pruneBetterSqlitePrebuilds;
module.exports.runAfterPack = runAfterPack;
module.exports.targetTriple = targetTriple;
module.exports.verifyBundledUiControlMcp = verifyBundledUiControlMcp;
module.exports.verifyBundledUiControlMcpRuntime = verifyBundledUiControlMcpRuntime;
