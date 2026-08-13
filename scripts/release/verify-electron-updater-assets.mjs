#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const targetRequirements = {
  "aarch64-apple-darwin": { manifest: "latest-mac.yml", asset: /-mac-arm64-/i, extension: ".zip" },
  "x86_64-apple-darwin": { manifest: "latest-mac.yml", asset: /-mac-x64-/i, extension: ".zip" },
  "aarch64-unknown-linux-gnu": { manifest: "latest-linux-arm64.yml", asset: /-linux-arm64-/i, extension: ".AppImage" },
  "x86_64-unknown-linux-gnu": { manifest: "latest-linux.yml", asset: /-linux-(?:x64|x86_64)-/i, extension: ".AppImage" },
  "aarch64-pc-windows-msvc": { manifest: "latest.yml", asset: /-win-arm64-/i, extension: ".exe" },
  "x86_64-pc-windows-msvc": { manifest: "latest.yml", asset: /-win-x64-/i, extension: ".exe" },
};

function unquote(value) {
  return String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

function scalar(value) {
  const parsed = unquote(value);
  return /^\d+$/.test(parsed) ? Number(parsed) : parsed;
}

export function parseUpdaterManifest(path) {
  const manifest = { files: [] };
  let current = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const topLevel = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (topLevel) {
      const [, key, value] = topLevel;
      if (key !== "files") manifest[key] = scalar(value);
      current = null;
      continue;
    }
    const fileStart = line.match(/^\s*-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (fileStart) {
      current = { [fileStart[1]]: scalar(fileStart[2]) };
      manifest.files.push(current);
      continue;
    }
    const fileProperty = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (fileProperty && current) current[fileProperty[1]] = scalar(fileProperty[2]);
  }
  return manifest;
}

function walk(input) {
  const stat = statSync(input);
  if (stat.isFile()) return [input];
  const files = [];
  for (const entry of readdirSync(input)) {
    const path = join(input, entry);
    const entryStat = statSync(path);
    if (entryStat.isDirectory()) files.push(...walk(path));
    else if (entryStat.isFile()) files.push(path);
  }
  return files;
}

function validSha512(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  return Buffer.from(value, "base64").length === 64;
}

function fileSha512(path) {
  return createHash("sha512").update(readFileSync(path)).digest("base64");
}

function releaseAssets(tag) {
  const repo = process.env.GITHUB_REPOSITORY?.trim();
  if (!repo) throw new Error("GITHUB_REPOSITORY is required with --release-tag");
  const result = spawnSync("gh", ["release", "view", tag, "--repo", repo, "--json", "assets"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Unable to list release assets for ${tag}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout).assets ?? [];
}

export function verifyUpdaterArtifacts({ input, expectedVersion, target, remoteAssets = [] }) {
  const paths = walk(resolve(input));
  const manifestPaths = paths.filter((path) => /^latest.*\.ya?ml$/i.test(basename(path)));
  if (manifestPaths.length === 0) throw new Error(`No Electron updater manifests found under ${input}`);

  const assets = new Map();
  for (const path of paths) {
    const name = basename(path);
    if (/^latest.*\.ya?ml$/i.test(name)) continue;
    const existing = assets.get(name);
    if (existing?.path && existing.path !== path) throw new Error(`Duplicate local updater asset: ${name}`);
    assets.set(name, { name, path, size: statSync(path).size });
  }
  for (const asset of remoteAssets) {
    if (!asset?.name || assets.has(asset.name)) continue;
    assets.set(asset.name, { name: asset.name, path: null, size: Number(asset.size) });
  }

  const required = target ? targetRequirements[target] : null;
  if (target && !required) throw new Error(`Unsupported Electron updater target: ${target}`);
  if (required && !manifestPaths.some((path) => basename(path) === required.manifest)) {
    throw new Error(`${target} is missing updater manifest ${required.manifest}`);
  }

  const reports = [];
  for (const manifestPath of manifestPaths) {
    const name = basename(manifestPath);
    const manifest = parseUpdaterManifest(manifestPath);
    if (!manifest.version || !Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error(`${name} must contain a version and at least one file`);
    }
    if (expectedVersion && String(manifest.version) !== expectedVersion) {
      throw new Error(`${name} version ${manifest.version} does not match ${expectedVersion}`);
    }

    let targetEntryFound = false;
    for (const file of manifest.files) {
      const url = String(file?.url ?? "");
      if (!url || basename(url) !== url) throw new Error(`${name} contains a non-relative updater asset URL: ${url || "missing"}`);
      if (!validSha512(file.sha512)) throw new Error(`${name} has an invalid SHA-512 for ${url}`);
      if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`${name} has an invalid size for ${url}`);

      const asset = assets.get(url);
      if (!asset) throw new Error(`${name} references missing updater asset ${url}`);
      if (Number.isFinite(asset.size) && asset.size !== file.size) {
        throw new Error(`${name} size ${file.size} does not match ${url} size ${asset.size}`);
      }
      if (asset.path && fileSha512(asset.path) !== file.sha512) {
        throw new Error(`${name} SHA-512 does not match ${url}`);
      }

      if (/\.(?:zip|exe)$/i.test(url) && !assets.has(`${url}.blockmap`)) {
        throw new Error(`${name} is missing updater blockmap ${url}.blockmap`);
      }
      if (/\.AppImage$/i.test(url) && (!Number.isSafeInteger(file.blockMapSize) || file.blockMapSize <= 0)) {
        throw new Error(`${name} must record a positive embedded blockMapSize for ${url}`);
      }
      if (required && name === required.manifest && required.asset.test(url) && url.toLowerCase().endsWith(required.extension.toLowerCase())) {
        targetEntryFound = true;
      }
    }

    if (manifest.path) {
      const primary = manifest.files.find((file) => file.url === manifest.path);
      if (!primary) throw new Error(`${name} top-level path does not reference a file entry`);
      if (manifest.sha512 && manifest.sha512 !== primary.sha512) throw new Error(`${name} top-level SHA-512 does not match ${manifest.path}`);
    }
    if (required && name === required.manifest && !targetEntryFound) {
      throw new Error(`${name} does not contain the ${target} updater artifact`);
    }
    reports.push({ manifest: name, version: String(manifest.version), files: manifest.files.length });
  }
  return reports;
}

function parseArgs(args) {
  const options = { input: null, expectedVersion: null, target: null, releaseTag: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--expected-version") options.expectedVersion = args[++index] ?? null;
    else if (arg === "--target") options.target = args[++index] ?? null;
    else if (arg === "--release-tag") options.releaseTag = args[++index] ?? null;
    else if (!options.input) options.input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.input) throw new Error("Usage: verify-electron-updater-assets.mjs <dist-or-manifest> [--expected-version <version>] [--target <triple>] [--release-tag <tag>]");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const expectedVersion = options.expectedVersion ?? options.releaseTag?.replace(/^v/, "") ?? null;
    const reports = verifyUpdaterArtifacts({
      input: options.input,
      expectedVersion,
      target: options.target,
      remoteAssets: options.releaseTag ? releaseAssets(options.releaseTag) : [],
    });
    process.stdout.write(`${JSON.stringify({ ok: true, manifests: reports })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
