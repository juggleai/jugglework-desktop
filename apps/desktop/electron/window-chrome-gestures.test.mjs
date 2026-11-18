import assert from "node:assert/strict";
import test from "node:test";
import { applyWindowChromeGesture } from "./window-chrome-gestures.mjs";

function fixture({ maximized = false, fullscreen = false } = {}) {
  const actions = [];
  const win = {
    isFullScreen: () => fullscreen,
    isMaximized: () => maximized,
    getBounds: () => ({ x: 80, y: 60, width: 1000, height: 800 }),
    minimize: () => actions.push("minimize"),
    maximize: () => actions.push("maximize"),
    unmaximize: () => actions.push("unmaximize"),
    setPosition: (x, y) => actions.push([x, y]),
  };
  return { win, actions };
}

test("the title bar uses the Mac double-click preference and restores a maximized window", () => {
  for (const [preference, max, expected] of [
    ["", false, ["maximize"]], ["Maximize", true, ["unmaximize"]],
    ["Minimize", false, ["minimize"]], ["None", false, []],
  ]) {
    const { win, actions } = fixture({ maximized: max === true });
    applyWindowChromeGesture(win, "double-click", null, { getUserDefault: () => preference });
    assert.deepEqual(actions, expected);
  }
});

test("dragging a maximized window keeps it maximized in place", () => {
  const { win, actions } = fixture({ maximized: true });
  applyWindowChromeGesture(win, "move", { x: -120, y: 110, anchorX: 0.5, anchorY: 0.1 }, null);
  assert.deepEqual(actions, []);
});

test("dragging a normal window moves it around the pointer on another display", () => {
  const { win, actions } = fixture();
  applyWindowChromeGesture(win, "move", { x: -120, y: 110, anchorX: 0.5, anchorY: 0.1 }, null);
  assert.deepEqual(actions, [[-620, 30]]);
});

test("a fullscreen window ignores both gestures", () => {
  const { win, actions } = fixture({ fullscreen: true });
  applyWindowChromeGesture(win, "move", { x: 100, y: 200, anchorX: 0.5, anchorY: 0.1 }, null);
  applyWindowChromeGesture(win, "double-click", null, null);
  assert.deepEqual(actions, []);
});
