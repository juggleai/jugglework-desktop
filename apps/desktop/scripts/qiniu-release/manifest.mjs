import path from "node:path";

import {
  CDN_ORIGIN,
  artifactKey,
  assertArchitecture,
  assertPlatform,
  assertSemverVersion,
  publicUrl,
} from "./constants.mjs";
import { isCanonicalSha512 } from "./metadata.mjs";

const TYPE_ORDER = new Map([
  ["zip", 0],
  ["dmg", 1],
  ["zip.blockmap", 2],
  ["dmg.blockmap", 3],
]);
const ARCH_ORDER = new Map([
  ["universal", 0],
  ["arm64", 1],
  ["x64", 2],
]);

function extensionForType(type) {
  if (type === "zip") return ".zip";
  if (type === "dmg") return ".dmg";
  if (type === "zip.blockmap") return ".zip.blockmap";
  if (type === "dmg.blockmap") return ".dmg.blockmap";
  throw new Error(`Unsupported artifact type: ${type}`);
}

function expectedName(version, arch, type) {
  return `jugglework-mac-${arch}-${version}${extensionForType(type)}`;
}

function validateMetadata(metadata, label) {
  if (!Number.isSafeInteger(metadata?.size) || metadata.size <= 0) {
    throw new Error(`Invalid size for ${label}`);
  }
  if (!isCanonicalSha512(metadata.sha512)) throw new Error(`Invalid SHA-512 for ${label}`);
  if (metadata.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    throw new Error(`Invalid SHA-256 for ${label}`);
  }
  if (metadata.etag !== undefined && !/^[A-Za-z0-9_-]{28}$/.test(metadata.etag)) {
    throw new Error(`Invalid Qiniu ETag for ${label}`);
  }
}

export function normalizeArtifacts({ version, platform, artifacts }) {
  assertSemverVersion(version);
  assertPlatform(platform);
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error("No release artifacts supplied");

  const seen = new Set();
  const normalized = artifacts.map((artifact) => {
    const arch = assertArchitecture(artifact.arch);
    const type = artifact.type;
    extensionForType(type);
    const localPath = path.resolve(artifact.path);
    const name = path.basename(localPath);
    const requiredName = expectedName(version, arch, type);
    if (name !== requiredName) {
      throw new Error(`Wrong architecture or version in artifact name: expected ${requiredName}, received ${name}`);
    }
    const identity = `${arch}:${type}`;
    if (seen.has(identity)) throw new Error(`Duplicate artifact: ${identity}`);
    seen.add(identity);
    validateMetadata(artifact, name);
    const key = artifact.key ?? artifactKey(version, arch, name);
    const expectedKey = artifactKey(version, arch, name);
    if (key !== expectedKey) throw new Error(`Mutable or invalid artifact key: ${key}`);
    const url = artifact.url ?? publicUrl(key);
    if (url !== publicUrl(expectedKey)) throw new Error(`Wrong CDN origin or mutable artifact URL: ${url}`);
    return { ...artifact, path: localPath, name, arch, type, key, url };
  });

  const architectures = [...new Set(normalized.map((artifact) => artifact.arch))];
  for (const arch of architectures) {
    for (const type of TYPE_ORDER.keys()) {
      if (!seen.has(`${arch}:${type}`)) throw new Error(`Missing ${type} artifact for ${arch}`);
    }
  }
  return normalized.sort((a, b) => ARCH_ORDER.get(a.arch) - ARCH_ORDER.get(b.arch) || TYPE_ORDER.get(a.type) - TYPE_ORDER.get(b.type));
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function serializeMacManifest(manifest) {
  const lines = [
    `version: ${yamlString(manifest.version)}`,
    "files:",
  ];
  for (const file of manifest.files) {
    lines.push(`  - url: ${yamlString(file.url)}`);
    lines.push(`    sha512: ${yamlString(file.sha512)}`);
    lines.push(`    size: ${file.size}`);
  }
  lines.push(`path: ${yamlString(manifest.path)}`);
  lines.push(`sha512: ${yamlString(manifest.sha512)}`);
  if (manifest.releaseDate) lines.push(`releaseDate: ${yamlString(manifest.releaseDate)}`);
  return `${lines.join("\n")}\n`;
}

export function normalizeMacManifest(input) {
  const artifacts = normalizeArtifacts(input);
  const primaryArch = input.primaryArch ?? artifacts.find((artifact) => artifact.type === "zip")?.arch;
  assertArchitecture(primaryArch);
  const primary = artifacts.find((artifact) => artifact.arch === primaryArch && artifact.type === "zip");
  if (!primary) throw new Error(`No compatible ZIP for primary architecture ${primaryArch}`);
  const files = artifacts
    .filter((artifact) => artifact.type === "zip" || artifact.type === "dmg")
    .map(({ url, sha512, size }) => ({ url, sha512, size }));
  const manifest = {
    version: input.version,
    files,
    path: primary.url,
    sha512: primary.sha512,
    ...(input.releaseDate ? { releaseDate: new Date(input.releaseDate).toISOString() } : {}),
  };
  validateMacManifest({ ...input, manifest, artifacts });
  return { manifest, yaml: serializeMacManifest(manifest), artifacts };
}

export function validateMacManifest({ version, platform, manifest, artifacts, primaryArch }) {
  assertSemverVersion(version);
  assertPlatform(platform);
  if (!manifest || manifest.version !== version) {
    throw new Error(`Manifest version mismatch: expected ${version}, received ${manifest?.version ?? "<missing>"}`);
  }
  const normalized = normalizeArtifacts({ version, platform, artifacts });
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Manifest files are missing");
  const expectedFiles = normalized.filter((item) => item.type === "zip" || item.type === "dmg");
  if (manifest.files.length !== expectedFiles.length) throw new Error("Manifest file inventory is incomplete");
  const seenUrls = new Set();
  for (const file of manifest.files) {
    if (seenUrls.has(file.url)) throw new Error(`Duplicate manifest file: ${file.url}`);
    seenUrls.add(file.url);
    let parsed;
    try {
      parsed = new URL(file.url);
    } catch {
      throw new Error(`Invalid manifest URL: ${file.url}`);
    }
    if (parsed.origin !== CDN_ORIGIN || parsed.protocol !== "https:") throw new Error(`Wrong CDN origin: ${file.url}`);
    if (parsed.search || parsed.hash || /\/(stable|alpha)\//.test(parsed.pathname)) {
      throw new Error(`Mutable manifest path: ${file.url}`);
    }
    const expected = expectedFiles.find((item) => item.url === file.url);
    if (!expected) throw new Error(`Unexpected or wrong-architecture manifest file: ${file.url}`);
    validateMetadata(file, file.url);
    if (file.size !== expected.size || file.sha512 !== expected.sha512) {
      throw new Error(`Manifest size or SHA-512 mismatch for ${file.url}`);
    }
  }
  for (const expected of expectedFiles) {
    if (!seenUrls.has(expected.url)) throw new Error(`Missing manifest file: ${expected.url}`);
  }
  const selectedArch = primaryArch ?? normalized.find((item) => item.url === manifest.path)?.arch;
  const primary = normalized.find((item) => item.arch === selectedArch && item.type === "zip");
  if (!primary || manifest.path !== primary.url || manifest.sha512 !== primary.sha512) {
    throw new Error("Top-level path/sha512 must select a compatible ZIP");
  }
  return manifest;
}
