#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const YAML = desktopRequire("yaml");

function walk(dir) {
  const entries = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) entries.push(...walk(path));
    else if (stat.isFile()) entries.push(path);
  }
  return entries;
}

function findOne(paths, description) {
  if (paths.length !== 1) {
    const matches = paths.map((path) => `- ${path}`).join("\n");
    throw new Error(`Expected exactly one ${description}, found ${paths.length}.${matches ? `\n${matches}` : ""}`);
  }
  return paths[0];
}

function sha512(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function loadBuildBlockMap() {
  const electronBuilderEntry = desktopRequire.resolve("electron-builder");
  const electronBuilderRequire = createRequire(electronBuilderEntry);
  return electronBuilderRequire("app-builder-lib/out/targets/blockmap/blockmap.js").buildBlockMap;
}

async function regenerateBlockmap(installerPath, buildBlockMap) {
  const blockmapPath = `${installerPath}.blockmap`;
  mkdirSync(dirname(blockmapPath), { recursive: true });
  rmSync(blockmapPath, { force: true });
  await buildBlockMap(installerPath, "gzip", blockmapPath);
  if (!existsSync(blockmapPath)) {
    throw new Error(`electron-builder did not create ${blockmapPath}`);
  }
}

function updateLatestYml(installerPath, distDir) {
  const latestPath = join(distDir, "latest.yml");
  if (!existsSync(latestPath)) {
    throw new Error(`Missing Windows updater manifest: ${latestPath}`);
  }

  const installerName = basename(installerPath);
  const installerSha512 = sha512(installerPath);
  const installerSize = statSync(installerPath).size;
  const manifest = YAML.parse(readFileSync(latestPath, "utf8"));

  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error(`Invalid Windows updater manifest: ${latestPath}`);
  }

  let matchedFile = false;
  manifest.files = manifest.files.map((file) => {
    if (!file || file.url !== installerName) return file;
    matchedFile = true;
    return {
      ...file,
      sha512: installerSha512,
      size: installerSize,
    };
  });

  if (!matchedFile) {
    throw new Error(`Manifest ${latestPath} does not reference signed installer ${installerName}`);
  }

  manifest.path = installerName;
  manifest.sha512 = installerSha512;
  writeFileSync(latestPath, YAML.stringify(manifest), "utf8");
}

export async function applySignedWindowsArtifact(signedArtifactDirArg, distDirArg, dependencies = {}) {
  const signedArtifactDir = resolve(signedArtifactDirArg);
  const distDir = resolve(distDirArg);

  if (!existsSync(signedArtifactDir)) {
    throw new Error(`Signed artifact directory does not exist: ${signedArtifactDir}`);
  }
  if (!existsSync(distDir)) {
    throw new Error(`Electron dist directory does not exist: ${distDir}`);
  }
  const buildBlockMap = dependencies.buildBlockMap ?? loadBuildBlockMap();

  const signedInstaller = findOne(
    walk(signedArtifactDir).filter((file) => /^jugglework-win-(x64|arm64)-.+\.exe$/i.test(basename(file))),
    "signed Windows installer from SignPath",
  );
  const distInstaller = findOne(
    walk(distDir).filter((file) => basename(file) === basename(signedInstaller)),
    "matching unsigned Windows installer in dist-electron",
  );

  copyFileSync(signedInstaller, distInstaller);
  await regenerateBlockmap(distInstaller, buildBlockMap);
  updateLatestYml(distInstaller, distDir);
  return distInstaller;
}

async function main() {
  const [signedArtifactDirArg, distDirArg] = process.argv.slice(2);
  if (!signedArtifactDirArg || !distDirArg) {
    console.error("Usage: node scripts/release/apply-signpath-windows-artifact.mjs <signed-artifact-dir> <dist-dir>");
    process.exitCode = 2;
    return;
  }

  try {
    const distInstaller = await applySignedWindowsArtifact(signedArtifactDirArg, distDirArg);
    console.log(`Applied signed Windows installer: ${distInstaller}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
