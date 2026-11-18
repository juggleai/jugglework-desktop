export const CALENDAR_WINDOW_GESTURE = "jugglework:calendar-window-gesture";

const stripSelector = '[data-testid="calendar-titlebar-drag-region"]';

export function installCalendarWindowGestures(send) {
  let press = null;
  let dragged = false;

  window.addEventListener("pointerdown", event => {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0 || event.pointerType !== "mouse" || event.ctrlKey) return;
    dragged = false;
    const strip = event.target instanceof Element && event.target.closest(stripSelector);
    if (!strip) return;
    press = {
      strip, id: event.pointerId, x: event.screenX, y: event.screenY,
      offsetX: event.screenX - window.screenX,
      offsetY: event.screenY - window.screenY,
    };
  });

  window.addEventListener("pointermove", event => {
    if (!press || !event.isTrusted || event.pointerId !== press.id || !(event.buttons & 1)) return;
    if (!dragged) {
      if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < 4 || !press.strip.isConnected) return;
      press.strip.setPointerCapture(event.pointerId);
      dragged = true;
    }
    send("move", { x: event.screenX - press.offsetX, y: event.screenY - press.offsetY });
  });

  const release = event => {
    if (event.pointerId === press?.id) press = null;
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("lostpointercapture", release);
  window.addEventListener("blur", () => { press = null; });

  window.addEventListener("dblclick", event => {
    if (event.isTrusted && event.button === 0 && !event.ctrlKey && !dragged &&
        event.target instanceof Element && event.target.closest(stripSelector)) send("double-click");
  });
}

const draggedMaximizedWindows = new WeakMap();

export function applyCalendarWindowGesture(win, action, position, preferences) {
  if (win.isFullScreen()) return;
  const bounds = win.getBounds();
  const previous = draggedMaximizedWindows.get(win);
  // Moving a zoomed NSWindow can clear isMaximized without changing its size.
  // Preserve its restore bounds only while the window remains where we moved it.
  const restore = previous && ["x", "y", "width", "height"].every(key => previous.movedBounds[key] === bounds[key])
    ? previous.normalBounds : null;
  draggedMaximizedWindows.delete(win);

  if (action === "move" && Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
    const normalBounds = win.isMaximized() ? win.getNormalBounds() : restore;
    win.setPosition(Math.round(position.x), Math.round(position.y));
    if (normalBounds) draggedMaximizedWindows.set(win, { normalBounds, movedBounds: win.getBounds() });
  } else if (action === "double-click") {
    const preference = preferences.getUserDefault("AppleActionOnDoubleClick", "string").toLowerCase();
    if (preference === "minimize" || preference === "none") {
      if (restore) draggedMaximizedWindows.set(win, previous);
      if (preference === "minimize") win.minimize();
    } else if (win.isMaximized()) {
      win.unmaximize();
    } else if (restore) {
      win.setBounds(restore);
    } else {
      win.maximize();
    }
  }
}
