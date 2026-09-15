import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import {
  artifactKey,
  assertChannel,
  assertPlatform,
  assertReleaseVersion,
  assertWindowsReleaseVersion,
  channelManifestKey,
  normalizeReleaseArchitectures,
  publicUrl,
  versionManifestKey,
} from "./constants.mjs";
import { normalizeMacManifest, normalizeWindowsManifest } from "./manifest.mjs";
import { inspectArtifact, metadataForBuffer } from "./metadata.mjs";

function artifactTypes(platform) {
  return platform === "mac" ? ["zip", "dmg", "zip.blockmap", "dmg.blockmap"] : ["exe", "exe.blockmap"];
}

function artifactName(version, arch, type, platform) {
  return `jugglework-${platform === "mac" ? "mac" : "win"}-${arch}-${version}.${type}`;
}

export async function createReleasePlan({
  version,
  channel,
  platform = "mac",
  architectures,
  dist,
  releaseDate,
  inspect = inspectArtifact,
  persistManifest = false,
}) {
  assertReleaseVersion(version, channel);
  assertPlatform(platform);
  if (platform === "windows") assertWindowsReleaseVersion(version);
  const normalizedArchitectures = normalizeReleaseArchitectures(architectures, platform);
  if (!dist) throw new Error("Distribution directory is required");
  const resolvedDist = path.resolve(dist);

  const artifacts = [];
  const stagingManifests = [];
  for (const arch of normalizedArchitectures) {
    const artifactDist = platform === "windows" ? path.join(resolvedDist, arch) : resolvedDist;
    for (const type of artifactTypes(platform)) {
      const name = artifactName(version, arch, type, platform);
      const localPath = path.join(artifactDist, name);
      const metadata = await inspect(localPath);
      const key = artifactKey(version, arch, name, platform);
      artifacts.push({
        arch,
        type,
        name,
        path: localPath,
        key,
        url: publicUrl(key),
        ...metadata,
      });
    }
    if (platform === "windows") {
      const stagingPath = path.join(artifactDist, "latest.yml");
      let manifest;
      try {
        manifest = parseYaml(await readFile(stagingPath, "utf8"));
      } catch (error) {
        throw new Error(`Unable to read Windows staging manifest ${stagingPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      stagingManifests.push({ arch, path: stagingPath, manifest });
    }
  }

  const normalized = (platform === "mac" ? normalizeMacManifest : normalizeWindowsManifest)({
    version,
    platform,
    artifacts,
    primaryArch: normalizedArchitectures.includes("universal") ? "universal" : normalizedArchitectures[0],
    releaseDate,
    stagingManifests,
  });
  const manifestBytes = Buffer.from(normalized.yaml, "utf8");
  const manifestName = platform === "mac" ? "latest-mac.yml" : "latest.yml";
  const manifestPath = path.join(resolvedDist, platform === "mac" ? `qiniu-v${version}-latest-mac.yml` : `qiniu-v${version}-latest.yml`);
  if (persistManifest) {
    await writeFile(manifestPath, normalized.yaml, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  const manifestKey = versionManifestKey(version, platform);
  const manifest = {
    name: manifestName,
    type: "manifest",
    path: persistManifest ? manifestPath : null,
    key: manifestKey,
    url: publicUrl(manifestKey),
    content: normalized.yaml,
    ...metadataForBuffer(manifestBytes, manifestName),
  };
  return {
    version,
    channel,
    platform,
    architectures: normalizedArchitectures,
    dist: resolvedDist,
    objects: normalized.artifacts,
    manifest,
    channelManifest: {
      key: channelManifestKey(channel, platform),
      url: publicUrl(channelManifestKey(channel, platform)),
    },
    actions: [
      ...(platform === "windows" ? ["require passed Windows local verification evidence"] : []),
      ...normalized.artifacts.map((item) => `upload immutable ${item.key}`),
      `upload immutable ${manifest.key}`,
      `verify CDN ${manifest.url}`,
      `acquire promotion lock for ${channel}/${platform}`,
      `overwrite channel manifest ${channelManifestKey(channel, platform)}`,
      `refresh CDN ${publicUrl(channelManifestKey(channel, platform))}`,
      "verify channel digest convergence",
      "release promotion lock",
    ],
  };
}

export function printablePlan(plan) {
  return {
    version: plan.version,
    channel: plan.channel,
    platform: plan.platform,
    architectures: plan.architectures,
    dist: plan.dist,
    objects: [...plan.objects, plan.manifest].map(({ content, ...object }) => object),
    channelManifest: plan.channelManifest,
    actions: plan.actions,
  };
}
