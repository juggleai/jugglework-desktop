// Electron normally handles app-region in the native frame. Some layouts
// deliver the mouse stream to Chromium instead. Use the same CSS boundaries.
const interactive = [
  "button", "a[href]", "input", "select", "textarea", "label",
  "[contenteditable]:not([contenteditable=false])", "[draggable=true]", '[tabindex]:not([tabindex="-1"])',
  "[role=button]", "[role=separator]", "[role=dialog]", "[role=menu]", "[data-session-list-preview=true]",
].join(",");

function isWindowChrome(event) {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-workspace-window-shell]")) return false;
  // Inset pages have a 44px gutter. Settings and meeting headers have their
  // own height, and the rail accepts gestures down to its account button.
  if (event.clientY >= 44 && !target.closest("[data-app-navigation-rail]")) {
    const header = target.closest("header");
    if (!header || header.getBoundingClientRect().top > 0) return false;
  }
  const path = event.composedPath().filter(node => node instanceof Element);
  if (path.some(node => node.matches(interactive))) return false;
  for (const node of path) {
    const region = getComputedStyle(node).getPropertyValue("app-region");
    if (region === "no-drag") return false;
    if (region === "drag") return true;
  }
  return false;
}

export function installWindowChromeGestures(send) {
  let press = null;
  let dragged = false;
  window.addEventListener("pointerdown", event => {
    if (!event.isTrusted || event.button !== 0 || event.ctrlKey || !event.isPrimary || event.pointerType !== "mouse") return;
    dragged = false;
    if (!isWindowChrome(event)) return;
    const target = /** @type {Element} */ (event.target);
    target.setPointerCapture(event.pointerId);
    press = {
      id: event.pointerId, x: event.screenX, y: event.screenY,
      anchorX: (event.screenX - window.screenX) / window.outerWidth,
      anchorY: (event.screenY - window.screenY) / window.outerHeight,
    };
  });
  window.addEventListener("pointermove", event => {
    if (!press || event.pointerId !== press.id || !event.isTrusted || !(event.buttons & 1)) return;
    if (!dragged && Math.hypot(event.screenX - press.x, event.screenY - press.y) < 4) return;
    dragged = true;
    send("move", { x: event.screenX, y: event.screenY, anchorX: press.anchorX, anchorY: press.anchorY });
  });
  const release = event => {
    if (event.pointerId === press?.id) press = null;
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("lostpointercapture", release);
  window.addEventListener("blur", () => { press = null; });
  window.addEventListener("dblclick", event => {
    if (event.isTrusted && event.button === 0 && !event.ctrlKey && !dragged && isWindowChrome(event)) send("double-click");
  });
}

export function applyWindowChromeGesture(win, action, point, preferences) {
  if (win.isFullScreen()) return;
  if (action === "double-click") {
    const behavior = preferences.getUserDefault("AppleActionOnDoubleClick", "string").toLowerCase();
    if (behavior === "minimize") win.minimize();
    else if (behavior !== "none") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
    return;
  }
  if (action !== "move" || !point || win.isMaximized()) return;
  const { x, y, anchorX, anchorY } = point;
  if (![x, y, anchorX, anchorY].every(Number.isFinite) || anchorX < 0 || anchorX > 1 || anchorY < 0 || anchorY > 1) return;
  const bounds = win.getBounds();
  win.setPosition(Math.round(x - anchorX * bounds.width), Math.round(y - anchorY * bounds.height));
}
