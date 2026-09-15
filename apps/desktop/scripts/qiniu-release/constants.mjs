export const CDN_ORIGIN = "https://downloads.jugglechat.cn";
export const RELEASE_ROOT = "jugglework/releases";
export const DEFAULT_BUCKET = "juggleim";
export const SUPPORTED_ARCHITECTURES = ["arm64", "x64", "universal"];
export const SUPPORTED_PLATFORMS = ["mac", "windows"];
export const SUPPORTED_CHANNELS = ["stable", "alpha"];
export const WINDOWS_ARCHITECTURES = ["arm64", "x64"];
export const WINDOWS_VERSION_FLOOR = "1.2.17";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRERELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)$/;

export function assertStableVersion(version) {
  if (!STABLE_VERSION.test(String(version ?? ""))) {
    throw new Error(`Invalid stable version: ${version || "<empty>"}`);
  }
  return version;
}

export function assertSemverVersion(version) {
  if (!STABLE_VERSION.test(String(version ?? "")) && !PRERELEASE_VERSION.test(String(version ?? ""))) {
    throw new Error(`Invalid release version: ${version || "<empty>"}`);
  }
  return version;
}

export function assertReleaseVersion(version, channel) {
  assertChannel(channel);
  if (channel === "stable") return assertStableVersion(version);
  return assertSemverVersion(version);
}

function semverParts(version) {
  assertSemverVersion(version);
  const separator = version.indexOf("-");
  const core = separator === -1 ? version : version.slice(0, separator);
  const prerelease = separator === -1 ? "" : version.slice(separator + 1);
  return { core: core.split(".").map(Number), prerelease: prerelease ? prerelease.split(".") : [] };
}

export function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumber = /^\d+$/.test(a.prerelease[index]);
    const bNumber = /^\d+$/.test(b.prerelease[index]);
    if (aNumber && bNumber) return Number(a.prerelease[index]) < Number(b.prerelease[index]) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.prerelease[index] < b.prerelease[index] ? -1 : 1;
  }
  return 0;
}

export function assertPlatform(platform = "mac") {
  if (!SUPPORTED_PLATFORMS.includes(platform)) throw new Error(`Unsupported release platform: ${platform || "<empty>"}`);
  return platform;
}

export function normalizeReleaseArchitectures(architectures, platform = "mac") {
  assertPlatform(platform);
  if (!Array.isArray(architectures) || architectures.length === 0) throw new Error("At least one architecture is required");
  if (new Set(architectures).size !== architectures.length) throw new Error("Duplicate architectures are not allowed");
  architectures.forEach((arch) => assertArchitecture(arch, platform));
  if (platform === "windows") {
    if (architectures.length !== WINDOWS_ARCHITECTURES.length || WINDOWS_ARCHITECTURES.some((arch) => !architectures.includes(arch))) {
      throw new Error("Windows releases require exactly arm64 and x64 architectures");
    }
    return [...WINDOWS_ARCHITECTURES];
  }
  if (architectures.includes("universal") && architectures.length !== 1) {
    throw new Error("Universal architecture cannot be combined with architecture-specific artifacts");
  }
  return [...architectures];
}

export function assertWindowsReleaseVersion(version) {
  assertSemverVersion(version);
  if (compareSemver(version, WINDOWS_VERSION_FLOOR) <= 0) {
    throw new Error(`Windows release version must be greater than ${WINDOWS_VERSION_FLOOR}`);
  }
  return version;
}

export function assertArchitecture(arch, platform = "mac") {
  assertPlatform(platform);
  if (!SUPPORTED_ARCHITECTURES.includes(arch)) {
    throw new Error(`Unsupported architecture: ${arch || "<empty>"}`);
  }
  if (platform === "windows" && arch === "universal") {
    throw new Error(`Unsupported architecture for windows: ${arch}`);
  }
  return arch;
}

export function assertChannel(channel) {
  if (!SUPPORTED_CHANNELS.includes(channel)) {
    throw new Error(`Unsupported channel: ${channel || "<empty>"}`);
  }
  return channel;
}

export function artifactKey(version, arch, name, platform = "mac") {
  assertSemverVersion(version);
  assertPlatform(platform);
  assertArchitecture(arch, platform);
  if (!name || name !== name.split(/[\\/]/).at(-1) || name.includes("..")) {
    throw new Error(`Invalid artifact name: ${name || "<empty>"}`);
  }
  return `${RELEASE_ROOT}/v${version}/${platform}/${arch}/${name}`;
}

export function versionManifestKey(version, platform = "mac") {
  assertSemverVersion(version);
  assertPlatform(platform);
  return `${RELEASE_ROOT}/v${version}/${platform}/${platform === "mac" ? "latest-mac.yml" : "latest.yml"}`;
}

export function channelManifestKey(channel, platform = "mac") {
  assertChannel(channel);
  assertPlatform(platform);
  return `${RELEASE_ROOT}/${channel}/${platform}/${platform === "mac" ? "latest-mac.yml" : "latest.yml"}`;
}

export function promotionLockKey(channel, platform = "mac") {
  assertChannel(channel);
  assertPlatform(platform);
  return `${RELEASE_ROOT}/locks/${channel}-${platform}.lock`;
}

export function publicUrl(key) {
  if (!key.startsWith(`${RELEASE_ROOT}/`)) throw new Error(`Object key is outside release root: ${key}`);
  return `${CDN_ORIGIN}/${key}`;
}
