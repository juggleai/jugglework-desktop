import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyLaunchAtLogin, launchAtLoginOptions, shouldStartHidden } from "./launch-at-login.mjs";

describe("launch-at-login policy helpers (mocked, not native OS proof)", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    it(`uses a hidden relaunch argument on ${platform}`, () => {
      const options = launchAtLoginOptions({ platform, enabled: true });
      assert.equal(options.openAtLogin, true);
      assert.deepEqual(options.args, ["--hidden"]);
      assert.equal(options.openAsHidden, platform === "darwin" ? true : undefined);
    });
  }

  it("disables login launch without leaving macOS openAsHidden enabled", () => {
    assert.deepEqual(launchAtLoginOptions({ platform: "darwin", enabled: false }), {
      openAtLogin: false,
      args: ["--hidden"],
      openAsHidden: false,
    });
  });

  it("reports Electron failures without throwing or claiming success", () => {
    const warnings = [];
    assert.equal(applyLaunchAtLogin({
      app: { setLoginItemSettings() { throw new Error("unsupported"); } },
      platform: "linux",
      enabled: true,
      logger: { warn: (message) => warnings.push(message) },
    }), false);
    assert.equal(warnings.length, 1);
  });

  it("starts hidden only for a durable fully-enabled background opt-in", () => {
    const enabled = { enabled: true, backgroundMode: true, launchAtLogin: true };
    assert.equal(shouldStartHidden({ argv: ["app", "--hidden"], settings: enabled }), true);
    assert.equal(shouldStartHidden({ argv: ["app"], settings: enabled, wasOpenedAsHidden: true }), true);
    assert.equal(shouldStartHidden({ argv: ["app", "--hidden"], settings: { ...enabled, backgroundMode: false } }), false);
    assert.equal(shouldStartHidden({ argv: ["app", "--hidden"], settings: { ...enabled, enabled: false } }), false);
    assert.equal(shouldStartHidden({ argv: ["app"], settings: enabled }), false);
  });
});
