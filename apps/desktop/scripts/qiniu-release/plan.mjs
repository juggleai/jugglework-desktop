import path from "node:path";
import { writeFile } from "node:fs/promises";

import {
  artifactKey,
  assertArchitecture,
  assertChannel,
  assertPlatform,
  assertReleaseVersion,
  channelManifestKey,
  publicUrl,
  versionManifestKey,
} from "./constants.mjs";
import { normalizeMacManifest } from "./manifest.mjs";
import { inspectArtifact, metadataForBuffer } from "./metadata.mjs";

const ARTIFACT_TYPES = ["zip", "dmg", "zip.blockmap", "dmg.blockmap"];

function artifactName(version, arch, type) {
  return `jugglework-mac-${arch}-${version}.${type}`;
}

export async function createReleasePlan({
  version,
  channel,
  platform,
  architectures,
  dist,
  releaseDate,
  inspect = inspectArtifact,
  persistManifest = false,
}) {
  assertReleaseVersion(version, channel);
  assertPlatform(platform);
  if (!Array.isArray(architectures) || architectures.length === 0) throw new Error("At least one architecture is required");
  if (new Set(architectures).size !== architectures.length) throw new Error("Duplicate architectures are not allowed");
  architectures.forEach(assertArchitecture);
  if (architectures.includes("universal") && architectures.length !== 1) {
    throw new Error("Universal architecture cannot be combined with architecture-specific artifacts");
  }
  if (!dist) throw new Error("Distribution directory is required");
  const resolvedDist = path.resolve(dist);

  const artifacts = [];
  for (const arch of architectures) {
    for (const type of ARTIFACT_TYPES) {
      const name = artifactName(version, arch, type);
      const localPath = path.join(resolvedDist, name);
      const metadata = await inspect(localPath);
      artifacts.push({
        arch,
        type,
        name,
        path: localPath,
        key: artifactKey(version, arch, name),
        url: publicUrl(artifactKey(version, arch, name)),
        ...metadata,
      });
    }
  }

  const normalized = normalizeMacManifest({
    version,
    platform,
    artifacts,
    primaryArch: architectures.includes("universal") ? "universal" : architectures[0],
    releaseDate,
  });
  const manifestBytes = Buffer.from(normalized.yaml, "utf8");
  const manifestPath = path.join(resolvedDist, `qiniu-v${version}-latest-mac.yml`);
  if (persistManifest) {
    await writeFile(manifestPath, normalized.yaml, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  const manifestKey = versionManifestKey(version);
  const manifest = {
    name: "latest-mac.yml",
    type: "manifest",
    path: persistManifest ? manifestPath : null,
    key: manifestKey,
    url: publicUrl(manifestKey),
    content: normalized.yaml,
    ...metadataForBuffer(manifestBytes, "latest-mac.yml"),
  };
  return {
    version,
    channel,
    platform,
    architectures: [...architectures],
    dist: resolvedDist,
    objects: normalized.artifacts,
    manifest,
    channelManifest: {
      key: channelManifestKey(channel),
      url: publicUrl(channelManifestKey(channel)),
    },
    actions: [
      ...normalized.artifacts.map((item) => `upload immutable ${item.key}`),
      `upload immutable ${manifest.key}`,
      `verify CDN ${manifest.url}`,
      `acquire promotion lock for ${channel}/mac`,
      `overwrite channel manifest ${channelManifestKey(channel)}`,
      `refresh CDN ${publicUrl(channelManifestKey(channel))}`,
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
