/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import * as React from "react";
import TestRenderer, { act } from "react-test-renderer";

const ready = mock();
const failed = mock();
const restarted = mock(async () => { throw new Error("不能重启仍有文件模型的运行时"); });
const published = mock();
const active = mock();
const info = { running: true, baseUrl: "http://127.0.0.1:12345", clientToken: "fixture-token", remoteAccessEnabled: false };
mock.module("../src/app/lib/desktop", () => ({
  engineInfo: mock(), engineStart: mock(), runtimeBootstrap: mock(), workspaceSetRuntimeActive: mock(), workspaceSetSelected: mock(),
  juggleworkServerInfo: async () => info,
  juggleworkServerRestart: restarted,
  workspaceBootstrap: async () => ({ workspaces: [], selectedId: "", activeId: null }),
  resolveWorkspaceListSelectedId: () => null,
}));
mock.module("../src/app/lib/migration", () => ({ ingestMigrationSnapshotOnElectronBoot: async () => 0 }));
mock.module("../src/app/lib/jugglework-server", () => ({
  hydrateJuggleWorkServerSettingsFromEnv() {}, readJuggleWorkServerSettings: () => ({ remoteAccessEnabled: false }),
  writeJuggleWorkServerSettings: published,
}));
mock.module("../src/app/utils", () => ({ isDesktopRuntime: () => true, isElectronRuntime: () => true, safeStringify: JSON.stringify }));
mock.module("../src/react-app/kernel/server-provider", () => ({ useServer: () => ({ setActive: active }) }));
mock.module("../src/react-app/shell/boot-state", () => ({ useBootState: () => ({ setPhase() {}, setError: failed, markReady: ready }) }));
const { DesktopRuntimeBoot } = await import("../src/react-app/shell/desktop-runtime-boot");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("文件模式首次打开零用户工作区主窗口复用现有服务并解除启动等待，不重启存活模型", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: mock() } });
  let root: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => { root = TestRenderer.create(<React.StrictMode><DesktopRuntimeBoot /></React.StrictMode>); });
    expect(restarted).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(published).toHaveBeenCalledTimes(1);
    expect(published.mock.calls[0]?.[0]).toMatchObject({ urlOverride: info.baseUrl, token: info.clientToken });
  } finally {
    await act(async () => { root?.unmount(); });
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
