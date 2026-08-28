/**
 * Keep the desktop runtime and renderer alive on every platform when the user
 * closes the window: the close is intercepted and the window is hidden to the
 * tray instead. Explicit application quits still pass through so the normal
 * before-quit teardown can stop managed services.
 *
 * TIPS: fail-closed — hiding is allowed only while a visible tray indicator
 * exists (`canHide`). Without a tray the close falls through to native
 * behavior (window destroyed → app quits), never leaving the user with a
 * running process that has no visible entry point.
 */
export function installCloseToHide({ window, canQuit, canHide }) {
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
