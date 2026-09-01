import { existsSync, openSync, closeSync, readSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

export function verifyBundleMetadata(appPath) {
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
  const helperMinimumSystemVersion = plistValue(helperPlist, "LSMinimumSystemVersion");
  if (minimumSystemVersion !== "14.0") {
    fail(`Expected LSMinimumSystemVersion 14.0, found ${minimumSystemVersion}`);
  }
  if (helperMinimumSystemVersion !== "14.0") {
    fail(`Expected Computer Use helper LSMinimumSystemVersion 14.0, found ${helperMinimumSystemVersion}`);
  }
  const screenCaptureUsageDescription = plistValue(appPlist, "NSScreenCaptureUsageDescription");
  if (!screenCaptureUsageDescription) fail("NSScreenCaptureUsageDescription must not be empty");
  return { minimumSystemVersion, helperMinimumSystemVersion, screenCaptureUsageDescription };
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

export function main() {
  if (process.platform !== "darwin") fail("Packaged macOS verification must run on macOS");
  const appInput = readArg("--app") || process.argv[2];
  if (!appInput) fail("Pass --app /path/to/JuggleWork.app");
  const appPath = resolvePackagedApp(appInput);
  const requestedArch = readArg("--arch") || process.arch;
  const architecture = verifyMachOArchitectures(appPath, requestedArch);
  const metadata = verifyBundleMetadata(appPath);
  const nativeModules = verifyPackagedNativeModules(appPath);
  process.stdout.write(`${JSON.stringify({ ok: true, appPath, architecture, metadata, nativeModules }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
