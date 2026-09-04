import { existsSync } from "node:fs";
import path from "node:path";

export const MACOS_TRAY_TEMPLATE_FILENAME = "juggleworkTemplate.png";
export const MACOS_TRAY_TEMPLATE_RETINA_FILENAME = "juggleworkTemplate@2x.png";

/**
 * Resolve the macOS menu-bar template image in both packaged and source runs.
 * Packaged resources are authoritative; the repo-relative fallback supports
 * `dev:electron` without copying files into Electron's own resources folder.
 */
export function resolveMacTrayTemplatePath({
  resourcesPath,
  moduleDirectory,
  exists = existsSync,
}) {
  const candidates = [
    resourcesPath ? path.join(resourcesPath, "tray", MACOS_TRAY_TEMPLATE_FILENAME) : null,
    moduleDirectory ? path.resolve(moduleDirectory, "../resources/tray", MACOS_TRAY_TEMPLATE_FILENAME) : null,
  ];
  return candidates.find((candidate) => candidate && exists(candidate)) ?? null;
}

/**
 * macOS requires a dedicated monochrome template image so the menu-bar glyph
 * remains visible in light, dark, selected, and high-contrast appearances.
 * Windows/Linux retain the existing brand/application image behavior.
 */
export function createPlatformTrayIconImage({
  platform,
  nativeImage,
  resourcesPath = "",
  moduleDirectory = "",
  brandImage = null,
  appImage = null,
  exists = existsSync,
}) {
  if (platform !== "darwin") return brandImage ?? appImage;
  const iconPath = resolveMacTrayTemplatePath({ resourcesPath, moduleDirectory, exists });
  if (!iconPath) return null;
  const image = nativeImage.createFromPath(iconPath);
  if (!image || image.isEmpty()) return null;
  image.setTemplateImage(true);
  return image;
}
