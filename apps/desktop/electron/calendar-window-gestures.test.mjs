import assert from "node:assert/strict";
import test from "node:test";
import { applyCalendarWindowGesture } from "./calendar-window-gestures.mjs";

const normal = { x: 350, y: 65, width: 1180, height: 820 };
const maximized = { x: 0, y: 30, width: 1920, height: 952 };

function createWindow() {
  let bounds = normal;
  let zoomed = false;
  return {
    getBounds: () => bounds,
    getNormalBounds: () => normal,
    isFullScreen: () => false,
    isMaximized: () => zoomed,
    maximize() { bounds = maximized; zoomed = true; },
    unmaximize() { bounds = normal; zoomed = false; },
    setPosition(x, y) { bounds = { ...bounds, x, y }; zoomed = false; },
    setBounds(next) { bounds = next; zoomed = false; },
  };
}

const doubleClick = (win) => applyCalendarWindowGesture(win, "double-click", null, { getUserDefault: () => "Maximize" });

test("calendar title bar double-click maximizes and restores", () => {
  const win = createWindow();
  doubleClick(win);
  assert.deepEqual(win.getBounds(), maximized);
  doubleClick(win);
  assert.deepEqual(win.getBounds(), normal);
});

test("dragging the maximized calendar keeps its size and preserves double-click restore", () => {
  const win = createWindow();
  doubleClick(win);
  applyCalendarWindowGesture(win, "move", { x: 28, y: 50 });
  applyCalendarWindowGesture(win, "move", { x: 35, y: 61 });
  assert.deepEqual(win.getBounds(), { ...maximized, x: 35, y: 61 });
  doubleClick(win);
  assert.deepEqual(win.getBounds(), normal);
});

test("an external resize clears the previous restore rectangle", () => {
  const win = createWindow();
  doubleClick(win);
  applyCalendarWindowGesture(win, "move", { x: 28, y: 50 });
  win.setBounds({ ...normal, width: 1000 });
  doubleClick(win);
  assert.deepEqual(win.getBounds(), maximized);
});
