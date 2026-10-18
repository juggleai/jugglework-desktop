import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const BUN_TRUSTED_RELEASE = Object.freeze({
  version: "1.3.14",
  repositoryUrl: "https://github.com/oven-sh/bun",
  releaseUrl: "https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14",
  shasumsUrl: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/SHASUMS256.txt",
  targets: Object.freeze({
    "darwin-arm64": Object.freeze({
      archiveName: "bun-darwin-aarch64.zip",
      archiveSha256: "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
      binarySha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
    }),
    "darwin-x64": Object.freeze({
      archiveName: "bun-darwin-x64.zip",
      archiveSha256: "4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633",
      binarySha256: "ea2f223e94bb2f4bf3050895113c3cf346438f6fa0501c8532284e063f72f7a0",
    }),
    "linux-arm64": Object.freeze({
      archiveName: "bun-linux-aarch64.zip",
      archiveSha256: "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
      binarySha256: "37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086",
    }),
    "linux-x64": Object.freeze({
      archiveName: "bun-linux-x64.zip",
      archiveSha256: "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
      binarySha256: "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
    }),
    "win32-arm64": Object.freeze({
      archiveName: "bun-windows-aarch64.zip",
      archiveSha256: "89841f5a57f2348b67ec0839b718f4bf4ea7d07c371c9ba4b77b6c790f918953",
      binarySha256: "c48ea01208766207606927a320d640371140dca51e9963367779b32d18460716",
    }),
    "win32-x64": Object.freeze({
      archiveName: "bun-windows-x64.zip",
      archiveSha256: "0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922",
      binarySha256: "0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c",
    }),
  }),
});

const platformAliases = new Map([
  ["darwin", "darwin"], ["mac", "darwin"], ["macos", "darwin"], ["osx", "darwin"],
  ["win", "win32"], ["win32", "win32"], ["windows", "win32"],
  ["linux", "linux"],
]);
const archAliases = new Map([
  ["arm64", "arm64"], ["aarch64", "arm64"],
  ["x64", "x64"], ["x86_64", "x64"], ["amd64", "x64"],
]);
const expectedFormats = { darwin: "mach-o", win32: "pe", linux: "elf" };

function fail(message) {
  throw new Error(`[toon-factory-bundle] ${message}`);
}

function normalize(value, aliases, label) {
  const input = String(value ?? "").trim().toLowerCase();
  const normalized = aliases.get(input);
  if (!normalized) fail(`Unsupported ${label}: ${value || "<empty>"}`);
  return normalized;
}

export function normalizeToonFactoryPlatform(value) {
  return normalize(value, platformAliases, "platform");
}

export function normalizeToonFactoryArch(value) {
  return normalize(value, archAliases, "architecture");
}

function targetTriple(value) {
  const input = String(value ?? "").trim().toLowerCase();
  if (!input) return null;
  const arch = input.startsWith("aarch64-") ? "arm64" : input.startsWith("x86_64-") ? "x64" : null;
  const platform = input.includes("apple-darwin") ? "darwin"
    : input.includes("windows") ? "win32"
      : input.includes("linux") ? "linux" : null;
  if (!arch || !platform) fail(`Unsupported TARGET triple: ${value}`);
  return { source: "TARGET", platform, arch };
}

export function resolveToonFactoryBuildTarget(environment = process.env, current = process) {
  const actual = {
    platform: normalizeToonFactoryPlatform(current.platform),
    arch: normalizeToonFactoryArch(current.arch),
  };
  const candidates = [];
  const triple = targetTriple(environment.TARGET);
  if (triple) candidates.push(triple);
  for (const name of ["npm_config_platform", "TARGET_PLATFORM"]) {
    if (String(environment[name] ?? "").trim()) candidates.push({ source: name, platform: normalizeToonFactoryPlatform(environment[name]) });
  }
  for (const name of ["npm_config_arch", "npm_config_target_arch", "TARGET_ARCH"]) {
    if (String(environment[name] ?? "").trim()) candidates.push({ source: name, arch: normalizeToonFactoryArch(environment[name]) });
  }
  for (const candidate of candidates) {
    if (candidate.platform && candidate.platform !== actual.platform) {
      fail(`${candidate.source} requests ${candidate.platform}, but the bundled Bun can only target the build host ${actual.platform}/${actual.arch}`);
    }
    if (candidate.arch && candidate.arch !== actual.arch) {
      fail(`${candidate.source} requests ${candidate.arch}, but the bundled Bun can only target the build host ${actual.platform}/${actual.arch}`);
    }
  }
  return {
    ...actual,
    executableName: actual.platform === "win32" ? "bun.exe" : "bun",
    format: expectedFormats[actual.platform],
  };
}

export function trustedBunForTarget(platformValue, archValue, release = BUN_TRUSTED_RELEASE) {
  const platform = normalizeToonFactoryPlatform(platformValue);
  const arch = normalizeToonFactoryArch(archValue);
  const target = release.targets?.[`${platform}-${arch}`];
  if (!target) fail(`No trusted Bun ${release.version || "<unknown>"} release for ${platform}/${arch}`);
  const archiveUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${release.version}/${target.archiveName}`;
  return {
    version: release.version,
    platform,
    arch,
    archiveName: target.archiveName,
    archiveUrl,
    archiveSha256: target.archiveSha256,
    binarySha256: target.binarySha256,
    provenance: {
      source: "official-github-release",
      version: release.version,
      repositoryUrl: release.repositoryUrl,
      releaseUrl: release.releaseUrl,
      shasumsUrl: release.shasumsUrl,
      archive: { name: target.archiveName, url: archiveUrl, sha256: target.archiveSha256 },
      binary: { sha256: target.binarySha256 },
    },
  };
}

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readAt(descriptor, length, position, filePath) {
  const buffer = Buffer.alloc(length);
  if (readSync(descriptor, buffer, 0, length, position) !== length) fail(`Executable header is truncated: ${filePath}`);
  return buffer;
}

export function inspectToonFactoryExecutable(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const header = readAt(descriptor, 64, 0, filePath);
    if (header.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) {
      const cpu = header.readUInt32LE(4);
      const arch = cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : null;
      if (!arch) fail(`Unsupported Mach-O CPU type 0x${cpu.toString(16)}: ${filePath}`);
      return { platform: "darwin", arch, format: "mach-o" };
    }
    if (header.toString("ascii", 0, 2) === "MZ") {
      const peOffset = header.readUInt32LE(0x3c);
      const pe = readAt(descriptor, 6, peOffset, filePath);
      if (pe.toString("binary", 0, 4) !== "PE\0\0") fail(`Invalid PE header: ${filePath}`);
      const machine = pe.readUInt16LE(4);
      const arch = machine === 0xaa64 ? "arm64" : machine === 0x8664 ? "x64" : null;
      if (!arch) fail(`Unsupported PE machine 0x${machine.toString(16)}: ${filePath}`);
      return { platform: "win32", arch, format: "pe" };
    }
    if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      const littleEndian = header[5] === 1;
      if (header[4] !== 2 || (!littleEndian && header[5] !== 2)) fail(`Unsupported ELF encoding: ${filePath}`);
      const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
      const arch = machine === 183 ? "arm64" : machine === 62 ? "x64" : null;
      if (!arch) fail(`Unsupported ELF machine ${machine}: ${filePath}`);
      return { platform: "linux", arch, format: "elf" };
    }
    fail(`Unknown executable format: ${filePath}`);
  } finally {
    closeSync(descriptor);
  }
}

function filesRecursively(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`Symbolic links are not allowed in the bundle: ${child}`);
    if (entry.isDirectory()) return filesRecursively(child);
    if (entry.isFile()) return [child];
    fail(`Special files are not allowed in the bundle: ${child}`);
  });
}

export function inventoryToonFactoryBundle(directory) {
  return filesRecursively(directory)
    .filter((filePath) => path.relative(directory, filePath) !== "build-manifest.json")
    .map((filePath) => ({
      path: path.relative(directory, filePath).split(path.sep).join("/"),
      bytes: statSync(filePath).size,
      sha256: sha256File(filePath),
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function verifyToonFactoryBundle(directory, expected, trustedRelease = BUN_TRUSTED_RELEASE) {
  const root = path.resolve(directory);
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail(`Bundle directory is missing or invalid: ${root}`);
  for (const name of ["server", "web", "tools", "nodes", "skills"]) {
    const required = path.join(root, name);
    if (!existsSync(required) || !lstatSync(required).isDirectory() || lstatSync(required).isSymbolicLink()) fail(`Required directory is missing or invalid: ${required}`);
  }
  const serverEntry = path.join(root, "server", "jugglework.js");
  if (!existsSync(serverEntry) || !statSync(serverEntry).isFile()) fail(`Managed server entry is missing: ${serverEntry}`);
  const manifestPath = path.join(root, "build-manifest.json");
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()) fail(`Build manifest is missing or invalid: ${manifestPath}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (error) { fail(`Build manifest is invalid JSON: ${error.message}`); }
  if (manifest?.schemaVersion !== 3) fail(`Build manifest schemaVersion must be 3, found ${manifest?.schemaVersion ?? "<missing>"}`);

  const platform = normalizeToonFactoryPlatform(expected.platform);
  const arch = normalizeToonFactoryArch(expected.arch);
  const executableName = platform === "win32" ? "bun.exe" : "bun";
  const expectedTarget = { platform, arch, executableName, format: expectedFormats[platform] };
  const trusted = trustedBunForTarget(platform, arch, trustedRelease);
  for (const [field, value] of Object.entries(expectedTarget)) {
    if (manifest.target?.[field] !== value) fail(`Manifest target.${field} must be ${value}, found ${manifest.target?.[field] ?? "<missing>"}`);
  }
  if (manifest.bun?.version !== trusted.version || manifest.bun?.platform !== platform || manifest.bun?.arch !== arch || manifest.bun?.executableName !== executableName || manifest.bun?.format !== expectedTarget.format) {
    fail("Manifest Bun release or target does not match the trusted package target");
  }
  if (manifest.bun.sha256 !== trusted.binarySha256) fail(`Manifest Bun SHA-256 is not trusted for Bun ${trusted.version} ${platform}/${arch}`);
  if (JSON.stringify(manifest.bun.provenance) !== JSON.stringify(trusted.provenance)) fail("Manifest Bun provenance does not match the trusted official release");

  const executablePath = path.join(root, executableName);
  if (!existsSync(executablePath) || lstatSync(executablePath).isSymbolicLink() || !statSync(executablePath).isFile()) fail(`Bundled Bun executable is missing or invalid: ${executablePath}`);
  const executable = inspectToonFactoryExecutable(executablePath);
  if (executable.platform !== platform || executable.arch !== arch || executable.format !== expectedTarget.format) {
    fail(`Bundled Bun is ${executable.platform}/${executable.arch}/${executable.format}, expected ${platform}/${arch}/${expectedTarget.format}`);
  }
  const bunSha256 = sha256File(executablePath);
  if (bunSha256 !== trusted.binarySha256) fail(`Bundled Bun SHA-256 is not trusted for Bun ${trusted.version} ${platform}/${arch}: found ${bunSha256}`);
  if (manifest.bun.bytes !== statSync(executablePath).size) fail("Bundled Bun byte size does not match the manifest");
  if (platform !== "win32" && (statSync(executablePath).mode & 0o111) === 0) fail(`Bundled Bun is not executable: ${executablePath}`);

  const files = inventoryToonFactoryBundle(root);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) fail("Bundle file inventory does not match build-manifest.json");
  const inventorySha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  if (inventorySha256 !== manifest.inventorySha256) fail(`Bundle inventory SHA-256 mismatch: expected ${manifest.inventorySha256}, found ${inventorySha256}`);
  return { root, manifestPath, manifest, executablePath, executable, bunSha256, inventorySha256, fileCount: files.length, trustedBun: trusted };
}
