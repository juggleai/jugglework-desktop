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
  ["exe", 0],
  ["exe.blockmap", 1],
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
  if (type === "exe") return ".exe";
  if (type === "exe.blockmap") return ".exe.blockmap";
  throw new Error(`Unsupported artifact type: ${type}`);
}

function artifactTypes(platform) {
  return platform === "mac" ? ["zip", "dmg", "zip.blockmap", "dmg.blockmap"] : ["exe", "exe.blockmap"];
}

function expectedName(version, arch, type, platform) {
  return `jugglework-${platform === "mac" ? "mac" : "win"}-${arch}-${version}${extensionForType(type)}`;
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

export function normalizeArtifacts({ version, platform = "mac", artifacts }) {
  assertSemverVersion(version);
  assertPlatform(platform);
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error("No release artifacts supplied");

  const seen = new Set();
  const normalized = artifacts.map((artifact) => {
    const arch = assertArchitecture(artifact.arch, platform);
    const type = artifact.type;
    if (!artifactTypes(platform).includes(type)) throw new Error(`Unsupported artifact type for ${platform}: ${type}`);
    const localPath = path.resolve(artifact.path);
    const name = path.basename(localPath);
    const requiredName = expectedName(version, arch, type, platform);
    if (name !== requiredName) {
      throw new Error(`Wrong architecture or version in artifact name: expected ${requiredName}, received ${name}`);
    }
    const identity = `${arch}:${type}`;
    if (seen.has(identity)) throw new Error(`Duplicate artifact: ${identity}`);
    seen.add(identity);
    validateMetadata(artifact, name);
    const key = artifact.key ?? artifactKey(version, arch, name, platform);
    const expectedKey = artifactKey(version, arch, name, platform);
    if (key !== expectedKey) throw new Error(`Mutable or invalid artifact key: ${key}`);
    const url = artifact.url ?? publicUrl(key);
    if (url !== publicUrl(expectedKey)) throw new Error(`Wrong CDN origin or mutable artifact URL: ${url}`);
    return { ...artifact, path: localPath, name, arch, type, key, url };
  });

  const architectures = [...new Set(normalized.map((artifact) => artifact.arch))];
  for (const arch of architectures) {
    for (const type of artifactTypes(platform)) {
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
  const platform = input.platform ?? "mac";
  if (assertPlatform(platform) !== "mac") throw new Error(`macOS manifest requires mac platform, received ${platform}`);
  const artifacts = normalizeArtifacts({ ...input, platform });
  const primaryArch = input.primaryArch ?? artifacts.find((artifact) => artifact.type === "zip")?.arch;
  assertArchitecture(primaryArch, "mac");
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
  if (assertPlatform(platform) !== "mac") throw new Error(`macOS manifest requires mac platform, received ${platform}`);
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

export function serializeWindowsManifest(manifest) {
  const lines = [
    `version: ${yamlString(manifest.version)}`,
    "files:",
  ];
  for (const file of manifest.files) {
    lines.push(`  - url: ${yamlString(file.url)}`);
    lines.push(`    sha512: ${yamlString(file.sha512)}`);
    lines.push(`    size: ${file.size}`);
  }
  if (manifest.releaseDate) lines.push(`releaseDate: ${yamlString(manifest.releaseDate)}`);
  return `${lines.join("\n")}\n`;
}

function validateImmutableManifestUrl(url, expectedFiles) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid manifest URL: ${url}`);
  }
  if (parsed.origin !== CDN_ORIGIN || parsed.protocol !== "https:") throw new Error(`Wrong CDN origin: ${url}`);
  if (parsed.search || parsed.hash || /\/(stable|alpha)\//.test(parsed.pathname)) {
    throw new Error(`Mutable manifest path: ${url}`);
  }
  return expectedFiles.find((item) => item.url === url);
}

function validateStagingManifests(version, artifacts, stagingManifests) {
  if (!Array.isArray(stagingManifests)) throw new Error("Windows staging manifests are required");
  const sources = new Map();
  for (const source of stagingManifests) {
    const arch = assertArchitecture(source?.arch, "windows");
    if (sources.has(arch)) throw new Error(`Duplicate Windows staging manifest for ${arch}`);
    sources.set(arch, source.manifest);
  }
  const architectures = [...new Set(artifacts.map((artifact) => artifact.arch))];
  if (sources.size !== architectures.length) throw new Error("Windows staging manifest inventory is incomplete");
  for (const arch of architectures) {
    const source = sources.get(arch);
    const exe = artifacts.find((artifact) => artifact.arch === arch && artifact.type === "exe");
    if (!source || source.version !== version) {
      throw new Error(`Windows staging manifest version mismatch for ${arch}: expected ${version}, received ${source?.version ?? "<missing>"}`);
    }
    if (!Array.isArray(source.files) || source.files.length !== 1) {
      throw new Error(`Windows staging manifest must contain exactly one EXE for ${arch}`);
    }
    const file = source.files[0];
    if (file?.url !== exe.name || source.path !== exe.name) {
      throw new Error(`Windows staging manifest references the wrong architecture or EXE for ${arch}`);
    }
    validateMetadata(file, `${arch} staging EXE`);
    if (file.size !== exe.size || file.sha512 !== exe.sha512 || source.sha512 !== exe.sha512) {
      throw new Error(`Windows staging manifest size or SHA-512 mismatch for ${exe.name}`);
    }
    if (!artifacts.some((artifact) => artifact.arch === arch && artifact.type === "exe.blockmap")) {
      throw new Error(`Missing exe.blockmap artifact for ${arch}`);
    }
  }
}

export function validateWindowsManifest({ version, platform = "windows", manifest, artifacts }) {
  assertSemverVersion(version);
  if (assertPlatform(platform) !== "windows") throw new Error(`Windows manifest requires windows platform, received ${platform}`);
  if (!manifest || manifest.version !== version) {
    throw new Error(`Manifest version mismatch: expected ${version}, received ${manifest?.version ?? "<missing>"}`);
  }
  const normalized = normalizeArtifacts({ version, platform, artifacts });
  const expectedFiles = normalized.filter((artifact) => artifact.type === "exe");
  const architectures = [...new Set(expectedFiles.map((artifact) => artifact.arch))];
  if (JSON.stringify(architectures) !== JSON.stringify(["arm64", "x64"])) {
    throw new Error("Windows manifest requires exactly arm64 and x64 EXEs");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== expectedFiles.length) {
    throw new Error("Manifest file inventory is incomplete");
  }
  const seenUrls = new Set();
  for (const file of manifest.files) {
    if (seenUrls.has(file.url)) throw new Error(`Duplicate manifest file: ${file.url}`);
    seenUrls.add(file.url);
    const expected = validateImmutableManifestUrl(file.url, expectedFiles);
    if (!expected) throw new Error(`Unexpected or wrong-architecture manifest file: ${file.url}`);
    validateMetadata(file, file.url);
    if (file.size !== expected.size || file.sha512 !== expected.sha512) {
      throw new Error(`Manifest size or SHA-512 mismatch for ${file.url}`);
    }
  }
  for (const expected of expectedFiles) {
    if (!seenUrls.has(expected.url)) throw new Error(`Missing manifest file: ${expected.url}`);
  }
  if (Object.hasOwn(manifest, "path") || Object.hasOwn(manifest, "sha512")) {
    throw new Error("Merged Windows manifests must not use top-level path/sha512 for architecture selection");
  }
  return manifest;
}

export function normalizeWindowsManifest(input) {
  const platform = input.platform ?? "windows";
  if (assertPlatform(platform) !== "windows") throw new Error(`Windows manifest requires windows platform, received ${platform}`);
  const artifacts = normalizeArtifacts({ ...input, platform });
  validateStagingManifests(input.version, artifacts, input.stagingManifests);
  const executables = artifacts.filter((artifact) => artifact.type === "exe");
  const manifest = {
    version: input.version,
    files: executables.map(({ url, sha512, size }) => ({ url, sha512, size })),
    ...(input.releaseDate ? { releaseDate: new Date(input.releaseDate).toISOString() } : {}),
  };
  validateWindowsManifest({ version: input.version, platform, manifest, artifacts });
  return { manifest, yaml: serializeWindowsManifest(manifest), artifacts };
}
