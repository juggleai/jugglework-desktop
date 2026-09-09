/**
 * Release-channel concept for JuggleWork desktop builds.
 *
 * There are two channels users can opt into:
 *
 * - "stable": the default. The desktop app auto-updates from the rolling
 *   Qiniu channel manifest. macOS, Linux, Windows.
 *
 * - "alpha": a macOS-only rolling channel that auto-updates on every merge
 *   to `dev`. Alpha builds are published to a fixed Qiniu channel manifest.
 *
 * Only the macOS (arm64) build is published to the alpha channel today.
 * Linux and Windows always resolve to the stable channel.
 */

import type { ReleaseChannel } from "../types";
import { resolveDesktopUpdateFeed } from "@jugglework/types/desktop-update-feed";

/** Stable channel's Tauri updater manifest URL. */
export const STABLE_UPDATER_ENDPOINT =
  resolveDesktopUpdateFeed({ platform: "mac", channel: "stable" }).manifestUrl;

/** Alpha channel's Tauri updater manifest URL (macOS-only, rolling). */
export const ALPHA_UPDATER_ENDPOINT =
  resolveDesktopUpdateFeed({ platform: "mac", channel: "alpha" }).manifestUrl;

/** Rolling Qiniu channel name that alpha macOS artifacts are published to. */
export const ALPHA_MACOS_RELEASE_TAG = "alpha";

export type PlatformKind = "darwin" | "linux" | "windows" | "web" | "unknown";

/**
 * Returns true when the given platform supports the alpha channel.
 *
 * Today alpha builds are produced only for macOS (arm64). The type-level
 * conservatism here is deliberate: it's easier to widen later than to
 * silently start advertising an alpha endpoint that serves no artifact.
 */
export function isAlphaChannelSupported(platform: PlatformKind): boolean {
  return platform === "darwin";
}

/**
 * Resolve the Tauri updater manifest URL for the requested channel.
 *
 * Falls back to the stable endpoint whenever alpha isn't supported on the
 * current platform, so the caller never needs to special-case "alpha chosen
 * on Linux" / "alpha chosen on Windows" etc.
 */
export function resolveUpdaterEndpoint(
  channel: ReleaseChannel,
  platform: PlatformKind = "darwin",
): string {
  const updatePlatform = platform === "windows" ? "windows" : platform === "linux" ? "linux" : "mac";
  return resolveDesktopUpdateFeed({
    platform: updatePlatform,
    channel: channel === "alpha" && isAlphaChannelSupported(platform) ? "alpha" : "stable",
  }).manifestUrl;
}

/** Narrow an arbitrary string to a valid ReleaseChannel, defaulting to stable. */
export function coerceReleaseChannel(value: unknown): ReleaseChannel {
  return value === "alpha" ? "alpha" : "stable";
}
