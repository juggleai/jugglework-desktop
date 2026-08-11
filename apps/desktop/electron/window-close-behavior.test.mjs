import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installMacCloseToHide, windowAllClosedAction } from "./window-close-behavior.mjs";

class FakeWindow extends EventEmitter {
  hideCount = 0;

  hide() {
    this.hideCount += 1;
  }
}

/** @param {{ platform?: NodeJS.Platform, quitting?: boolean, canHide?: boolean }} options */
function fixture({ platform = "darwin", quitting = false, canHide = true } = {}) {
  const window = new FakeWindow();
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  const dispose = installMacCloseToHide({
    window,
    platform,
    canQuit: () => quitting,
    canHide: () => canHide,
  });
  return { window, event, dispose };
}

test("macOS close button hides the window without destroying it", () => {
  const target = fixture();
  target.window.emit("close", target.event);
  assert.equal(target.event.prevented, true);
  assert.equal(target.window.hideCount, 1);
});

test("explicit macOS quit is not intercepted", () => {
  const target = fixture({ quitting: true });
  target.window.emit("close", target.event);
  assert.equal(target.event.prevented, false);
  assert.equal(target.window.hideCount, 0);
});

test("other platforms keep their native close behavior", () => {
  const target = fixture({ platform: "win32" });
  target.window.emit("close", target.event);
  assert.equal(target.event.prevented, false);
  assert.equal(target.window.hideCount, 0);
});

test("macOS does not hide a window when background continuation is unsafe", () => {
  const target = fixture({ canHide: false });
  target.window.emit("close", target.event);
  assert.equal(target.event.prevented, false);
  assert.equal(target.window.hideCount, 0);
});

test("dispose removes the close interception", () => {
  const target = fixture();
  target.dispose();
  target.window.emit("close", target.event);
  assert.equal(target.event.prevented, false);
  assert.equal(target.window.hideCount, 0);
});

test("window-all-closed quits when requested background mode has no indicator", () => {
  const background = { enabled: true, backgroundMode: true };
  assert.equal(windowAllClosedAction({ platform: "darwin", settings: background, backgroundIndicatorActive: false }), "quit");
  assert.equal(windowAllClosedAction({ platform: "win32", settings: background, backgroundIndicatorActive: false }), "quit");
  assert.equal(windowAllClosedAction({ platform: "linux", settings: background, backgroundIndicatorActive: true }), "keep-running");
});

test("window-all-closed preserves native non-background platform behavior", () => {
  const foreground = { enabled: true, backgroundMode: false };
  assert.equal(windowAllClosedAction({ platform: "darwin", settings: foreground, backgroundIndicatorActive: false }), "keep-running");
  assert.equal(windowAllClosedAction({ platform: "win32", settings: foreground, backgroundIndicatorActive: false }), "quit");
});
