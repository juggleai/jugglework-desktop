import {
  parseDesktopUpdateManifest,
  resolveDesktopUpdateFeed,
  selectMacZipArtifact,
} from "@jugglework/types/desktop-update-feed";

import { desktopFetch } from "./desktop";

export type ElectronAlphaArtifact = {
  arch: "arm64" | "x64";
  manifestUrl: string;
  releaseUrl: string;
  url: string;
  path: string;
  version: string;
  sha512: string;
};

const ELECTRON_ALPHA_FEED = resolveDesktopUpdateFeed({ platform: "mac", channel: "alpha" });

export const ELECTRON_ALPHA_RELEASE_PAGE_URL =
  ELECTRON_ALPHA_FEED.manifestUrl;

export const ELECTRON_ALPHA_LATEST_MAC_YML_URL = ELECTRON_ALPHA_FEED.manifestUrl;

export function parseElectronLatestMacYml(
  raw: string,
  arch: "arm64" | "x64",
): ElectronAlphaArtifact {
  const manifest = parseDesktopUpdateManifest(raw);
  const artifact = selectMacZipArtifact(manifest, {
    arch,
    manifestUrl: ELECTRON_ALPHA_LATEST_MAC_YML_URL,
  });
  if (!artifact) throw new Error(`latest-mac.yml has no compatible ${arch} ZIP.`);

  return {
    arch,
    manifestUrl: ELECTRON_ALPHA_LATEST_MAC_YML_URL,
    releaseUrl: ELECTRON_ALPHA_RELEASE_PAGE_URL,
    url: artifact.url,
    path: artifact.url,
    version: artifact.version,
    sha512: artifact.sha512,
  };
}

export async function resolveElectronAlphaArtifact(
  arch: "arm64" | "x64" = "arm64",
): Promise<ElectronAlphaArtifact> {
  const response = await desktopFetch(ELECTRON_ALPHA_LATEST_MAC_YML_URL, {
    headers: { Accept: "text/yaml, text/plain, */*" },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch latest-mac.yml (${response.status} ${response.statusText}).`,
    );
  }
  return parseElectronLatestMacYml(await response.text(), arch);
}
