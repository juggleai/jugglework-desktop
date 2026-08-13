import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
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
  it("builds a fixed GitHub release feed from a strict stable version", () => {
    assert.equal(
      targetedStableUpdaterFeed("0.17.22", "0.17.23"),
      "https://github.com/juggleai/jugglework-desktop/releases/download/v0.17.23",
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

describe("updater outage reliability", () => {
  it("disables stale quit-time installs after a network check or download failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jugglework-updater-outage-"));
    const handlers = new Map();
    const updater = Object.assign(new EventEmitter(), {
      autoInstallOnAppQuit: true,
      setFeedURL() {},
      checkForUpdates: async () => ({ updateInfo: { version: "2.0.0" } }),
      downloadUpdate: async () => undefined,
      quitAndInstall() {},
    });
    try {
      registerUpdaterIpc({
        app: {
          isPackaged: true,
          getVersion: () => "1.0.0",
          getPath: (key) => key === "home" ? root : path.join(root, key),
        },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getMainWindow: () => null,
        loadAutoUpdater: async () => ({ autoUpdater: updater }),
      });
      const check = handlers.get("jugglework:updater:check");
      const download = handlers.get("jugglework:updater:download");
      const install = handlers.get("jugglework:updater:installAndRestart");

      assert.equal((await check()).available, true);
      assert.deepEqual(await download(), { ok: true });
      assert.equal(updater.autoInstallOnAppQuit, true);

      updater.checkForUpdates = async () => { throw new Error("fixture network unavailable"); };
      assert.match((await check()).reason, /network unavailable/);
      assert.equal(updater.autoInstallOnAppQuit, false);
      assert.deepEqual(await install(), { ok: false, reason: "update-not-downloaded" });

      updater.checkForUpdates = async () => ({ updateInfo: { version: "2.0.0" } });
      assert.equal((await check()).available, true);
      updater.downloadUpdate = async () => { throw new Error("fixture connection reset"); };
      assert.match((await download()).reason, /connection reset/);
      assert.equal(updater.autoInstallOnAppQuit, false);
      assert.deepEqual(await install(), { ok: false, reason: "update-not-downloaded" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
