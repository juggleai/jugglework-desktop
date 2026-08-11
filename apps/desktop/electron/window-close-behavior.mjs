/**
 * On macOS, keep the desktop runtime and renderer alive when the user clicks
 * the red traffic-light button. Explicit application quits still pass through
 * so the normal before-quit teardown can stop managed services.
 */
export function installMacCloseToHide({ window, platform = process.platform, canQuit, canHide = () => true }) {
  if (platform !== "darwin") return () => {};

  const onClose = (event) => {
    if (canQuit() || !canHide()) return;
    event.preventDefault();
    window.hide();
  };

  window.on("close", onClose);
  return () => {
    window.removeListener("close", onClose);
  };
}

/**
 * Background continuation is safe only while its visible indicator exists.
 * Ordinary macOS close behavior remains unchanged when background mode is off.
 */
export function windowAllClosedAction({ platform = process.platform, settings, backgroundIndicatorActive }) {
  if (settings?.enabled === true && settings?.backgroundMode === true) {
    return backgroundIndicatorActive === true ? "keep-running" : "quit";
  }
  return platform === "darwin" ? "keep-running" : "quit";
}
