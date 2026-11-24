import { expect, mock, test } from "bun:test";

import { JuggleWorkServerError, type JuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";

function deletionFixture() {
  const config = {
    global: JSON.stringify({ provider: { custom: { name: "Custom" } } }),
    project: JSON.stringify({ disabled_providers: ["custom"] }),
  };
  let providers = [{ id: "custom", source: "config" }] as ProviderListItem[];
  const markReloadRequired = mock(() => {});
  const reloadEngine = mock(async () => { throw new Error("Unexpected inline reload"); });
  const removeProviderAuth = mock(async () => ({ ok: true }));
  const host = {
    removeProviderAuth,
    readOpencodeConfigFile: async (_id: string, scope: keyof typeof config) => ({ content: config[scope] }),
    writeOpencodeConfigFile: mock(async (_id: string, scope: keyof typeof config, content: string) => {
      config[scope] = content;
      return { ok: true };
    }),
    getRuntimeConfigStatus: async () => ({ runtime: { disabled_providers: ["custom"] } }),
    setRuntimeDisabledProviders: mock(async () => ({ changed: true, disabledProviders: [] })),
    reloadEngine,
  };
  const store = createProviderAuthStore({
    client: () => null,
    providers: () => providers,
    providerDefaults: () => ({}),
    providerConnectedIds: () => ["custom"],
    disabledProviders: () => ["custom"],
    checkDesktopAppRestriction: () => false,
    providerBaseUrl: () => "",
    selectedWorkspaceDisplay: () => ({ workspaceType: "local" }) as WorkspaceDisplay,
    selectedWorkspaceRoot: () => "/work",
    runtimeWorkspaceId: () => "workspace",
    juggleworkServer: { getSnapshot: () => ({
      juggleworkServerStatus: "connected",
      juggleworkServerClient: host as unknown as JuggleWorkServerClient,
      juggleworkServerCapabilities: {},
    }) },
    setProviders: (value) => { providers = value; },
    setProviderDefaults: () => {},
    setProviderConnectedIds: () => {},
    setDisabledProviders: () => {},
    markOpencodeConfigReloadRequired: markReloadRequired,
  });
  return { config, host, markReloadRequired, store, providers: () => providers };
}

test("local provider deletion removes the entry and schedules one global reload", async () => {
  const fixture = deletionFixture();
  await fixture.store.deleteProvider("custom");

  expect(fixture.host.removeProviderAuth).toHaveBeenCalledWith("workspace", "custom");
  expect(fixture.host.setRuntimeDisabledProviders).toHaveBeenCalledWith("workspace", []);
  expect(JSON.parse(fixture.config.project)).toEqual({});
  expect(JSON.parse(fixture.config.global)).toEqual({});
  expect(fixture.providers()).toEqual([]);
  expect(fixture.markReloadRequired).toHaveBeenCalledTimes(1);
  expect(fixture.markReloadRequired).toHaveBeenCalledWith({ global: true });
  expect(fixture.host.reloadEngine).not.toHaveBeenCalled();
});

test("a failed workspace config write reports the failed step and preserves ownership for retry", async () => {
  const fixture = deletionFixture();
  fixture.host.writeOpencodeConfigFile.mockImplementationOnce(async () => {
    throw new Error("workspace write failed");
  });

  await expect(fixture.store.deleteProvider("custom")).rejects.toThrow("workspace write failed");
  expect(JSON.parse(fixture.config.global).provider.custom).toEqual({ name: "Custom" });
  expect(fixture.providers()).toHaveLength(1);
  expect(fixture.markReloadRequired).not.toHaveBeenCalled();

  await fixture.store.deleteProvider("custom");
  expect(fixture.providers()).toEqual([]);
  expect(fixture.markReloadRequired).toHaveBeenCalledTimes(1);
});

test("a missing host workspace is reported while an absent OpenCode credential is retry-safe", async () => {
  const fixture = deletionFixture();
  fixture.host.removeProviderAuth.mockRejectedValueOnce(
    new JuggleWorkServerError(404, "workspace_not_found", "Workspace not found"),
  );
  await expect(fixture.store.deleteProvider("custom")).rejects.toThrow("Workspace not found");
  expect(fixture.host.writeOpencodeConfigFile).not.toHaveBeenCalled();

  fixture.host.removeProviderAuth.mockRejectedValueOnce(
    new JuggleWorkServerError(502, "opencode_request_failed", "OpenCode provider authentication request failed", { status: 404 }),
  );
  await fixture.store.deleteProvider("custom");
  expect(fixture.providers()).toEqual([]);
});
