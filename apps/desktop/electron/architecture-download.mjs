import {
  parseDesktopUpdateManifest,
  resolveDesktopUpdateFeed,
  selectMacDmgArtifact,
} from "../dist/runtime/desktop-update-feed.js";

export async function resolveMacArchitectureDownloadUrl({
  arch,
  channel = "stable",
  fetchImpl = globalThis.fetch,
}) {
  if (arch !== "arm64" && arch !== "x64") return null;
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const { manifestUrl } = resolveDesktopUpdateFeed({ platform: "mac", arch, channel });
  const response = await fetchImpl(manifestUrl, {
    headers: { Accept: "text/yaml, text/plain, */*" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const manifest = parseDesktopUpdateManifest(await response.text());
  return selectMacDmgArtifact(manifest, { arch, manifestUrl })?.url ?? null;
}
