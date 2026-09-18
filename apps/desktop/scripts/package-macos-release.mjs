import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_CERTIFICATE_NAME = "Beijing Qiyilu Technology Co., Ltd (H7PDHSK3C7)";
const EXPECTED_IDENTITY = `Developer ID Application: ${EXPECTED_CERTIFICATE_NAME}`;
const DEFAULT_NOTARY_PROFILE = "JUGGLEWORK_NOTARY_PROFILE";

function fail(message) {
  throw new Error(`[package-macos-release] ${message}`);
}

function readArg(name) {
  const inline = process.argv.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : "";
}

function normalizeArch(input) {
  const value = String(input).toLowerCase();
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "x64" || value === "x86_64") return "x64";
  fail(`Unsupported architecture: ${input}`);
}

function normalizeElectronBuilderIdentity(input) {
  const value = String(input ?? "").trim();
  if (!value) return EXPECTED_CERTIFICATE_NAME;
  return value.replace(/^Developer ID Application:\s*/, "");
}

const electronBuilderIdentity = normalizeElectronBuilderIdentity(process.env.CSC_NAME);
if (electronBuilderIdentity !== EXPECTED_CERTIFICATE_NAME) {
  fail(`Unexpected Developer ID signing identity: ${electronBuilderIdentity}`);
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed with status ${result.status}`);
}

function capture(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed with status ${result.status}`);
  return `${result.stdout}\n${result.stderr}`;
}

if (process.platform !== "darwin") fail("Local macOS release packaging must run on macOS");

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arch = normalizeArch(readArg("--arch") || process.arch);
const version = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8")).version;
const dist = path.join(desktopRoot, "dist-electron");
const prefix = `jugglework-mac-${arch}-${version}`;
const staleOutputs = [
  path.join(dist, `mac-${arch}`),
  path.join(dist, `${prefix}.zip`),
  path.join(dist, `${prefix}.zip.blockmap`),
  path.join(dist, `${prefix}.dmg`),
  path.join(dist, `${prefix}.dmg.blockmap`),
].filter(existsSync);
if (staleOutputs.length > 0) {
  fail(`Refusing to reuse existing release output; remove or archive these paths first: ${staleOutputs.join(", ")}`);
}
const environment = {
  ...process.env,
  MACOS_NOTARIZE: "true",
  APPLE_NOTARY_KEYCHAIN_PROFILE: process.env.APPLE_NOTARY_KEYCHAIN_PROFILE || DEFAULT_NOTARY_PROFILE,
  CSC_NAME: electronBuilderIdentity,
  JUGGLEWORK_COMPUTER_USE_CODESIGN_IDENTITY: process.env.JUGGLEWORK_COMPUTER_USE_CODESIGN_IDENTITY || EXPECTED_IDENTITY,
};

const identities = capture("security", ["find-identity", "-v", "-p", "codesigning"], { cwd: desktopRoot, env: environment });
if (!identities.includes(`\"${EXPECTED_IDENTITY}\"`)) {
  fail(`Expected Developer ID signing identity is unavailable: ${EXPECTED_IDENTITY}`);
}

capture("xcrun", [
  "notarytool",
  "history",
  ...(environment.APPLE_NOTARY_KEYCHAIN ? ["--keychain", environment.APPLE_NOTARY_KEYCHAIN] : []),
  "--keychain-profile",
  environment.APPLE_NOTARY_KEYCHAIN_PROFILE,
  "--output-format",
  "json",
], {
  cwd: desktopRoot,
  env: environment,
});
run("pnpm", ["run", "build:electron"], { cwd: desktopRoot, env: environment });
run("pnpm", ["exec", "electron-builder", "--config", "electron-builder.yml", "--mac", "dmg", "zip", `--${arch}`, "--publish", "never"], {
  cwd: desktopRoot,
  env: environment,
});
run("node", ["scripts/finalize-macos-artifacts.mjs", "--arch", arch], { cwd: desktopRoot, env: environment });
