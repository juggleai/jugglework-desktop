/** @param {unknown} value */
function desktopPlatform(value) {
  if (value === "darwin" || value === "win32" || value === "linux") return value;
  return "linux";
}

/**
 * Returns Electron options only. Tests of this helper are policy tests, not
 * proof that a platform's login manager accepted the setting.
 * @param {{ platform: unknown, enabled: unknown }} input
 */
export function launchAtLoginOptions({ platform, enabled }) {
  const openAtLogin = enabled === true;
  const common = { openAtLogin, args: ["--hidden"] };
  return desktopPlatform(platform) === "darwin"
    ? { ...common, openAsHidden: openAtLogin }
    : common;
}

/**
 * @param {{ app: { setLoginItemSettings(options: object): void }, platform: unknown, enabled: unknown, logger?: { warn?: (message: string) => void } }} input
 */
export function applyLaunchAtLogin({ app, platform, enabled, logger = {} }) {
  try {
    app.setLoginItemSettings(launchAtLoginOptions({ platform, enabled }));
    return true;
  } catch {
    try { logger.warn?.("Launch-at-login setting could not be applied."); } catch {}
    return false;
  }
}

/**
 * Hidden startup is honored only while all three durable local opt-ins remain
 * enabled. A stale login-manager invocation therefore cannot hide a disabled app.
 * @param {{ argv: unknown, settings: unknown, wasOpenedAsHidden?: unknown }} input
 */
export function shouldStartHidden({ argv, settings, wasOpenedAsHidden = false }) {
  const hiddenRequest = (Array.isArray(argv) && argv.some((value) => value === "--hidden")) || wasOpenedAsHidden === true;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  return hiddenRequest && Reflect.get(settings, "enabled") === true && Reflect.get(settings, "backgroundMode") === true && Reflect.get(settings, "launchAtLogin") === true;
}
