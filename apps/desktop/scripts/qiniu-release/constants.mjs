export const CDN_ORIGIN = "https://downloads.jugglechat.cn";
export const RELEASE_ROOT = "jugglework/releases";
export const DEFAULT_BUCKET = "juggleim";
export const SUPPORTED_ARCHITECTURES = ["arm64", "x64", "universal"];
export const SUPPORTED_CHANNELS = ["stable", "alpha"];

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

export function assertPlatform(platform) {
  if (platform !== "mac") throw new Error(`Unsupported release platform: ${platform || "<empty>"}`);
  return platform;
}

export function assertArchitecture(arch) {
  if (!SUPPORTED_ARCHITECTURES.includes(arch)) {
    throw new Error(`Unsupported architecture: ${arch || "<empty>"}`);
  }
  return arch;
}

export function assertChannel(channel) {
  if (!SUPPORTED_CHANNELS.includes(channel)) {
    throw new Error(`Unsupported channel: ${channel || "<empty>"}`);
  }
  return channel;
}

export function artifactKey(version, arch, name) {
  assertSemverVersion(version);
  assertArchitecture(arch);
  if (!name || name !== name.split(/[\\/]/).at(-1) || name.includes("..")) {
    throw new Error(`Invalid artifact name: ${name || "<empty>"}`);
  }
  return `${RELEASE_ROOT}/v${version}/mac/${arch}/${name}`;
}

export function versionManifestKey(version) {
  assertSemverVersion(version);
  return `${RELEASE_ROOT}/v${version}/mac/latest-mac.yml`;
}

export function channelManifestKey(channel) {
  assertChannel(channel);
  return `${RELEASE_ROOT}/${channel}/mac/latest-mac.yml`;
}

export function promotionLockKey(channel) {
  assertChannel(channel);
  return `${RELEASE_ROOT}/locks/${channel}-mac.lock`;
}

export function publicUrl(key) {
  if (!key.startsWith(`${RELEASE_ROOT}/`)) throw new Error(`Object key is outside release root: ${key}`);
  return `${CDN_ORIGIN}/${key}`;
}
