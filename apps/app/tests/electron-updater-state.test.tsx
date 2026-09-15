import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  beginUpdaterOperation,
  runAutomaticStableFallbackCheck,
  useElectronUpdaterState,
} from "../src/react-app/domains/settings/state/electron-updater-state";
import { useUpdateCheckRequestStore } from "../src/react-app/domains/settings/state/update-check-request";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("electron updater operation generation", () => {
  test("old check and download continuations cannot commit after a newer request", async () => {
    const generation = { current: 0 };
    const committed: string[] = [];
    let releaseOldCheck = () => {};
    const oldCheckGate = new Promise<void>((resolve) => { releaseOldCheck = resolve; });
    const oldCheckIsCurrent = beginUpdaterOperation(generation);
    const oldCheck = oldCheckGate.then(() => {
      if (oldCheckIsCurrent()) committed.push("old-check");
    });

    const newCheckIsCurrent = beginUpdaterOperation(generation);
    if (newCheckIsCurrent()) committed.push("new-check");
    releaseOldCheck();
    await oldCheck;

    let releaseOldDownload = () => {};
    const oldDownloadGate = new Promise<void>((resolve) => { releaseOldDownload = resolve; });
    const oldDownloadIsCurrent = beginUpdaterOperation(generation);
    const oldDownload = oldDownloadGate.then(() => {
      if (oldDownloadIsCurrent()) committed.push("old-download");
    });

    const newestCheckIsCurrent = beginUpdaterOperation(generation);
    if (newestCheckIsCurrent()) committed.push("newest-check");
    releaseOldDownload();
    await oldDownload;

    expect(committed).toEqual(["new-check", "newest-check"]);
  });

  test("a delayed old check cannot overwrite a newer Settings request", async () => {
    let resolveOldCheck = (_value: unknown) => {};
    const oldCheck = new Promise<unknown>((resolve) => { resolveOldCheck = resolve; });
    let markOldCheckStarted = () => {};
    const oldCheckStarted = new Promise<void>((resolve) => { markOldCheckStarted = resolve; });
    let checkCount = 0;
    const bridge = {
      getChannel: async () => ({
        channel: "alpha" as const,
        feedUrl: "eval://alpha",
        manifestUrl: "eval://alpha/latest-mac.yml",
        currentVersion: "1.0.0",
      }),
      check: async () => {
        checkCount += 1;
        if (checkCount === 1) {
          markOldCheckStarted();
          return oldCheck as never;
        }
        return { available: false, reason: "new failure", channel: "alpha" as const };
      },
    };
    const originalWindow = globalThis.window;
    globalThis.window = {
      __JUGGLEWORK_ELECTRON__: { updater: bridge },
    } as unknown as Window & typeof globalThis;
    const desktopConfig = { allowAlphaUpdates: true };
    const onReleaseChannelChange = () => {};
    const refreshDesktopConfig = async () => desktopConfig;
    const setError = () => {};

    let updaterState: ReturnType<typeof useElectronUpdaterState> | null = null;
    function Probe() {
      updaterState = useElectronUpdaterState({
        enabled: true,
        releaseChannel: "alpha",
        onReleaseChannelChange,
        updateAutoCheck: false,
        updateAutoDownload: false,
        desktopConfig,
        refreshDesktopConfig,
        setError,
      });
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    try {
      await act(async () => { renderer = TestRenderer.create(<Probe />); });
      let firstCheck: Promise<void> | undefined;
      act(() => { firstCheck = updaterState!.checkForUpdates(); });
      await oldCheckStarted;
      await act(async () => { await updaterState!.checkForUpdates(); });
      expect(updaterState!.updateStatus).toEqual({ state: "error", message: "new failure" });

      await act(async () => {
        resolveOldCheck({ available: false, reason: "old failure", channel: "alpha" });
        await firstCheck;
      });
      expect(updaterState!.updateStatus).toEqual({ state: "error", message: "new failure" });
    } finally {
      await act(async () => renderer?.unmount());
      globalThis.window = originalWindow;
    }
  });

  test("an old automatic fallback resolution cannot issue a second check", async () => {
    const generation = { current: 0 };
    const oldCheckIsCurrent = beginUpdaterOperation(generation);
    let resolveFallback = (_value: string | null) => {};
    const fallbackTargetVersion = new Promise<string | null>((resolve) => { resolveFallback = resolve; });
    const fallbackChecks: string[] = [];
    const oldCheck = runAutomaticStableFallbackCheck({
      resolveTargetVersion: () => fallbackTargetVersion,
      isCurrentOperation: oldCheckIsCurrent,
      check: async (targetVersion) => {
        fallbackChecks.push(targetVersion);
        return { available: true };
      },
    });

    beginUpdaterOperation(generation);
    resolveFallback("1.0.1");

    expect(await oldCheck).toBeNull();
    expect(fallbackChecks).toEqual([]);
  });

  test("an old install failure cannot overwrite a newer check", async () => {
    let resolveInstall = (_value: unknown) => {};
    const install = new Promise<unknown>((resolve) => { resolveInstall = resolve; });
    let checkCount = 0;
    const bridge = {
      getChannel: async () => ({
        channel: "stable" as const,
        feedUrl: "eval://stable",
        manifestUrl: "eval://stable/latest.yml",
        currentVersion: "1.0.0",
      }),
      check: async () => {
        checkCount += 1;
        if (checkCount === 1) {
          return {
            available: true,
            currentVersion: "1.0.0",
            latestVersion: "1.0.1",
            channel: "stable" as const,
            updateId: "update-1",
          };
        }
        return { available: false, reason: "new failure", channel: "stable" as const };
      },
      download: async (updateId: string) => ({ ok: true, updateId }),
      installAndRestart: async () => install as never,
    };
    const originalWindow = globalThis.window;
    globalThis.window = {
      __JUGGLEWORK_ELECTRON__: {
        updater: bridge,
        invokeDesktop: async (command: string) => {
          if (command !== "__fetch") throw new Error(`unexpected command: ${command}`);
          return {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              minAppVersion: "1.0.0",
              latestAppVersion: "1.0.1",
              publishedDesktopVersions: ["1.0.0", "1.0.1"],
            }),
          };
        },
      },
      localStorage: {
        getItem: () => null,
      },
    } as unknown as Window & typeof globalThis;
    const desktopConfig = {};
    const onReleaseChannelChange = () => {};
    const refreshDesktopConfig = async () => desktopConfig;
    const setError = () => {};

    let updaterState: ReturnType<typeof useElectronUpdaterState> | null = null;
    function Probe() {
      updaterState = useElectronUpdaterState({
        enabled: true,
        releaseChannel: "stable",
        onReleaseChannelChange,
        updateAutoCheck: false,
        updateAutoDownload: false,
        desktopConfig,
        refreshDesktopConfig,
        setError,
      });
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    try {
      await act(async () => { renderer = TestRenderer.create(<Probe />); });
      await act(async () => { await updaterState!.checkForUpdates(); });
      expect(updaterState!.updateStatus).toMatchObject({ state: "available", version: "1.0.1" });
      await act(async () => { await updaterState!.downloadUpdate(); });
      expect(updaterState!.updateStatus).toMatchObject({ state: "ready", version: "1.0.1" });
      let oldInstall: Promise<void> | undefined;
      oldInstall = updaterState!.installUpdateAndRestart();
      await Promise.resolve();
      await act(async () => { await updaterState!.checkForUpdates(); });
      expect(updaterState!.updateStatus).toEqual({ state: "error", message: "new failure" });

      await act(async () => {
        resolveInstall({ ok: false, reason: "old install failure" });
        await oldInstall;
      });
      expect(updaterState!.updateStatus).toEqual({ state: "error", message: "new failure" });
    } finally {
      await act(async () => renderer?.unmount());
      globalThis.window = originalWindow;
    }
  });

  test("a disabled updater instance emits no updater IPC", async () => {
    const calls: string[] = [];
    const bridge = {
      getChannel: async () => {
        calls.push("getChannel");
        return { channel: "stable" as const, currentVersion: "1.0.0" };
      },
      setChannel: async () => {
        calls.push("setChannel");
        return { channel: "stable" as const, currentVersion: "1.0.0" };
      },
      check: async () => {
        calls.push("check");
        return { available: false, channel: "stable" as const };
      },
      download: async () => {
        calls.push("download");
        return { ok: true, updateId: "update-1" };
      },
      installAndRestart: async () => {
        calls.push("installAndRestart");
        return { ok: true };
      },
    };
    const originalWindow = globalThis.window;
    globalThis.window = {
      __JUGGLEWORK_ELECTRON__: { updater: bridge },
    } as unknown as Window & typeof globalThis;
    useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
    let updaterState: ReturnType<typeof useElectronUpdaterState> | null = null;

    function DisabledProbe() {
      updaterState = useElectronUpdaterState({
        enabled: false,
        releaseChannel: "stable",
        onReleaseChannelChange: () => {},
        updateAutoCheck: true,
        updateAutoDownload: true,
        desktopConfig: {},
        refreshDesktopConfig: async () => ({}),
        setError: () => {},
      });
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    try {
      await act(async () => { renderer = TestRenderer.create(<DisabledProbe />); });
      await act(async () => {
        useUpdateCheckRequestStore.getState().requestUpdateCheck();
        await Promise.resolve();
      });
      await act(async () => {
        await updaterState!.checkForUpdates();
        await updaterState!.downloadUpdate();
        await updaterState!.installUpdateAndRestart();
        await updaterState!.setReleaseChannel("alpha");
      });

      expect(calls).toEqual([]);
      expect(useUpdateCheckRequestStore.getState().requestedAt).not.toBeNull();
    } finally {
      await act(async () => renderer?.unmount());
      useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
      globalThis.window = originalWindow;
    }
  });

  test("a disabled instance leaves the global check request for the owner", async () => {
    let getChannelCount = 0;
    let checkCount = 0;
    const bridge = {
      getChannel: async () => {
        getChannelCount += 1;
        return { channel: "alpha" as const, currentVersion: "1.0.0" };
      },
      check: async () => {
        checkCount += 1;
        return {
          available: false,
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
          channel: "alpha" as const,
        };
      },
    };
    const originalWindow = globalThis.window;
    globalThis.window = {
      __JUGGLEWORK_ELECTRON__: { updater: bridge },
    } as unknown as Window & typeof globalThis;
    useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
    const commonOptions = {
      releaseChannel: "alpha" as const,
      onReleaseChannelChange: () => {},
      updateAutoCheck: false,
      updateAutoDownload: false,
      desktopConfig: { allowAlphaUpdates: true },
      refreshDesktopConfig: async () => ({ allowAlphaUpdates: true }),
      setError: () => {},
    };

    function DisabledProbe() {
      useElectronUpdaterState({ ...commonOptions, enabled: false });
      return null;
    }

    function OwnerProbe() {
      useElectronUpdaterState({ ...commonOptions, enabled: true });
      return null;
    }

    let disabledRenderer: TestRenderer.ReactTestRenderer | null = null;
    let ownerRenderer: TestRenderer.ReactTestRenderer | null = null;
    try {
      await act(async () => { disabledRenderer = TestRenderer.create(<DisabledProbe />); });
      await act(async () => { useUpdateCheckRequestStore.getState().requestUpdateCheck(); });
      expect(getChannelCount).toBe(0);
      expect(checkCount).toBe(0);
      expect(useUpdateCheckRequestStore.getState().requestedAt).not.toBeNull();

      await act(async () => { ownerRenderer = TestRenderer.create(<OwnerProbe />); });

      expect(getChannelCount).toBe(1);
      expect(checkCount).toBe(1);
      expect(useUpdateCheckRequestStore.getState().requestedAt).toBeNull();
    } finally {
      await act(async () => ownerRenderer?.unmount());
      await act(async () => disabledRenderer?.unmount());
      useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
      globalThis.window = originalWindow;
    }
  });

});
