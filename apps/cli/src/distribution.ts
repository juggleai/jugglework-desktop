import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import descriptorJson from "../distribution/opencode-v1.18.15.json" with { type: "json" };

export const DISTRIBUTION_MANIFEST = "manifest.json";
export const OPENCODE_VERSION = "1.18.15";
export const REQUIRED_PLUGIN_FILES = [
  "jugglework-extensions-preview.js",
  "jugglework-capabilities-knowledge.js",
  "jugglework-office-attachments.js",
  "jugglework-anthropic-adaptive-thinking.js",
  "jugglework-anthropic-tool-schema.js",
  "jugglework-safe-grep.js",
  "jugglework-context-overflow.js",
  "jugglework-mcp-workspace-policy.js",
] as const;

export const DISTRIBUTION_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64",
  "bun-windows-arm64",
  "bun-windows-x64",
] as const;

export type DistributionTarget = typeof DISTRIBUTION_TARGETS[number];
export type IntegrityFile = { path: string; sha256: string };
export type DistributionManifest = {
  schemaVersion: 1;
  target: DistributionTarget;
  cli: { version: string; file: IntegrityFile };
  server: { version: string };
  opencode: { version: string; source: string; file: IntegrityFile };
  plugins: { directory: string; files: IntegrityFile[] };
  notices: IntegrityFile[];
};

type OpenCodeDescriptor = {
  name: string;
  version: string;
  repository: string;
  release: string;
  sourceCommit: string;
  license: string;
  targets: Record<DistributionTarget, {
    archive: string;
    format: "zip" | "tar.gz";
    sha256: string;
    executable: "opencode" | "opencode.exe";
  }>;
};

export const OPENCODE_DISTRIBUTION = descriptorJson as OpenCodeDescriptor;

export function isDistributionTarget(value: string): value is DistributionTarget {
  return (DISTRIBUTION_TARGETS as readonly string[]).includes(value);
}

export function hostDistributionTarget(platform = process.platform, arch = process.arch): DistributionTarget | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  return os && cpu ? `bun-${os}-${cpu}` as DistributionTarget : null;
}

export function sha256FileSync(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function integrityFile(root: string, path: string): IntegrityFile {
  return { path: relative(root, path).replaceAll("\\", "/"), sha256: sha256FileSync(path) };
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function parseIntegrityFile(value: unknown, label: string): IntegrityFile {
  assertObject(value, label);
  if (typeof value.path !== "string" || !/^[a-f0-9]{64}$/.test(String(value.sha256))) {
    throw new Error(`${label} must contain a relative path and SHA-256 digest`);
  }
  return { path: value.path, sha256: String(value.sha256) };
}

export function parseDistributionManifest(value: unknown): DistributionManifest {
  assertObject(value, "distribution manifest");
  if (value.schemaVersion !== 1 || typeof value.target !== "string" || !isDistributionTarget(value.target)) {
    throw new Error("distribution manifest has an unsupported schema or target");
  }
  assertObject(value.cli, "manifest cli");
  assertObject(value.server, "manifest server");
  assertObject(value.opencode, "manifest opencode");
  assertObject(value.plugins, "manifest plugins");
  if (typeof value.cli.version !== "string" || typeof value.server.version !== "string" ||
      value.opencode.version !== OPENCODE_VERSION || value.opencode.source !== OPENCODE_DISTRIBUTION.release ||
      typeof value.plugins.directory !== "string" || !Array.isArray(value.plugins.files) || !Array.isArray(value.notices)) {
    throw new Error("distribution manifest contains incompatible component metadata");
  }
  const pluginDirectory = value.plugins.directory;
  const plugins = value.plugins.files.map((file, index) => parseIntegrityFile(file, `manifest plugin ${index}`));
  if (plugins.length !== REQUIRED_PLUGIN_FILES.length ||
      !REQUIRED_PLUGIN_FILES.every((name) => plugins.some((file) => file.path === `${pluginDirectory}/${name}`))) {
    throw new Error("distribution manifest does not declare the required plugin set");
  }
  return {
    schemaVersion: 1,
    target: value.target,
    cli: { version: value.cli.version, file: parseIntegrityFile(value.cli.file, "manifest CLI file") },
    server: { version: value.server.version },
    opencode: {
      version: value.opencode.version,
      source: value.opencode.source,
      file: parseIntegrityFile(value.opencode.file, "manifest OpenCode file"),
    },
    plugins: { directory: pluginDirectory, files: plugins },
    notices: value.notices.map((file, index) => parseIntegrityFile(file, `manifest notice ${index}`)),
  };
}

export function resolveManifestPath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) throw new Error(`manifest path must be relative: ${relativePath}`);
  const target = resolve(root, relativePath);
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`manifest path escapes distribution: ${relativePath}`);
  return target;
}

export async function verifyManifestFile(root: string, file: IntegrityFile, executable = false): Promise<string> {
  const path = resolveManifestPath(root, file.path);
  await access(path, executable && process.platform !== "win32" ? constants.X_OK : constants.R_OK);
  if (!(await stat(path)).isFile()) throw new Error(`manifest asset is not a file: ${file.path}`);
  if (await sha256File(path) !== file.sha256) throw new Error(`checksum mismatch for ${file.path}`);
  return path;
}

export async function verifyDistribution(root: string, expectedTarget?: DistributionTarget): Promise<DistributionManifest> {
  const manifest = parseDistributionManifest(JSON.parse(await readFile(resolve(root, DISTRIBUTION_MANIFEST), "utf8")));
  if (expectedTarget && manifest.target !== expectedTarget) {
    throw new Error(`distribution target ${manifest.target} does not match expected target ${expectedTarget}`);
  }
  await verifyManifestFile(root, manifest.cli.file, true);
  await verifyManifestFile(root, manifest.opencode.file, true);
  for (const file of [...manifest.plugins.files, ...manifest.notices]) await verifyManifestFile(root, file);
  return manifest;
}

export function assertDescriptor(): void {
  if (OPENCODE_DISTRIBUTION.version !== OPENCODE_VERSION || OPENCODE_DISTRIBUTION.license !== "MIT") {
    throw new Error("OpenCode distribution descriptor version or license is invalid");
  }
  for (const target of DISTRIBUTION_TARGETS) {
    const asset = OPENCODE_DISTRIBUTION.targets[target];
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`OpenCode descriptor is incomplete for ${target}`);
  }
}

export function readManifestSync(path: string): DistributionManifest {
  return parseDistributionManifest(JSON.parse(readFileSync(path, "utf8")));
}
