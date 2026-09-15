import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertTargetUpdateManifestVersion,
  configureElectronUpdaterFeed,
  isUnpublishedUpdaterChannelError,
  preventPendingUpdaterInstall,
  registerUpdaterIpc,
  selectWindowsUpdateArtifact,
  staleUpdaterStatePaths,
  targetedStableUpdaterFeed,
  triggerUpdaterInstall,
} from "./updater.mjs";

const fakeApp = { getPath: (key) => (key === "home" ? "/Users/test" : `/Users/test/${key}`) };
const SHA512_X64 = Buffer.alloc(64, 1).toString("base64");
const SHA512_ARM64 = Buffer.alloc(64, 2).toString("base64");

function windowsUpdateInfo(version = "9.0.0") {
  return {
    version,
    files: [
      {
        url: `https://downloads.jugglechat.cn/jugglework/releases/v${version}/windows/x64/jugglework-win-x64-${version}.exe`,
        sha512: SHA512_X64,
        size: 100,
      },
      {
        url: `https://downloads.jugglechat.cn/jugglework/releases/v${version}/windows/arm64/jugglework-win-arm64-${version}.exe`,
        sha512: SHA512_ARM64,
        size: 101,
      },
    ],
  };
}

function updateInfo(version = "9.0.0") {
  return process.platform === "win32" ? windowsUpdateInfo(version) : { version };
}

async function updaterHarness(overrides = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "jugglework-updater-test-"));
  const handlers = new Map();
  const sent = [];
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: async () => ({ updateInfo: updateInfo() }),
    downloadUpdate: async () => undefined,
    quitAndInstall: () => undefined,
    setFeedURL: () => undefined,
  }, overrides.updater);
  const registration = registerUpdaterIpc({
    app: {
      isPackaged: true,
      getVersion: () => "1.0.0",
      getPath: (key) => key === "userData" ? userData : os.homedir(),
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, data) => sent.push([channel, data]) },
    }),
    loadAutoUpdater: overrides.loadAutoUpdater ?? (async () => ({ autoUpdater: updater })),
    onInstallAndRestart: overrides.onInstallAndRestart,
    onInstallAndRestartFailed: overrides.onInstallAndRestartFailed,
  });
  return {
    handlers,
    registration,
    sent,
    updater,
    cleanup: () => rm(userData, { recursive: true, force: true }),
  };
}

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

describe("Windows update inventory", () => {
  it("selects the unique native EXE from a valid dual-architecture inventory", () => {
    const info = windowsUpdateInfo("1.2.18");
    assert.deepEqual(selectWindowsUpdateArtifact(info, "x64"), {
      arch: "x64",
      artifactUrl: info.files[0].url,
      sha512: SHA512_X64,
      file: info.files[0],
    });
    assert.equal(selectWindowsUpdateArtifact(info, "arm64").artifactUrl, info.files[1].url);
  });

  it("rejects missing, duplicate, and cross-architecture EXE entries", () => {
    const missing = windowsUpdateInfo("1.2.18");
    missing.files.pop();
    assert.throws(() => selectWindowsUpdateArtifact(missing, "x64"), /exactly one arm64 EXE/);

    const duplicate = windowsUpdateInfo("1.2.18");
    duplicate.files.push({ ...duplicate.files[0] });
    assert.throws(() => selectWindowsUpdateArtifact(duplicate, "x64"), /exactly one x64 EXE/);

    const crossed = windowsUpdateInfo("1.2.18");
    crossed.files[0].url = crossed.files[0].url.replace("jugglework-win-x64", "jugglework-win-arm64");
    assert.throws(() => selectWindowsUpdateArtifact(crossed, "x64"), /cross-architecture/);
  });
});

describe("installAndRestart", () => {
  it("announces update quit intent before invoking the native installer", () => {
    const calls = [];
    triggerUpdaterInstall(
      { quitAndInstall: (...args) => calls.push(["quitAndInstall", ...args]) },
      () => calls.push(["intent"]),
    );
    assert.deepEqual(calls, [
      ["intent"],
      ["quitAndInstall", false, true],
    ]);
  });

  it("reverts update quit intent when quitAndInstall throws synchronously", () => {
    const calls = [];
    assert.throws(() => triggerUpdaterInstall(
      { quitAndInstall: () => { throw new Error("native install failed"); } },
      () => calls.push("intent"),
      () => calls.push("revert"),
    ), /native install failed/);
    assert.deepEqual(calls, ["intent", "revert"]);
  });

  it("refuses to invoke the installer before an update is downloaded", async () => {
    const handlers = new Map();
    registerUpdaterIpc({
      app: { isPackaged: false },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getMainWindow: () => null,
    });

    const install = handlers.get("jugglework:updater:installAndRestart");
    assert.equal(typeof install, "function");
    assert.deepEqual(await install(null, "update-id"), {
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

describe("updater IPC hardening", () => {
  it("shares initialization and always disables install-on-quit", async () => {
    let loads = 0;
    /** @type {(value: unknown) => void} */
    let resolveLoad = () => {};
    const harness = await updaterHarness({
      loadAutoUpdater: () => {
        loads += 1;
        return new Promise((resolve) => { resolveLoad = resolve; });
      },
    });
    try {
      const first = harness.registration.ensureAutoUpdater();
      const second = harness.registration.ensureAutoUpdater();
      assert.equal(first, second);
      assert.equal(loads, 1);
      resolveLoad({ autoUpdater: harness.updater });
      assert.equal(await first, harness.updater);
      assert.equal(await second, harness.updater);
      assert.equal(harness.updater.autoDownload, false);
      assert.equal(harness.updater.autoInstallOnAppQuit, false);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns structured diagnostics with the exact missing manifest URL", async () => {
    const error = Object.assign(new Error('Cannot find channel "latest.yml" update info: HttpError: 404'), {
      statusCode: 404,
    });
    const harness = await updaterHarness({
      updater: { checkForUpdates: async () => { throw error; } },
    });
    try {
      const result = await harness.handlers.get("jugglework:updater:check")();
      assert.equal(result.available, false);
      assert.equal(result.code, "update-manifest-not-found");
      assert.equal(result.statusCode, 404);
      const platformPath = process.platform === "darwin"
        ? "mac"
        : process.platform === "win32"
          ? "windows"
          : "linux";
      const manifestName = process.platform === "darwin"
        ? "latest-mac.yml"
        : process.platform === "win32"
          ? "latest.yml"
          : process.arch === "arm64"
            ? "latest-linux-arm64.yml"
            : "latest-linux.yml";
      assert.equal(
        result.manifestUrl,
        `https://downloads.jugglechat.cn/jugglework/releases/stable/${platformPath}/${manifestName}`,
      );
      assert.match(result.reason, new RegExp(result.manifestUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      await harness.cleanup();
    }
  });

  it("serializes check and download while binding progress and install to updateId", async () => {
    const calls = [];
    /** @type {() => void} */
    let checkStarted = () => {};
    const started = new Promise((resolve) => { checkStarted = () => resolve(undefined); });
    /** @type {(value: unknown) => void} */
    let resolveCheck = () => {};
    const harness = await updaterHarness({
      updater: {
        checkForUpdates: () => {
          calls.push("check:start");
          checkStarted();
          return new Promise((resolve) => { resolveCheck = resolve; });
        },
        downloadUpdate: async () => {
          calls.push("download");
          harness.updater.emit("download-progress", {
            transferred: 5,
            total: 10,
            percent: 50,
          });
        },
        quitAndInstall: () => calls.push("install"),
      },
    });
    try {
      const checkPromise = harness.handlers.get("jugglework:updater:check")();
      await started;
      assert.deepEqual(calls, ["check:start"]);
      resolveCheck({ updateInfo: updateInfo() });
      const checked = await checkPromise;
      if (process.platform === "win32") {
        const expected = selectWindowsUpdateArtifact(windowsUpdateInfo(), process.arch);
        assert.equal(checked.candidate.arch, process.arch);
        assert.equal(checked.candidate.artifactUrl, expected.artifactUrl);
        assert.equal(checked.candidate.sha512, expected.sha512);
      }
      const downloaded = await harness.handlers.get("jugglework:updater:download")(null, checked.updateId);
      assert.equal(downloaded.ok, true);
      assert.equal(downloaded.updateId, checked.updateId);
      assert.deepEqual(calls, ["check:start", "download"]);
      assert.equal(harness.updater.autoInstallOnAppQuit, false);
      assert.equal(harness.sent.at(-1)?.[1]?.updateId, checked.updateId);

      assert.deepEqual(
        await harness.handlers.get("jugglework:updater:installAndRestart")(null, "stale-id"),
        {
          ok: false,
          reason: "Update candidate is stale or no longer available.",
          code: "stale-update-candidate",
        },
      );
      assert.equal(calls.includes("install"), false);
      const installed = await harness.handlers.get("jugglework:updater:installAndRestart")(null, checked.updateId);
      assert.equal(installed.ok, true);
      assert.equal(installed.updateId, checked.updateId);
      assert.equal(calls.at(-1), "install");
      const replay = await harness.handlers.get("jugglework:updater:installAndRestart")(null, checked.updateId);
      assert.equal(replay.code, "stale-update-candidate");
      assert.equal(calls.filter((call) => call === "install").length, 1);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a stale download candidate without starting a download", async () => {
    let downloads = 0;
    const harness = await updaterHarness({
      updater: { downloadUpdate: async () => { downloads += 1; } },
    });
    try {
      const checked = await harness.handlers.get("jugglework:updater:check")();
      assert.ok(checked.updateId);
      const result = await harness.handlers.get("jugglework:updater:download")(null, "stale-id");
      assert.equal(result.code, "stale-update-candidate");
      assert.equal(downloads, 0);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects missing and blank IDs without downloading or installing", async () => {
    let downloads = 0;
    let installs = 0;
    const harness = await updaterHarness({
      updater: {
        downloadUpdate: async () => { downloads += 1; },
        quitAndInstall: () => { installs += 1; },
      },
    });
    try {
      await harness.handlers.get("jugglework:updater:check")();
      for (const updateId of [undefined, null, "", "   ", { updateId: "object-is-not-supported" }]) {
        const download = await harness.handlers.get("jugglework:updater:download")(null, updateId);
        const install = await harness.handlers.get("jugglework:updater:installAndRestart")(null, updateId);
        assert.equal(download.code, "missing-update-id");
        assert.equal(install.code, "missing-update-id");
      }
      assert.equal(downloads, 0);
      assert.equal(installs, 0);
    } finally {
      await harness.cleanup();
    }
  });

  it("runs the failure callback when the IPC install throws synchronously", async () => {
    const callbacks = [];
    const harness = await updaterHarness({
      updater: {
        quitAndInstall: () => { throw new Error("native install failed"); },
      },
      onInstallAndRestart: () => callbacks.push("intent"),
      onInstallAndRestartFailed: () => callbacks.push("revert"),
    });
    try {
      const checked = await harness.handlers.get("jugglework:updater:check")();
      await harness.handlers.get("jugglework:updater:download")(null, checked.updateId);
      const result = await harness.handlers.get("jugglework:updater:installAndRestart")(
        null,
        checked.updateId,
      );
      assert.equal(result.ok, false);
      assert.match(result.reason, /native install failed/);
      assert.deepEqual(callbacks, ["intent", "revert"]);
      harness.updater.quitAndInstall = () => callbacks.push("retry-install");
      const retry = await harness.handlers.get("jugglework:updater:installAndRestart")(
        null,
        checked.updateId,
      );
      assert.equal(retry.ok, true);
      assert.deepEqual(callbacks, ["intent", "revert", "intent", "retry-install"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("invalidates checked and downloaded IDs on download failure", async () => {
    const harness = await updaterHarness({
      updater: { downloadUpdate: async () => { throw new Error("download failed"); } },
    });
    try {
      const checked = await harness.handlers.get("jugglework:updater:check")();
      const failed = await harness.handlers.get("jugglework:updater:download")(null, checked.updateId);
      assert.match(failed.reason, /download failed/);
      harness.updater.downloadUpdate = async () => undefined;
      const retry = await harness.handlers.get("jugglework:updater:download")(null, checked.updateId);
      assert.equal(retry.code, "stale-update-candidate");
    } finally {
      await harness.cleanup();
    }
  });

  it("invalidates checked and downloaded IDs on updater errors", async () => {
    let installs = 0;
    const harness = await updaterHarness({
      updater: { quitAndInstall: () => { installs += 1; } },
    });
    try {
      const checked = await harness.handlers.get("jugglework:updater:check")();
      harness.updater.emit("error", new Error("check invalidated"));
      const staleDownload = await harness.handlers.get("jugglework:updater:download")(null, checked.updateId);
      assert.equal(staleDownload.code, "stale-update-candidate");

      const rechecked = await harness.handlers.get("jugglework:updater:check")();
      await harness.handlers.get("jugglework:updater:download")(null, rechecked.updateId);
      harness.updater.emit("error", new Error("download invalidated"));
      const staleInstall = await harness.handlers.get("jugglework:updater:installAndRestart")(null, rechecked.updateId);
      assert.equal(staleInstall.reason, "update-not-downloaded");
      assert.equal(installs, 0);
    } finally {
      await harness.cleanup();
    }
  });

  it("invalidates candidates and resets active install intent on an asynchronous updater error", async () => {
    const callbacks = [];
    const harness = await updaterHarness({
      updater: { quitAndInstall: () => undefined },
      onInstallAndRestart: () => callbacks.push("intent"),
      onInstallAndRestartFailed: () => callbacks.push("revert"),
    });
    try {
      const checked = await harness.handlers.get("jugglework:updater:check")();
      await harness.handlers.get("jugglework:updater:download")(null, checked.updateId);
      const installed = await harness.handlers.get("jugglework:updater:installAndRestart")(null, checked.updateId);
      assert.equal(installed.ok, true);
      harness.updater.emit("error", new Error("installer launch failed"));
      assert.deepEqual(callbacks, ["intent", "revert"]);
      const replay = await harness.handlers.get("jugglework:updater:installAndRestart")(null, checked.updateId);
      assert.equal(replay.code, "stale-update-candidate");
    } finally {
      await harness.cleanup();
    }
  });
});
