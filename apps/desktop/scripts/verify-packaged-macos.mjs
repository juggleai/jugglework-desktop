import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { extractFile } from "@electron/asar";
import { verifyJuggleWorkUiMcp } from "./verify-jugglework-ui-mcp.mjs";
import { inspectArtifact } from "./qiniu-release/metadata.mjs";

const EXPECTED_APP_ID = "com.juggleai.jugglework";
const EXPECTED_TEAM_ID = "H7PDHSK3C7";
const EXPECTED_MAC_UPDATE_FEED = "https://downloads.jugglechat.cn/jugglework/releases/stable/mac";
const LEGACY_ACTIVE_UPDATE_ORIGIN = "github.com/juggleai/jugglework-desktop/releases";
const LOCAL_VERIFICATION_SCHEMA = "com.juggleai.jugglework.macos-local-verification";

function fail(message) {
  throw new Error(`[verify-packaged-macos] ${message}`);
}

function readArg(name) {
  const inline = process.argv.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : "";
}

function expectedMachArch(input) {
  const normalized = String(input ?? "").trim().toLowerCase();
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  if (normalized === "x64" || normalized === "x86_64" || normalized === "amd64") return "x86_64";
  fail(`Unsupported expected architecture: ${input || "<empty>"}`);
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(child));
    if (entry.isFile()) files.push(child);
  }
  return files;
}

const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
]);

function isMachO(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, 4, 0) !== 4) return false;
    return MACH_O_MAGICS.has(header.readUInt32BE(0)) || MACH_O_MAGICS.has(header.readUInt32LE(0));
  } finally {
    closeSync(descriptor);
  }
}

export function verifyMachOArchitectures(appPath, requestedArch) {
  const expected = expectedMachArch(requestedArch);
  const inspected = [];
  const mismatches = [];
  for (const filePath of walkFiles(appPath)) {
    if (!isMachO(filePath)) continue;
    const result = spawnSync("lipo", ["-archs", filePath], { encoding: "utf8" });
    if (result.error) fail(`Unable to inspect ${filePath}: ${result.error.message}`);
    if (result.status !== 0) fail(`lipo failed for ${filePath}: ${result.stderr.trim()}`);
    const architectures = result.stdout.trim().split(/\s+/).filter(Boolean);
    const relativePath = path.relative(appPath, filePath);
    inspected.push({ path: relativePath, architectures });
    if (architectures.length !== 1 || architectures[0] !== expected) {
      mismatches.push({ path: relativePath, architectures });
    }
  }
  if (inspected.length === 0) fail(`No Mach-O files found in ${appPath}`);
  if (mismatches.length > 0) {
    fail(`Mach-O architecture mismatch for ${expected}:\n${mismatches.map((item) => `- ${item.path}: ${item.architectures.join(", ") || "unknown"}`).join("\n")}`);
  }
  return { expected, inspected };
}

function plistValue(plistPath, key) {
  if (!existsSync(plistPath)) fail(`Info.plist not found: ${plistPath}`);
  const result = spawnSync("plutil", ["-extract", key, "raw", "-o", "-", plistPath], { encoding: "utf8" });
  if (result.error) fail(`Unable to inspect ${plistPath}: ${result.error.message}`);
  if (result.status !== 0) fail(`Missing or invalid ${key} in ${plistPath}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function verifyBundleMetadata(appPath, expectedVersion = null) {
  const appPlist = path.join(appPath, "Contents", "Info.plist");
  const helperPlist = path.join(
    appPath,
    "Contents",
    "Resources",
    "helpers",
    "JuggleWork Computer Use.app",
    "Contents",
    "Info.plist",
  );
  const minimumSystemVersion = plistValue(appPlist, "LSMinimumSystemVersion");
  const bundleIdentifier = plistValue(appPlist, "CFBundleIdentifier");
  const bundleVersion = plistValue(appPlist, "CFBundleShortVersionString");
  const helperMinimumSystemVersion = plistValue(helperPlist, "LSMinimumSystemVersion");
  if (minimumSystemVersion !== "14.0") {
    fail(`Expected LSMinimumSystemVersion 14.0, found ${minimumSystemVersion}`);
  }
  if (bundleIdentifier !== EXPECTED_APP_ID) {
    fail(`Expected CFBundleIdentifier ${EXPECTED_APP_ID}, found ${bundleIdentifier}`);
  }
  if (expectedVersion && bundleVersion !== expectedVersion) {
    fail(`Expected CFBundleShortVersionString ${expectedVersion}, found ${bundleVersion}`);
  }
  if (helperMinimumSystemVersion !== "14.0") {
    fail(`Expected Computer Use helper LSMinimumSystemVersion 14.0, found ${helperMinimumSystemVersion}`);
  }
  const screenCaptureUsageDescription = plistValue(appPlist, "NSScreenCaptureUsageDescription");
  if (!screenCaptureUsageDescription) fail("NSScreenCaptureUsageDescription must not be empty");
  return { bundleIdentifier, bundleVersion, minimumSystemVersion, helperMinimumSystemVersion, screenCaptureUsageDescription };
}

function filesRecursively(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(child) : entry.isFile() ? [child] : [];
  });
}

export function assertPackagedUpdaterText(label, text) {
  if (String(text).includes(LEGACY_ACTIVE_UPDATE_ORIGIN)) {
    fail(`${label} contains the legacy active GitHub update origin`);
  }
}

export function verifyPackagedUpdaterConfiguration(appPath) {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const updateConfigPath = path.join(resourcesPath, "app-update.yml");
  if (!existsSync(updateConfigPath)) fail(`Packaged app-update.yml not found: ${updateConfigPath}`);
  const updateConfig = readFileSync(updateConfigPath, "utf8");
  assertPackagedUpdaterText("app-update.yml", updateConfig);
  if (!/^provider:\s*generic\s*$/m.test(updateConfig)) {
    fail("app-update.yml must use the generic provider");
  }
  const configuredUrl = updateConfig.match(/^url:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, "");
  if (configuredUrl !== EXPECTED_MAC_UPDATE_FEED) {
    fail(`Expected macOS updater feed ${EXPECTED_MAC_UPDATE_FEED}, found ${configuredUrl || "<missing>"}`);
  }

  const asarPath = path.join(resourcesPath, "app.asar");
  if (!existsSync(asarPath)) fail(`Packaged app.asar not found: ${asarPath}`);
  const updaterSource = ["electron/updater.mjs", "electron/architecture-download.mjs", "electron/main.mjs"]
    .map((entry) => extractFile(asarPath, entry).toString("utf8"))
    .join("\n");
  assertPackagedUpdaterText("compiled Electron updater code", updaterSource);
  if (!/allowDowngrade\s*=\s*false/.test(updaterSource)) {
    fail("compiled updater code must explicitly disable downgrade");
  }

  const rendererFiles = filesRecursively(path.join(resourcesPath, "app-dist"))
    .filter((filePath) => /\.(?:html|js|mjs|css)$/.test(filePath));
  for (const filePath of rendererFiles) {
    assertPackagedUpdaterText(path.relative(resourcesPath, filePath), readFileSync(filePath, "utf8"));
  }
  return { provider: "generic", url: configuredUrl, monotonic: true };
}

export function verifyCodeSignature(appPath) {
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { encoding: "utf8" });
  if (verify.error) fail(`Unable to verify code signature: ${verify.error.message}`);
  if (verify.status !== 0) fail(`codesign verification failed: ${verify.stderr.trim()}`);
  const details = spawnSync("codesign", ["--display", "--verbose=4", appPath], { encoding: "utf8" });
  if (details.error) fail(`Unable to inspect code signature: ${details.error.message}`);
  if (details.status !== 0) fail(`codesign inspection failed: ${details.stderr.trim()}`);
  const output = `${details.stdout}\n${details.stderr}`;
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (identifier !== EXPECTED_APP_ID) fail(`Expected signed identifier ${EXPECTED_APP_ID}, found ${identifier || "<missing>"}`);
  if (teamIdentifier !== EXPECTED_TEAM_ID) fail(`Expected signing TeamIdentifier ${EXPECTED_TEAM_ID}, found ${teamIdentifier || "<missing>"}`);
  if (!/^CodeDirectory .*flags=.*\bruntime\b/m.test(output)) fail("Code signature does not enable hardened runtime");
  return { identifier, teamIdentifier, hardenedRuntime: true };
}

function commandAssessment(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    accepted: !result.error && result.status === 0,
    detail: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    error: result.error?.message ?? null,
    status: result.status,
  };
}

export function verifyAppleTrust(appPath) {
  const staple = commandAssessment("xcrun", ["stapler", "validate", appPath]);
  const gatekeeper = commandAssessment("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  return {
    notarization: { status: staple.accepted ? "accepted" : "unavailable" },
    staple: { status: staple.accepted ? "validated" : "unavailable" },
    gatekeeper: { status: gatekeeper.accepted ? "accepted" : "unavailable" },
    diagnostics: {
      staple: staple.accepted ? "accepted" : staple.error || staple.detail || `status ${staple.status}`,
      gatekeeper: gatekeeper.accepted ? "accepted" : gatekeeper.error || gatekeeper.detail || `status ${gatekeeper.status}`,
    },
  };
}

function notarizationCredentialState(environment = process.env) {
  const required = ["APPLE_API_KEY_PATH", "APPLE_API_KEY", "APPLE_API_ISSUER"];
  return environment.MACOS_NOTARIZE === "true" && required.every((name) => Boolean(environment[name]))
    ? "available"
    : "missing";
}

export function createLocalVerificationRecord({
  version,
  architectures,
  signature,
  trust,
  artifacts = [],
  manifest = null,
  notarizationReceipt = null,
  environment = process.env,
  verifiedAt = new Date().toISOString(),
}) {
  const credentialState = notarizationCredentialState(environment);
  const receiptMatches = notarizationReceipt?.schema === "com.juggleai.jugglework.macos-notarization-receipt"
    && notarizationReceipt.schemaVersion === 1
    && notarizationReceipt.producer === "electron-after-sign"
    && notarizationReceipt.version === version
    && notarizationReceipt.bundleIdentifier === signature.identifier
    && notarizationReceipt.status === "accepted"
    && notarizationReceipt.staple === "validated"
    && typeof notarizationReceipt.submissionId === "string"
    && notarizationReceipt.submissionId.length > 0;
  const releaseReady = credentialState === "available"
    && receiptMatches
    && trust.notarization.status === "accepted"
    && trust.staple.status === "validated"
    && trust.gatekeeper.status === "accepted";
  return {
    schema: LOCAL_VERIFICATION_SCHEMA,
    schemaVersion: 1,
    producer: "verify-packaged-macos",
    version,
    platform: "mac",
    architectures,
    verifiedAt,
    releaseState: releaseReady ? "release" : "candidate",
    credentialState,
    identity: {
      bundleIdentifier: signature.identifier,
      teamIdentifier: signature.teamIdentifier,
    },
    codesign: { status: "accepted", deep: true, strict: true },
    hardenedRuntime: { status: signature.hardenedRuntime ? "enabled" : "disabled" },
    notarization: releaseReady
      ? { status: "accepted", submissionId: notarizationReceipt.submissionId }
      : { status: "unavailable" },
    staple: trust.staple,
    gatekeeper: trust.gatekeeper,
    artifacts,
    manifest,
  };
}

function findSingleApp(directory) {
  const apps = [];
  const visit = (current, depth) => {
    if (depth > 4) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) apps.push(child);
      else if (entry.isDirectory()) visit(child, depth + 1);
    }
  };
  visit(directory, 0);
  if (apps.length !== 1) fail(`Expected exactly one .app in ${directory}, found ${apps.length}`);
  return apps[0];
}

function verifyReleaseBundle(appPath, { expectedArch, expectedVersion }) {
  const metadata = verifyBundleMetadata(appPath, expectedVersion);
  const signature = verifyCodeSignature(appPath);
  const architecture = verifyMachOArchitectures(appPath, expectedArch);
  if (metadata.bundleIdentifier !== signature.identifier) fail("Bundle metadata and signed identifier disagree");
  return { architecture, metadata, signature };
}

export function verifyZipBundle(zipPath, expected) {
  const resolved = path.resolve(zipPath);
  if (!existsSync(resolved)) fail(`ZIP not found: ${resolved}`);
  const directory = mkdtempSync(path.join(tmpdir(), "jugglework-verify-zip-"));
  try {
    const result = spawnSync("ditto", ["-x", "-k", resolved, directory], { encoding: "utf8" });
    if (result.error || result.status !== 0) fail(`Unable to extract ZIP: ${result.error?.message || result.stderr.trim()}`);
    return verifyReleaseBundle(findSingleApp(directory), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function verifyDmgBundle(dmgPath, expected) {
  const resolved = path.resolve(dmgPath);
  if (!existsSync(resolved)) fail(`DMG not found: ${resolved}`);
  const mountPoint = mkdtempSync(path.join(tmpdir(), "jugglework-verify-dmg-"));
  let mounted = false;
  try {
    const attach = spawnSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, resolved], { encoding: "utf8" });
    if (attach.error || attach.status !== 0) fail(`Unable to mount DMG: ${attach.error?.message || attach.stderr.trim()}`);
    mounted = true;
    return verifyReleaseBundle(findSingleApp(mountPoint), expected);
  } finally {
    if (mounted) spawnSync("hdiutil", ["detach", mountPoint], { encoding: "utf8" });
    rmSync(mountPoint, { recursive: true, force: true });
  }
}

export function verifyMacTrayResources(appPath) {
  const expectedImages = [
    { name: "juggleworkTemplate.png", width: 16, height: 16 },
    { name: "juggleworkTemplate@2x.png", width: 32, height: 32 },
  ];
  const trayDir = path.join(appPath, "Contents", "Resources", "tray");
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const verified = [];
  for (const expected of expectedImages) {
    const filePath = path.join(trayDir, expected.name);
    if (!existsSync(filePath)) fail(`Packaged macOS tray template image not found: ${filePath}`);
    const header = readFileSync(filePath).subarray(0, 26);
    if (header.length < 26 || !header.subarray(0, 8).equals(signature) || header.subarray(12, 16).toString("ascii") !== "IHDR") {
      fail(`Invalid packaged macOS tray template PNG: ${filePath}`);
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (width !== expected.width || height !== expected.height) {
      fail(`Expected ${expected.name} to be ${expected.width}x${expected.height}, found ${width}x${height}`);
    }
    if (header[24] !== 8 || header[25] !== 6) {
      fail(`Expected ${expected.name} to be an 8-bit RGBA PNG`);
    }
    verified.push({ name: expected.name, width, height, rgba: true });
  }
  return verified;
}

export function resolvePackagedApp(input) {
  const candidate = path.resolve(input);
  if (!existsSync(candidate)) fail(`App bundle not found: ${candidate}`);
  if (!candidate.endsWith(".app")) fail(`Expected a .app bundle: ${candidate}`);
  return candidate;
}

export function packagedExecutable(appPath) {
  const macOSDir = path.join(appPath, "Contents", "MacOS");
  const entries = existsSync(macOSDir) ? readdirSync(macOSDir, { withFileTypes: true }) : [];
  const executable = entries.find((entry) => entry.isFile());
  if (!executable) fail(`No packaged executable found in ${macOSDir}`);
  return path.join(macOSDir, executable.name);
}

function runPackagedNode(appPath, label, source) {
  const executable = packagedExecutable(appPath);
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  if (!existsSync(asarPath)) fail(`Packaged app.asar not found: ${asarPath}`);

  const result = spawnSync(executable, ["-e", source, asarPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeout: 30_000,
  });
  if (result.error) fail(`${label} smoke test failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${label} smoke test exited with ${result.status}${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

export function verifyPackagedNativeModules(appPath) {
  const sqliteOutput = runPackagedNode(
    appPath,
    "better-sqlite3",
    String.raw`
      const asarPath = process.argv[1];
      const Database = require(asarPath + "/node_modules/better-sqlite3");
      const database = new Database(":memory:");
      const row = database.prepare("select 1 as ok").get();
      database.close();
      if (row?.ok !== 1) throw new Error("SQLite query returned an unexpected result");
      console.log("better-sqlite3:ok");
    `,
  );

  const ptyOutput = runPackagedNode(
    appPath,
    "node-pty",
    String.raw`
      const asarPath = process.argv[1];
      const pty = require(asarPath + "/node_modules/node-pty");
      const terminal = pty.spawn("/bin/sh", ["-c", "printf jugglework-pty-ok"], {
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
      });
      let output = "";
      const timer = setTimeout(() => {
        terminal.kill();
        throw new Error("PTY smoke test timed out");
      }, 10_000);
      terminal.onData((chunk) => { output += chunk; });
      terminal.onExit(() => {
        clearTimeout(timer);
        if (!output.includes("jugglework-pty-ok")) {
          console.error(output);
          process.exitCode = 1;
          return;
        }
        console.log("node-pty:ok");
      });
    `,
  );

  return { sqliteOutput, ptyOutput };
}

export async function verifyPackagedUiControlMcp(appPath) {
  const executable = packagedExecutable(appPath);
  const entry = path.join(appPath, "Contents", "Resources", "jugglework-ui-mcp", "index.mjs");
  if (!existsSync(entry)) fail(`Packaged UI control MCP not found: ${entry}`);
  try {
    return await verifyJuggleWorkUiMcp({
      runtime: executable,
      entry,
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      timeoutMs: 10_000,
    });
  } catch (error) {
    fail(`Packaged UI control MCP smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function main() {
  if (process.platform !== "darwin") fail("Packaged macOS verification must run on macOS");
  const appInput = readArg("--app") || process.argv[2];
  if (!appInput) fail("Pass --app /path/to/JuggleWork.app");
  const appPath = resolvePackagedApp(appInput);
  const requestedArch = readArg("--arch") || process.arch;
  const version = readArg("--version");
  const verificationOutput = readArg("--verification-output");
  const zipPath = readArg("--zip");
  const dmgPath = readArg("--dmg");
  const manifestPath = readArg("--manifest");
  const notarizationReceiptPath = readArg("--notarization-receipt");
  const architecture = verifyMachOArchitectures(appPath, requestedArch);
  const metadata = verifyBundleMetadata(appPath, version || null);
  const updater = verifyPackagedUpdaterConfiguration(appPath);
  const signature = verifyCodeSignature(appPath);
  const trust = verifyAppleTrust(appPath);
  const expectedContainer = { expectedArch: requestedArch, expectedVersion: version || null };
  const zip = zipPath ? verifyZipBundle(zipPath, expectedContainer) : null;
  const dmg = dmgPath ? verifyDmgBundle(dmgPath, expectedContainer) : null;
  if (verificationOutput && (!version || !zipPath || !dmgPath || !manifestPath)) {
    fail("--verification-output requires --version, --zip, --dmg, and --manifest");
  }
  const verifiedArtifacts = verificationOutput
    ? await Promise.all([zipPath, dmgPath, `${zipPath}.blockmap`, `${dmgPath}.blockmap`].map(async (filePath) => ({
        name: path.basename(filePath),
        ...(await inspectArtifact(path.resolve(filePath))),
      })))
    : [];
  const verifiedManifest = verificationOutput
    ? { name: path.basename(manifestPath), ...(await inspectArtifact(path.resolve(manifestPath))) }
    : null;
  const notarizationReceipt = notarizationReceiptPath
    ? JSON.parse(readFileSync(path.resolve(notarizationReceiptPath), "utf8"))
    : null;
  const localVerification = verificationOutput
    ? createLocalVerificationRecord({
        version,
        architectures: [requestedArch === "x86_64" ? "x64" : requestedArch],
        signature,
        trust,
        artifacts: verifiedArtifacts,
        manifest: verifiedManifest,
        notarizationReceipt,
      })
    : null;
  const tray = verifyMacTrayResources(appPath);
  const nativeModules = verifyPackagedNativeModules(appPath);
  const uiControlMcp = await verifyPackagedUiControlMcp(appPath);
  if (verificationOutput) {
    const outputPath = path.resolve(verificationOutput);
    writeFileSync(outputPath, `${JSON.stringify(localVerification, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, appPath, architecture, metadata, updater, signature, trust, zip, dmg, verificationOutput: verificationOutput || null, localVerification, tray, nativeModules, uiControlMcp }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
