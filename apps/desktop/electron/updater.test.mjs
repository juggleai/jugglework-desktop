import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertTargetUpdateManifestVersion,
  configureElectronUpdaterFeed,
  isUnpublishedUpdaterChannelError,
  preventPendingUpdaterInstall,
  registerUpdaterIpc,
  staleUpdaterStatePaths,
  targetedStableUpdaterFeed,
} from "./updater.mjs";

const fakeApp = { getPath: (key) => (key === "home" ? "/Users/test" : `/Users/test/${key}`) };

describe("staleUpdaterStatePaths", () => {
  it("targets the ShipIt cache on macOS", { skip: process.platform !== "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), [
      "/Users/test/Library/Caches/com.juggleai.jugglework.ShipIt",
    ]);
  });

  it("is a no-op off macOS", { skip: process.platform === "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), []);
  });
});

describe("targetedStableUpdaterFeed", () => {
  it("builds a fixed Qiniu release feed from a strict stable version", () => {
    assert.equal(
      targetedStableUpdaterFeed("0.17.22", "0.17.23", "darwin", "arm64"),
      "https://downloads.jugglechat.cn/jugglework/releases/v0.17.23/mac",
    );
    assert.equal(
      targetedStableUpdaterFeed("0.17.22", "0.17.23", "win32", "x64"),
      "https://downloads.jugglechat.cn/jugglework/releases/v0.17.23/windows",
    );
    assert.equal(
      targetedStableUpdaterFeed("0.17.22", "0.17.23", "linux", "arm64"),
      "https://downloads.jugglechat.cn/jugglework/releases/v0.17.23/linux",
    );
  });

  it("rejects arbitrary URLs and prerelease targets", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.22", "https://example.test/latest.yml"),
      /stable x\.y\.z format/,
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.22", "0.17.23-alpha.1"),
      /stable x\.y\.z format/,
    );
  });

  it("rejects equal and older targets", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.23"),
      /newer than the installed version/,
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.22"),
      /newer than the installed version/,
    );
  });

  it("fails closed when the installed version cannot be compared", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("unknown", "0.17.23"),
      /could not be validated/,
    );
  });
});

describe("Qiniu updater configuration", () => {
  it("configures a generic feed without allowing stable downgrade", () => {
    const calls = [];
    const updater = { setFeedURL: (value) => calls.push(value) };
    configureElectronUpdaterFeed(updater, {
      channel: "stable",
      feedUrl: "https://downloads.jugglechat.cn/jugglework/releases/stable/mac",
    });
    assert.equal(updater.allowPrerelease, false);
    assert.equal(updater.allowDowngrade, false);
    assert.deepEqual(calls, [{
      provider: "generic",
      url: "https://downloads.jugglechat.cn/jugglework/releases/stable/mac",
    }]);
  });

  it("preserves Alpha prerelease behavior without enabling downgrade", () => {
    const updater = {};
    configureElectronUpdaterFeed(updater, { channel: "alpha", feedUrl: "https://example.test" });
    assert.equal(updater.allowPrerelease, true);
    assert.equal(updater.allowDowngrade, false);
  });

  it("rejects a targeted manifest with the wrong version", () => {
    assert.doesNotThrow(() => assertTargetUpdateManifestVersion("1.2.15", "1.2.15"));
    assert.throws(
      () => assertTargetUpdateManifestVersion("1.2.16", "1.2.15"),
      /did not resolve to v1\.2\.15/,
    );
  });
});

describe("installAndRestart", () => {
  it("refuses to invoke the installer before an update is downloaded", async () => {
    const handlers = new Map();
    registerUpdaterIpc({
      app: { isPackaged: false },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getMainWindow: () => null,
    });

    const install = handlers.get("jugglework:updater:installAndRestart");
    assert.equal(typeof install, "function");
    assert.deepEqual(await install(), {
      ok: false,
      reason: "update-not-downloaded",
    });
  });
});

describe("release channel changes", () => {
  it("prevents a previously downloaded update from installing on quit", () => {
    const updater = { autoInstallOnAppQuit: true };

    preventPendingUpdaterInstall(updater);
    assert.equal(updater.autoInstallOnAppQuit, false);
  });
});

describe("isUnpublishedUpdaterChannelError", () => {
  it("recognizes a missing electron-updater channel manifest", () => {
    assert.equal(
      isUnpublishedUpdaterChannelError(
        new Error(
          'Cannot find channel "latest-mac.yml" update info: HttpError: 404 "method: GET"',
        ),
      ),
      true,
    );
    assert.equal(
      isUnpublishedUpdaterChannelError({
        statusCode: 404,
        message: "GET https://example.test/releases/latest/download/latest.yml",
      }),
      true,
    );
  });

  it("does not hide unrelated updater failures", () => {
    assert.equal(
      isUnpublishedUpdaterChannelError(
        new Error('Cannot find channel "latest-mac.yml" update info: HttpError: 401'),
      ),
      false,
    );
    assert.equal(
      isUnpublishedUpdaterChannelError(new Error("HttpError: 404 release-notes.md")),
      false,
    );
  });
});
