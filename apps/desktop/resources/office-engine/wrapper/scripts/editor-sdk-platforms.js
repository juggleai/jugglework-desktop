'use strict';

const OHOS_PLATFORM = 'ohos-arm64';

function normalizeEditorSdkPlatformId(platformId) {
  const value = String(platformId);
  return value === 'openharmony-arm64' ? OHOS_PLATFORM : value;
}

function resolveEditorSdkPlatformId(platform, arch) {
  return normalizeEditorSdkPlatformId(`${platform}-${arch}`);
}

function parseIncludeOhos(rawValue) {
  const value = rawValue == null ? '' : String(rawValue).trim();
  if (value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw new Error(`INCLUDE_OHOS must be "true" or "false", got: ${value}`);
}

function configureOhosPlatform(platforms, shouldIncludeOhos) {
  if (!Array.isArray(platforms)) {
    throw new Error('editor-sdk-version.json must contain a platforms array');
  }

  const configured = platforms
    .map(normalizeEditorSdkPlatformId)
    .filter((platform) => platform !== OHOS_PLATFORM);
  if (!shouldIncludeOhos) {
    return configured;
  }

  const firstWin32Index = configured.findIndex((platform) => platform.startsWith('win32-'));
  const insertAt = firstWin32Index === -1 ? configured.length : firstWin32Index;
  configured.splice(insertAt, 0, OHOS_PLATFORM);
  return configured;
}

function findUnsupportedPlatforms(requestedPlatforms, configuredPlatforms) {
  const configured = new Set(configuredPlatforms.map(normalizeEditorSdkPlatformId));
  const requested = requestedPlatforms.map(normalizeEditorSdkPlatformId);
  return [...new Set(requested.filter((platform) => !configured.has(platform)))];
}

module.exports = {
  OHOS_PLATFORM,
  configureOhosPlatform,
  findUnsupportedPlatforms,
  normalizeEditorSdkPlatformId,
  parseIncludeOhos,
  resolveEditorSdkPlatformId,
};
