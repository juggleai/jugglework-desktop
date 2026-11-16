import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { DenOrgLlmProvider, DenSettings } from "../src/app/lib/den";
import type { JuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import type { Client, WorkspaceDisplay } from "../src/app/types";
import { readWorkspaceCloudImports, withWorkspaceCloudImports } from "../src/app/cloud/import-state";
import { denSessionUpdatedEvent, type DenSessionUpdatedDetail } from "../src/app/lib/den-session-events";
import { buildCloudImportedProvider } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

// Keep the real Den helpers, but never inherit a build-time development token
// or bootstrap configuration. All session state comes from this test's window.
const actualDen = { ...await import("../src/app/lib/den") };
const TOKEN_KEY = "jugglework.den.authToken";
const ORG_KEY = "jugglework.den.activeOrgId";
const ORG_ID = "org_startup_fixture";
mock.module("../src/app/lib/den", () => ({
  ...actualDen,
  readDenSettings: (): DenSettings => ({
    baseUrl: "https://cloud.startup.test",
    authToken: window.localStorage.getItem(TOKEN_KEY),
    activeOrgId: window.localStorage.getItem(ORG_KEY),
  }),
  readDenUserId: () => "user_startup_fixture",
  createDenClient: () => { throw new Error("Startup tests must not contact Den"); },
}));
const { createProviderAuthStore } = await import("../src/react-app/domains/connections/provider-auth/store");
type Store = ReturnType<typeof createProviderAuthStore>;

const provider: DenOrgLlmProvider = {
  id: "lpr_startup_fixture",
  source: "custom",
  providerId: "startup-fixture",
  name: "Startup fixture",
  providerConfig: { npm: "@ai-sdk/openai-compatible", api: "https://provider.startup.test/v1" },
  hasApiKey: true,
  models: [{ id: "fixture-model", name: "Fixture model", config: {}, createdAt: null }],
  createdAt: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const imported = buildCloudImportedProvider(provider, 1, ORG_ID);

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// The fake host has no timers or I/O: once an explicit gate is released, its
// promise chains drain before the next event-loop turn. No microtask counts.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let hostWindow: EventTarget & { localStorage: Storage };
let stores: Store[] = [];
let gates: ReturnType<typeof deferred>[] = [];
let syncs: Promise<unknown>[] = [];
let fixtureNumber = 0;

beforeEach(() => {
  hostWindow = Object.assign(new EventTarget(), { localStorage: memoryStorage() });
  Object.defineProperty(globalThis, "window", { configurable: true, value: hostWindow });
  hostWindow.localStorage.setItem(TOKEN_KEY, "fixture-session-token");
  hostWindow.localStorage.setItem(ORG_KEY, ORG_ID);
});

afterEach(async () => {
  for (const store of stores) store.dispose();
  for (const gate of gates) gate.resolve();
  await Promise.allSettled(syncs);
  await nextTurn();
  stores = [];
  gates = [];
  syncs = [];
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

afterAll(() => {
  mock.restore();
  mock.module("../src/app/lib/den", () => actualDen);
});

function gate() {
  const result = deferred();
  gates.push(result);
  return result;
}

function fixture(importedProviders: Record<string, typeof imported> = { [provider.id]: imported }) {
  const workspaceId = `ws_startup_fixture_${++fixtureNumber}`;
  const root = `/virtual/startup-fixture/${fixtureNumber}`;
  let jugglework = withWorkspaceCloudImports({ fixtureSetting: "preserve" }, {
    providers: importedProviders, marketplaces: {}, plugins: {},
  });
  const runtimeProviders: Record<string, unknown> = { [imported.providerId]: { models: { "fixture-model": {} } } };
  const credentials = new Set([imported.providerId]);
  let firstReadGate: ReturnType<typeof deferred> | null = null;
  const getConfig = mock(async (_workspaceId: string) => {
    // Snapshot before awaiting, just like a response already in flight.
    const result = structuredClone({ jugglework, opencode: { provider: runtimeProviders } });
    const pending = firstReadGate;
    firstReadGate = null;
    if (pending) await pending.promise;
    return result;
  });
  const patchConfig = mock(async (_workspaceId: string, patch: {
    jugglework?: typeof jugglework;
    opencode?: { provider?: Record<string, unknown> };
  }) => {
    if (patch.jugglework) jugglework = structuredClone(patch.jugglework);
    for (const [id, value] of Object.entries(patch.opencode?.provider ?? {})) {
      if (value === null) delete runtimeProviders[id];
      else runtimeProviders[id] = value;
    }
    return { jugglework, opencode: { provider: runtimeProviders } };
  });
  const removeProviderAuth = mock(async (_workspaceId: string, providerId: string) => {
    credentials.delete(providerId);
    return { ok: true };
  });
  const deleteUserEnv = mock(async () => ({ ok: true }));
  const removeMcp = mock(async () => ({ ok: true }));
  const readOpencodeConfigFile = mock(async () => ({ content: "{}" }));
  const writeOpencodeConfigFile = mock(async () => ({ ok: true }));
  const hostClient = {
    baseUrl: "https://host.startup.test",
    getConfig, patchConfig, removeProviderAuth, deleteUserEnv, removeMcp,
    readOpencodeConfigFile, writeOpencodeConfigFile,
    getRuntimeConfigStatus: async () => ({ runtime: { disabled_providers: [] } }),
  } as unknown as JuggleWorkServerClient;
  const disconnect = mock(async () => ({}));
  const directRemove = mock(async () => ({}));
  const client = { mcp: { disconnect }, auth: { remove: directRemove } } as unknown as Client;
  const availabilityChanged = mock(async () => {});
  const markReload = mock(() => {});

  function create(overrides: {
    client?: Client | null;
    root?: string;
    workspaceId?: string | null;
    hostReady?: boolean;
    ensureWorkspaceId?: boolean;
    hostClient?: JuggleWorkServerClient;
  } = {}) {
    const target = { client, root, workspaceId, hostReady: true, ensureWorkspaceId: false, hostClient, ...overrides };
    const store = createProviderAuthStore({
      client: () => target.client,
      providers: () => [],
      providerDefaults: () => ({}),
      providerConnectedIds: () => [],
      disabledProviders: () => [],
      checkDesktopAppRestriction: () => false,
      selectedWorkspaceDisplay: () => ({ id: workspaceId, name: "Fixture", path: target.root, workspaceType: "local" }) as WorkspaceDisplay,
      providerBaseUrl: () => "https://engine.startup.test",
      selectedWorkspaceRoot: () => target.root,
      runtimeWorkspaceId: () => target.workspaceId,
      ensureRuntimeWorkspaceId: async () => {
        if (target.ensureWorkspaceId) target.workspaceId ??= workspaceId;
        return target.workspaceId;
      },
      juggleworkServer: { getSnapshot: () => ({
        juggleworkServerStatus: target.hostReady ? "connected" : "disconnected",
        juggleworkServerClient: target.hostReady ? target.hostClient : null,
        juggleworkServerCapabilities: { config: { read: true, write: true } },
      }) },
      setProviders: () => {},
      setProviderDefaults: () => {},
      setProviderConnectedIds: () => {},
      setDisabledProviders: () => {},
      markOpencodeConfigReloadRequired: markReload,
      onProviderAvailabilityChanged: availabilityChanged,
    });
    stores.push(store);
    return { store, target };
  }

  function expectPreserved() {
    expect(readWorkspaceCloudImports(jugglework).providers[provider.id]).toEqual(imported);
    expect(runtimeProviders[imported.providerId]).toBeDefined();
    expect(credentials.has(imported.providerId)).toBe(true);
    expect(patchConfig).not.toHaveBeenCalled();
    expect(removeProviderAuth).not.toHaveBeenCalled();
    expect(directRemove).not.toHaveBeenCalled();
    expect(deleteUserEnv).not.toHaveBeenCalled();
    expect(writeOpencodeConfigFile).not.toHaveBeenCalled();
    expect(removeMcp).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(markReload).not.toHaveBeenCalled();
    expect(availabilityChanged).not.toHaveBeenCalled();
  }

  return {
    create, hostClient, getConfig, patchConfig, removeProviderAuth, availabilityChanged,
    runtimeProviders, credentials, expectPreserved,
    baseline: () => readWorkspaceCloudImports(jugglework).providers,
    holdNextBaseline: () => { firstReadGate = gate(); return firstReadGate; },
  };
}

async function startWithBaseline(store: Store) {
  // Latch adoption: buggy startup can adopt and immediately purge within one
  // turn, so polling only the current snapshot would miss the actual failure.
  let adopted = false;
  const unsubscribe = store.subscribe(() => {
    if (store.getSnapshot().importedCloudProviders[provider.id]) adopted = true;
  });
  try {
    store.start();
    await waitFor(() => adopted, "startup baseline adoption");
  } finally {
    unsubscribe();
  }
  await nextTurn();
}

function sessionEvent(detail?: DenSessionUpdatedDetail) {
  // Use a real Event so Node/Bun's EventTarget enforces normal dispatch rules.
  hostWindow.dispatchEvent(Object.assign(new Event(denSessionUpdatedEvent), { detail }));
}

describe("cloud provider startup and session cleanup", () => {
  test("signed-in startup preserves imported providers while the OpenCode client is null", async () => {
    const f = fixture();
    const { store } = f.create({ client: null });
    await startWithBaseline(store);
    f.expectPreserved();
    expect(store.getSnapshot().importedCloudProviders[provider.id]).toEqual(imported);
  });

  test("signed-in startup preserves imported providers while the organization is null", async () => {
    hostWindow.localStorage.removeItem(ORG_KEY);
    const f = fixture();
    const { store } = f.create();
    await startWithBaseline(store);
    f.expectPreserved();
    expect(store.getSnapshot().importedCloudProviders[provider.id]).toEqual(imported);
  });

  test("signed-in startup does not purge before the workspace target is ready", async () => {
    const f = fixture();
    const { store, target } = f.create({ root: "", workspaceId: null });
    store.start();
    await nextTurn();
    f.expectPreserved();
    // Once the route hydrates, the same real store can read the stored import.
    target.root = "/virtual/hydrated-startup-fixture";
    target.workspaceId = "ws_hydrated_startup_fixture";
    await store.refreshImportedCloudProviders();
    expect(store.getSnapshot().importedCloudProviders[provider.id]).toEqual(imported);
  });

  test("a delayed startup baseline cannot trigger cleanup after dispose", async () => {
    hostWindow.localStorage.removeItem(TOKEN_KEY);
    const f = fixture();
    const pending = f.holdNextBaseline();
    const { store } = f.create();
    store.start();
    await waitFor(() => f.getConfig.mock.calls.length === 1, "blocked baseline read");
    store.dispose();
    pending.resolve();
    await nextTurn();
    f.expectPreserved();
  });

  test("a delayed startup baseline cannot purge a newly selected workspace", async () => {
    hostWindow.localStorage.removeItem(TOKEN_KEY);
    const f = fixture();
    const pending = f.holdNextBaseline();
    const { store, target } = f.create();
    store.start();
    await waitFor(() => f.getConfig.mock.calls.length === 1, "blocked baseline read");
    target.root = "/virtual/other-startup-workspace";
    target.workspaceId = "ws_other_startup_workspace";
    pending.resolve();
    await nextTurn();
    f.expectPreserved();
  });

  test.each([
    ["handoff error", { status: "error", message: "Fixture handoff failed" }],
    ["detail without status", { message: "Fixture notification" }],
    ["event without detail", undefined],
  ] as const)("%s preserves imported providers", async (_label, detail) => {
    const f = fixture();
    const { store } = f.create();
    await startWithBaseline(store);
    sessionEvent(detail);
    // This public no-op sync is a barrier behind any session-event mutation.
    hostWindow.localStorage.removeItem(ORG_KEY);
    await store.runCloudProviderSync("app_launch");
    await nextTurn();
    f.expectPreserved();
    expect(store.getSnapshot().importedCloudProviders[provider.id]).toEqual(imported);
  });

  test.each(["signed_out", "tokenless cold startup"] as const)("%s actually removes imported providers", async (trigger) => {
    const f = fixture();
    const { store } = f.create(trigger === "signed_out" ? {} : { client: null });
    if (trigger === "signed_out") {
      await startWithBaseline(store);
      // Keep the fixture token: the explicit event itself must authorize purge.
      sessionEvent({ status: "signed_out" });
    } else {
      hostWindow.localStorage.removeItem(TOKEN_KEY);
      store.start();
    }
    await waitFor(() => f.availabilityChanged.mock.calls.length === 1, "completed cloud cleanup");
    expect(f.baseline()).toEqual({});
    expect(f.runtimeProviders[imported.providerId]).toBeUndefined();
    expect(f.credentials.has(imported.providerId)).toBe(false);
    expect(f.removeProviderAuth.mock.calls[0]?.[1]).toBe(imported.providerId);
    expect(f.patchConfig.mock.calls.some(([, patch]) => patch.opencode?.provider?.[imported.providerId] === null)).toBe(true);
    expect(store.getSnapshot().importedCloudProviders).toEqual({});
  });

  test.each(["ensured workspace id", "late workspace target", "late host"] as const)("tokenless startup cleans up after %s becomes ready only once", async (readiness) => {
    hostWindow.localStorage.removeItem(TOKEN_KEY);
    const f = fixture();
    const { store, target } = f.create({
      client: null,
      ...(readiness === "ensured workspace id" ? { workspaceId: null, ensureWorkspaceId: true } : {}),
      ...(readiness === "late workspace target" ? { root: "", workspaceId: null } : {}),
      ...(readiness === "late host" ? { hostReady: false } : {}),
    });
    store.start();
    await nextTurn();
    if (readiness !== "ensured workspace id") {
      f.expectPreserved();
      if (readiness === "late workspace target") {
        target.root = "/virtual/late-startup-fixture";
        target.workspaceId = "ws_late_startup_fixture";
      } else {
        target.hostReady = true;
      }
      store.syncFromOptions();
    }
    await waitFor(() => f.availabilityChanged.mock.calls.length === 1, "cleanup after target readiness");
    expect(f.baseline()).toEqual({});
    expect(f.runtimeProviders[imported.providerId]).toBeUndefined();
    expect(f.credentials.has(imported.providerId)).toBe(false);
    expect(store.getSnapshot().importedCloudProviders).toEqual({});

    const writes = f.patchConfig.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      store.syncFromOptions();
      await nextTurn();
    }
    expect(f.patchConfig.mock.calls.length).toBe(writes);
    expect(f.removeProviderAuth).toHaveBeenCalledTimes(1);
    expect(f.availabilityChanged).toHaveBeenCalledTimes(1);
  });

  test.each(["login", "dispose", "workspace switch", "StrictMode restart"] as const)("cleanup rechecks its queued baseline after %s", async (change) => {
    const f = fixture();
    // The new workspace does not own this provider. Its empty baseline must
    // replace the old workspace's non-empty one before any cleanup runs.
    const other = fixture({});
    const { store, target } = f.create({ client: null });
    await startWithBaseline(store);
    hostWindow.localStorage.removeItem(TOKEN_KEY);
    const pending = f.holdNextBaseline();
    store.syncFromOptions();
    await waitFor(() => f.getConfig.mock.calls.length === 2, "cleanup baseline refresh");
    // Hold the second read, which must happen inside the mutation queue.
    const queuedBaseline = f.holdNextBaseline();
    pending.resolve();
    await waitFor(() => f.getConfig.mock.calls.length === 3, "queued cleanup baseline");
    if (change === "login") {
      hostWindow.localStorage.setItem(TOKEN_KEY, "fixture-new-login-token");
    } else if (change === "dispose") {
      store.dispose();
    } else if (change === "workspace switch") {
      target.root = "/virtual/new-cleanup-workspace";
      target.workspaceId = "ws_new_cleanup_workspace";
      target.hostClient = other.hostClient;
      store.syncFromOptions();
    } else {
      store.dispose();
      store.start();
    }
    queuedBaseline.resolve();
    await nextTurn();
    if (change === "workspace switch") {
      expect(f.baseline()[provider.id]).toEqual(imported);
      expect(f.runtimeProviders[imported.providerId]).toBeDefined();
      expect(f.credentials.has(imported.providerId)).toBe(true);
      expect(f.patchConfig).not.toHaveBeenCalled();
      expect(f.removeProviderAuth).not.toHaveBeenCalled();
      expect(other.baseline()).toEqual({});
      expect(other.runtimeProviders[imported.providerId]).toBeDefined();
      expect(other.credentials.has(imported.providerId)).toBe(true);
      expect(other.removeProviderAuth).not.toHaveBeenCalled();
      expect(other.patchConfig).not.toHaveBeenCalled();
      expect(f.availabilityChanged).toHaveBeenCalledTimes(1);
    } else if (change === "StrictMode restart") {
      expect(f.baseline()).toEqual({});
      expect(f.removeProviderAuth).toHaveBeenCalledTimes(1);
      expect(f.availabilityChanged).toHaveBeenCalledTimes(1);
    } else {
      f.expectPreserved();
    }
  });

  test.each(["login", "dispose", "workspace switch"] as const)("startup cleanup waits behind workspace mutations and cancels on queued %s", async (change) => {
    const f = fixture();
    const pending = f.holdNextBaseline();
    const blocker = f.create().store;
    const blockingSync = blocker.runCloudProviderSync("app_launch");
    syncs.push(blockingSync);
    await waitFor(() => f.getConfig.mock.calls.length === 1, "sync holding the workspace mutation queue");

    hostWindow.localStorage.removeItem(TOKEN_KEY);
    const { store, target } = f.create({ client: null });
    await startWithBaseline(store);
    const writesWhileBlocked = f.patchConfig.mock.calls.length;
    const authRemovalsWhileBlocked = f.removeProviderAuth.mock.calls.length;
    if (change === "login") {
      hostWindow.localStorage.setItem(TOKEN_KEY, "fixture-new-login-token");
    } else if (change === "dispose") {
      store.dispose();
    } else {
      target.root = "/virtual/switched-while-queued";
      target.workspaceId = "ws_switched_while_queued";
    }
    pending.resolve();
    await blockingSync;
    await store.runCloudProviderSync("app_launch");
    await nextTurn();

    expect(writesWhileBlocked).toBe(0);
    expect(authRemovalsWhileBlocked).toBe(0);
    f.expectPreserved();
    expect(store.getSnapshot().importedCloudProviders[provider.id]).toEqual(imported);
  });
});
