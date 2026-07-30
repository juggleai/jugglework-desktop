import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installMacCloseToHide } from "./window-close-behavior.mjs";

class FakeWindow extends EventEmitter {
  hideCount = 0;

  hide() {
    this.hideCount += 1;
  }
}

/** @param {{ platform?: NodeJS.Platform, quitting?: boolean }} options */
function fixture({ platform = "darwin", quitting = false } = {}) {
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

test("dispose removes the close interception", () => {
  const target = fixture();
  target.dispose();
  target.window.emit("close", target.event);
  assert.equal(target.event.prevented, false);
  assert.equal(target.window.hideCount, 0);
});
