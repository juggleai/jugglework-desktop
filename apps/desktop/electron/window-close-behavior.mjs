/**
 * On macOS, keep the desktop runtime and renderer alive when the user clicks
 * the red traffic-light button. Explicit application quits still pass through
 * so the normal before-quit teardown can stop managed services.
 */
export function installMacCloseToHide({ window, platform = process.platform, canQuit }) {
  if (platform !== "darwin") return () => {};

  const onClose = (event) => {
    if (canQuit()) return;
    event.preventDefault();
    window.hide();
  };

  window.on("close", onClose);
  return () => {
    window.removeListener("close", onClose);
  };
}
