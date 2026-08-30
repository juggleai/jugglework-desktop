import { afterEach, describe, expect, test } from "bun:test";

import type { CloudImportedPlugin } from "../src/app/cloud/import-state";
import {
  JuggleWorkServerError,
  type JuggleWorkCloudPluginInstallResult,
  type JuggleWorkDesktopCloudSyncState,
  type JuggleWorkServerClient,
} from "../src/app/lib/jugglework-server";
import { createExtensionsStore } from "../src/react-app/domains/settings/state/extensions-store";
import type { JuggleWorkServerStore } from "../src/react-app/domains/connections/jugglework-server-store";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindowDescriptor) Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

function installWindow(orgId = "") {
  const storage = new Map<string, string>();
  if (orgId) storage.set("jugglework.den.activeOrgId", orgId);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  return storage;
}

function plugin(pluginId: string): CloudImportedPlugin {
  return {
    pluginId,
    marketplaceId: null,
    name: pluginId,
    description: null,
    updatedAt: null,
    files: [],
    importedAt: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createStore(input: {
  workspaceId: () => string;
  client: Partial<JuggleWorkServerClient>;
}) {
  const client = input.client as JuggleWorkServerClient;
  const juggleworkServer = {
    getSnapshot: () => ({
      juggleworkServerClient: client,
      juggleworkServerStatus: "connected",
      juggleworkServerCapabilities: {
        skills: { read: true, write: true, source: "jugglework" },
        plugins: { read: true, write: true },
        mcp: { read: true, write: true },
        commands: { read: true, write: true },
        config: { read: true, write: true },
      },
    }),
    subscribe: () => () => undefined,
  } as unknown as JuggleWorkServerStore;

  return createExtensionsStore({
    client: () => null,
    projectDir: () => "",
    selectedWorkspaceId: input.workspaceId,
    selectedWorkspaceRoot: () => `/${input.workspaceId()}`,
    workspaceType: () => "local",
    juggleworkServer,
    runtimeWorkspaceId: input.workspaceId,
    setBusy: () => undefined,
    setBusyLabel: () => undefined,
    setBusyStartedAt: () => undefined,
    setError: () => undefined,
  });
}

const emptySyncState: JuggleWorkDesktopCloudSyncState = {
  entries: {},
  updatedAt: 1,
  version: 1,
};

describe("extensions store cloud operation safety", () => {
  test("clears old context rows synchronously and fences their late response", async () => {
    installWindow();
    let workspaceId = "workspace-a";
    const workspaceA = deferred<{ marketplaces: {}; plugins: Record<string, CloudImportedPlugin> }>();
    const workspaceB = deferred<{ marketplaces: {}; plugins: Record<string, CloudImportedPlugin> }>();
    const store = createStore({
      workspaceId: () => workspaceId,
      client: {
        listCloudPlugins: (id) => id === "workspace-a" ? workspaceA.promise : workspaceB.promise,
        getDesktopCloudSync: async () => emptySyncState,
        syncDesktopCloud: async () => ({ changes: [], state: emptySyncState }),
      },
    });

    store.syncFromOptions();
    workspaceId = "workspace-b";
    store.syncFromOptions();
    expect(store.getSnapshot().importedCloudPlugins).toEqual({});

    workspaceA.resolve({ marketplaces: {}, plugins: { stale: plugin("stale") } });
    await Promise.resolve();
    expect(store.getSnapshot().importedCloudPlugins).toEqual({});

    workspaceB.resolve({ marketplaces: {}, plugins: { current: plugin("current") } });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().importedCloudPlugins).toEqual({ current: plugin("current") });
  });

  test("does not reuse organization A rows while organization B loads", async () => {
    const storage = installWindow("org-a");
    const orgA = deferred<{ marketplaces: {}; plugins: Record<string, CloudImportedPlugin> }>();
    const orgB = deferred<{ marketplaces: {}; plugins: Record<string, CloudImportedPlugin> }>();
    let requestCount = 0;
    const store = createStore({
      workspaceId: () => "workspace-a",
      client: {
        listCloudPlugins: () => requestCount++ === 0 ? orgA.promise : orgB.promise,
        getDesktopCloudSync: async () => emptySyncState,
        syncDesktopCloud: async () => ({ changes: [], state: emptySyncState }),
      },
    });

    store.syncFromOptions();
    storage.set("jugglework.den.activeOrgId", "org-b");
    store.syncFromOptions();
    expect(store.getSnapshot().importedCloudPlugins).toEqual({});

    orgA.resolve({ marketplaces: {}, plugins: { stale: plugin("stale") } });
    await Promise.resolve();
    expect(store.getSnapshot().importedCloudPlugins).toEqual({});

    orgB.resolve({ marketplaces: {}, plugins: { current: plugin("current") } });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().importedCloudPlugins).toEqual({ current: plugin("current") });
  });

  test("preserves same-context last-known-good rows after a transient read failure", async () => {
    installWindow();
    let shouldFail = false;
    const store = createStore({
      workspaceId: () => "workspace-a",
      client: {
        listCloudPlugins: async () => {
          if (shouldFail) throw new Error("temporary outage");
          return { marketplaces: {}, plugins: { installed: plugin("installed") } };
        },
        getDesktopCloudSync: async () => emptySyncState,
        syncDesktopCloud: async () => ({ changes: [], state: emptySyncState }),
      },
    });

    await store.refreshImportedCloudPlugins();
    shouldFail = true;
    await store.refreshImportedCloudPlugins();
    expect(store.getSnapshot().importedCloudPlugins).toEqual({ installed: plugin("installed") });
  });

  test("uses GET-only refresh for changed:false and retains failed operation details until dismissal", async () => {
    installWindow();
    let syncCalls = 0;
    let listCalls = 0;
    let installResult: JuggleWorkCloudPluginInstallResult | Error = {
      item: plugin("plugin-1"),
      warnings: [],
      status: "installed",
      changed: false,
    };
    const store = createStore({
      workspaceId: () => "workspace-a",
      client: {
        installClaudePlugin: async () => {
          if (installResult instanceof Error) throw installResult;
          return installResult;
        },
        listCloudPlugins: async () => {
          listCalls += 1;
          return { marketplaces: {}, plugins: { "plugin-1": plugin("plugin-1") } };
        },
        getDesktopCloudSync: async () => emptySyncState,
        syncDesktopCloud: async () => {
          syncCalls += 1;
          return { changes: [], state: emptySyncState };
        },
      },
    });

    expect((await store.installClaudePlugin("https://example.com/plugin")).ok).toBeTrue();
    expect(listCalls).toBe(1);
    expect(syncCalls).toBe(0);

    installResult = new JuggleWorkServerError(409, "cloud_plugin_failed", "authoritative failure", {
      status: "failed",
      changed: false,
      item: { ...plugin("plugin-1"), status: "failed" },
      outcomes: [],
    });
    const failed = await store.installClaudePlugin("https://example.com/plugin");
    expect(failed).toMatchObject({ ok: false, status: "failed", message: "authoritative failure" });
    expect(listCalls).toBe(2);
    expect(syncCalls).toBe(0);
    expect(store.getSnapshot().marketplacePluginOperations["plugin-1"]).toMatchObject({
      state: "failed",
      message: "authoritative failure",
    });

    store.dismissMarketplacePluginOperation("plugin-1");
    expect(store.getSnapshot().marketplacePluginOperations["plugin-1"]).toBeUndefined();
  });
});
