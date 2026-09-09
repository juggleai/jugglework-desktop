export const DESKTOP_UPDATE_ROOT = "https://downloads.jugglechat.cn/jugglework/releases";
export const DESKTOP_UPDATE_ORIGIN = "https://downloads.jugglechat.cn";

export type DesktopUpdatePlatform = "mac" | "windows" | "linux";
export type DesktopUpdateChannel = "stable" | "alpha";
export type DesktopUpdateArchitecture = "arm64" | "x64" | "universal";
export type DesktopUpdateManifestFile = { url: string; sha512: string; size?: number };
export type DesktopUpdateManifest = {
  version: string;
  files: DesktopUpdateManifestFile[];
  path?: string;
  sha512?: string;
  releaseDate?: string;
};
export type MacDesktopUpdateArtifact = DesktopUpdateManifestFile & {
  version: string;
  arch: DesktopUpdateArchitecture;
  manifestUrl: string;
};

const DESKTOP_UPDATE_PATH_PREFIX = "/jugglework/releases/";

function scalar(value: string) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function normalizeStableDesktopUpdateVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

export function normalizeDesktopUpdatePlatform(value: string): DesktopUpdatePlatform {
  if (value === "darwin" || value === "mac" || value === "macos") return "mac";
  if (value === "win32" || value === "windows" || value === "win") return "windows";
  if (value === "linux") return "linux";
  throw new Error(`Unsupported desktop update platform: ${value}`);
}

export function desktopUpdateManifestName(platform: DesktopUpdatePlatform | string, arch: string = "x64") {
  const normalized = normalizeDesktopUpdatePlatform(platform);
  if (normalized === "mac") return "latest-mac.yml";
  if (normalized === "windows") return "latest.yml";
  return arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

export function resolveDesktopUpdateFeed(input: {
  platform: DesktopUpdatePlatform | string;
  channel?: DesktopUpdateChannel;
  targetVersion?: string | null;
  arch?: string;
}) {
  const platform = normalizeDesktopUpdatePlatform(input.platform);
  const channel = input.channel === "alpha" ? "alpha" : "stable";
  const targetVersion = input.targetVersion == null ? null : normalizeStableDesktopUpdateVersion(input.targetVersion);
  if (input.targetVersion != null && !targetVersion) throw new Error("Target update version must use the stable x.y.z format.");
  if (targetVersion && channel !== "stable") throw new Error("Version-specific update feeds are supported only on the stable channel.");
  const feedUrl = `${DESKTOP_UPDATE_ROOT}/${targetVersion ? `v${targetVersion}` : channel}/${platform}`;
  const manifestName = desktopUpdateManifestName(platform, input.arch);
  return { platform, channel, targetVersion, feedUrl, manifestName, manifestUrl: `${feedUrl}/${manifestName}` };
}

export function parseDesktopUpdateManifest(raw: string): DesktopUpdateManifest {
  let version = "";
  let path: string | undefined;
  let sha512: string | undefined;
  let releaseDate: string | undefined;
  const files: DesktopUpdateManifestFile[] = [];
  let current: Partial<DesktopUpdateManifestFile> | null = null;
  let inFiles = false;
  for (const line of String(raw).split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) { inFiles = true; continue; }
    const fileStart = line.match(/^\s{2}-\s+url:\s*(.+?)\s*$/);
    if (inFiles && fileStart?.[1]) {
      if (current?.url && current.sha512) files.push(current as DesktopUpdateManifestFile);
      current = { url: scalar(fileStart[1]) };
      continue;
    }
    const fileProperty = line.match(/^\s{4}(sha512|size):\s*(.+?)\s*$/);
    if (inFiles && current && fileProperty?.[1] && fileProperty[2]) {
      if (fileProperty[1] === "sha512") current.sha512 = scalar(fileProperty[2]);
      else {
        const size = Number(scalar(fileProperty[2]));
        if (Number.isSafeInteger(size) && size > 0) current.size = size;
      }
      continue;
    }
    if (/^\S/.test(line)) inFiles = false;
    const property = line.match(/^(version|path|sha512|releaseDate):\s*(.+?)\s*$/);
    if (!property?.[1] || !property[2]) continue;
    const value = scalar(property[2]);
    if (property[1] === "version") version = value;
    else if (property[1] === "path") path = value;
    else if (property[1] === "sha512") sha512 = value;
    else releaseDate = value;
  }
  if (current?.url && current.sha512) files.push(current as DesktopUpdateManifestFile);
  if (!version) throw new Error("Update manifest is missing version.");
  if (files.length === 0) throw new Error("Update manifest is missing files.");
  return { version, files, ...(path ? { path } : {}), ...(sha512 ? { sha512 } : {}), ...(releaseDate ? { releaseDate } : {}) };
}

function resolveManifestFileUrl(value: string, manifestUrl: string) {
  const resolved = new URL(value, manifestUrl);
  if (
    resolved.protocol !== "https:"
    || resolved.origin !== DESKTOP_UPDATE_ORIGIN
    || !resolved.pathname.startsWith(DESKTOP_UPDATE_PATH_PREFIX)
  ) {
    throw new Error(`Update artifact uses an unauthorized origin: ${resolved.toString()}`);
  }
  return resolved.toString();
}

function artifactArchitecture(url: string): DesktopUpdateArchitecture | null {
  const pathname = new URL(url).pathname.toLowerCase();
  if (/\/arm64\/|[-_]arm64[-_.]/.test(pathname)) return "arm64";
  if (/\/x64\/|[-_]x64[-_.]/.test(pathname)) return "x64";
  if (/\/universal\/|[-_]universal[-_.]/.test(pathname)) return "universal";
  return null;
}

function selectMacArtifact(
  manifest: DesktopUpdateManifest,
  input: {
    arch: "arm64" | "x64";
    extension: ".dmg" | ".zip";
    manifestUrl: string;
    expectedVersion?: string | null;
  },
): MacDesktopUpdateArtifact | null {
  const expectedVersion = input.expectedVersion == null ? null : normalizeStableDesktopUpdateVersion(input.expectedVersion);
  if (input.expectedVersion != null && !expectedVersion) throw new Error("Expected version must use x.y.z format.");
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`Update manifest version mismatch: expected ${expectedVersion}, received ${manifest.version}`);
  }
  const candidates = manifest.files.flatMap((file) => {
    const url = resolveManifestFileUrl(file.url, input.manifestUrl);
    if (!new URL(url).pathname.toLowerCase().endsWith(input.extension)) return [];
    const arch = artifactArchitecture(url);
    if (!arch || !file.sha512 || (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size <= 0))) return [];
    return [{ ...file, url, arch, version: manifest.version, manifestUrl: input.manifestUrl }];
  });
  return candidates.find((candidate) => candidate.arch === input.arch)
    ?? candidates.find((candidate) => candidate.arch === "universal")
    ?? null;
}

export function selectMacDmgArtifact(
  manifest: DesktopUpdateManifest,
  input: { arch: "arm64" | "x64"; manifestUrl: string; expectedVersion?: string | null },
): MacDesktopUpdateArtifact | null {
  return selectMacArtifact(manifest, { ...input, extension: ".dmg" });
}

export function selectMacZipArtifact(
  manifest: DesktopUpdateManifest,
  input: { arch: "arm64" | "x64"; manifestUrl: string; expectedVersion?: string | null },
): MacDesktopUpdateArtifact | null {
  return selectMacArtifact(manifest, { ...input, extension: ".zip" });
}
