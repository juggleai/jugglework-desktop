import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { inspectArtifact } from "./qiniu-release/metadata.mjs";

const require = createRequire(import.meta.url);
const { resolveNotaryArguments } = require("./macos-notary.cjs");

const EXPECTED_TEAM_ID = "H7PDHSK3C7";
const RECEIPT_SCHEMA = "com.juggleai.jugglework.macos-dmg-notarization-receipt";

function fail(message) {
  throw new Error(`[finalize-macos-artifacts] ${message}`);
}

function normalizeArch(input) {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "x64" || value === "x86_64" || value === "amd64") return "x64";
  fail(`Unsupported macOS architecture: ${input || "<empty>"}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} failed with status ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function runJson(command, args) {
  const result = run(command, args);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`${command} did not return valid JSON`);
  }
}

async function stapleWithRetry(filePath, { attempts = 5, delay = async (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("xcrun", ["stapler", "staple", filePath], { encoding: "utf8" });
    if (!result.error && result.status === 0) return;
    if (attempt === attempts) {
      const detail = result.error?.message || [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      fail(`xcrun stapler staple failed after ${attempts} attempts${detail ? `: ${detail}` : ""}`);
    }
    await delay(30_000 * attempt);
  }
}

function assertDmgSignature(dmgPath) {
  run("codesign", ["--verify", "--verbose=4", dmgPath]);
  const details = run("codesign", ["--display", "--verbose=4", dmgPath]);
  const output = `${details.stdout}\n${details.stderr}`;
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (teamIdentifier !== EXPECTED_TEAM_ID) {
    fail(`Expected DMG signing TeamIdentifier ${EXPECTED_TEAM_ID}, found ${teamIdentifier || "<missing>"}`);
  }
  if (output.includes("Signature=adhoc")) fail("DMG is ad-hoc signed");
  return { teamIdentifier };
}

function assertAppReceipt({ receiptPath, version }) {
  if (!existsSync(receiptPath)) fail(`App notarization receipt is missing: ${receiptPath}`);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    fail(`Unable to parse app notarization receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (receipt.schema !== "com.juggleai.jugglework.macos-notarization-receipt"
    || receipt.schemaVersion !== 1 || receipt.producer !== "electron-after-sign"
    || receipt.version !== version || receipt.bundleIdentifier !== "com.juggleai.jugglework"
    || receipt.status !== "accepted" || receipt.staple !== "validated"
    || typeof receipt.submissionId !== "string" || !receipt.submissionId) {
    fail("App notarization receipt is missing required accepted/stapled release fields");
  }
  return receipt;
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

export function createStagingManifest({ version, zipName, zipMetadata, dmgName, dmgMetadata, releaseDate }) {
  if (!version || !zipName || !dmgName) fail("Version, ZIP name, and DMG name are required");
  const lines = [
    `version: ${quoteYaml(version)}`,
    "files:",
    `  - url: ${quoteYaml(zipName)}`,
    `    sha512: ${quoteYaml(zipMetadata.sha512)}`,
    `    size: ${zipMetadata.size}`,
    `  - url: ${quoteYaml(dmgName)}`,
    `    sha512: ${quoteYaml(dmgMetadata.sha512)}`,
    `    size: ${dmgMetadata.size}`,
    `path: ${quoteYaml(zipName)}`,
    `sha512: ${quoteYaml(zipMetadata.sha512)}`,
  ];
  if (releaseDate) lines.push(`releaseDate: ${quoteYaml(new Date(releaseDate).toISOString())}`);
  return `${lines.join("\n")}\n`;
}

function loadBlockmapBuilder() {
  const electronBuilderEntry = require.resolve("electron-builder");
  const electronBuilderRequire = createRequire(electronBuilderEntry);
  return electronBuilderRequire("app-builder-lib/out/targets/blockmap/blockmap.js").buildBlockMap;
}

function readReleaseDate(manifestPath) {
  if (!existsSync(manifestPath)) return new Date().toISOString();
  const value = parseYaml(readFileSync(manifestPath, "utf8"));
  return value?.releaseDate || new Date().toISOString();
}

export async function finalizeMacosArtifacts({
  version,
  arch,
  dist,
  environment = process.env,
  buildBlockMap = loadBlockmapBuilder(),
}) {
  if (process.platform !== "darwin") fail("macOS artifact finalization must run on macOS");
  const normalizedArch = normalizeArch(arch);
  const resolvedDist = path.resolve(dist);
  const prefix = `jugglework-mac-${normalizedArch}-${version}`;
  const dmgPath = path.join(resolvedDist, `${prefix}.dmg`);
  const zipPath = path.join(resolvedDist, `${prefix}.zip`);
  const dmgBlockmapPath = `${dmgPath}.blockmap`;
  const manifestPath = path.join(resolvedDist, "latest-mac.yml");
  const receiptDirectory = path.join(resolvedDist, `mac-${normalizedArch}`);
  const appReceiptPath = path.join(receiptDirectory, "jugglework-notarization-receipt.json");
  const receiptPath = path.join(receiptDirectory, "jugglework-dmg-notarization-receipt.json");
  for (const filePath of [dmgPath, zipPath, `${zipPath}.blockmap`, dmgBlockmapPath]) {
    if (!existsSync(filePath)) fail(`Required artifact is missing: ${filePath}`);
  }
  if (existsSync(receiptPath)) fail(`DMG notarization receipt already exists: ${receiptPath}`);

  assertAppReceipt({ receiptPath: appReceiptPath, version });
  run("hdiutil", ["verify", dmgPath]);
  const signature = assertDmgSignature(dmgPath);
  const notaryArguments = resolveNotaryArguments(environment);
  const submission = runJson("xcrun", [
    "notarytool",
    "submit",
    dmgPath,
    ...notaryArguments,
    "--wait",
    "--output-format",
    "json",
  ]);
  if (submission.status !== "Accepted" || typeof submission.id !== "string" || !submission.id) {
    fail("Apple DMG notarization submission was not accepted");
  }

  await stapleWithRetry(dmgPath);
  run("xcrun", ["stapler", "validate", dmgPath]);
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmgPath]);
  run("hdiutil", ["verify", dmgPath]);
  assertDmgSignature(dmgPath);

  const temporaryBlockmap = `${dmgBlockmapPath}.tmp-${process.pid}`;
  const temporaryManifest = `${manifestPath}.tmp-${process.pid}`;
  try {
    await buildBlockMap(dmgPath, "gzip", temporaryBlockmap);
    if (!existsSync(temporaryBlockmap)) fail("DMG blockmap regeneration did not produce an output file");
    const [zipMetadata, dmgMetadata] = await Promise.all([inspectArtifact(zipPath), inspectArtifact(dmgPath)]);
    const manifest = createStagingManifest({
      version,
      zipName: path.basename(zipPath),
      zipMetadata,
      dmgName: path.basename(dmgPath),
      dmgMetadata,
      releaseDate: readReleaseDate(manifestPath),
    });
    writeFileSync(temporaryManifest, manifest, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryBlockmap, dmgBlockmapPath);
    renameSync(temporaryManifest, manifestPath);

    const receipt = {
      schema: RECEIPT_SCHEMA,
      schemaVersion: 1,
      producer: "finalize-macos-artifacts",
      version,
      architecture: normalizedArch,
      artifactName: path.basename(dmgPath),
      teamIdentifier: signature.teamIdentifier,
      submissionId: submission.id,
      status: "accepted",
      staple: "validated",
      gatekeeper: "accepted",
      createdAt: new Date().toISOString(),
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { dmgPath, dmgBlockmapPath, manifestPath, receiptPath, receipt };
  } finally {
    rmSync(temporaryBlockmap, { force: true });
    rmSync(temporaryManifest, { force: true });
  }
}

function readArg(name) {
  const inline = process.argv.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : "";
}

async function main() {
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
  const result = await finalizeMacosArtifacts({
    version: readArg("--version") || packageJson.version,
    arch: readArg("--arch") || process.arch,
    dist: readArg("--dist") || path.join(desktopRoot, "dist-electron"),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
