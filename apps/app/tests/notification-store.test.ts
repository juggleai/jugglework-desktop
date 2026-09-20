import { beforeEach, describe, expect, test } from "bun:test";

// Minimal localStorage stub so the persisted zustand store works under bun.
const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageStub,
  configurable: true,
});

const { PERSISTED_NOTIFICATION_STORE_KEY, useNotificationStore } = await import("../src/react-app/kernel/notification-store");
const { notifyPendingCloudPluginChanges } = await import("../src/react-app/domains/settings/state/extensions-store");

function reset() {
  useNotificationStore.setState({ notifications: [], sourceVersions: {} });
  storage.clear();
}

describe("notification store", () => {
  beforeEach(reset);

  test("add creates an unread entry", () => {
    useNotificationStore.getState().add({
      kind: "system",
      title: "Something happened",
      body: "Details",
    });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("Something happened");
    expect(notifications[0].severity).toBe("info");
    expect(notifications[0].readAt).toBeNull();
    expect(notifications[0].count).toBe(1);
  });

  test("dedupeKey coalesces into the existing unread entry", () => {
    const { add } = useNotificationStore.getState();
    add({ kind: "providers", title: "1 new provider available", dedupeKey: "new-providers" });
    add({ kind: "providers", title: "2 new providers available", dedupeKey: "new-providers" });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("2 new providers available");
    expect(notifications[0].count).toBe(2);
  });

  test("read entries do not absorb new events", () => {
    const { add, markAllRead } = useNotificationStore.getState();
    add({ kind: "providers", title: "1 new provider available", dedupeKey: "new-providers" });
    markAllRead();
    add({ kind: "providers", title: "1 new provider available", dedupeKey: "new-providers" });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(2);
    expect(notifications[0].readAt).toBeNull();
    expect(notifications[1].readAt).not.toBeNull();
  });

  test("coalescing keeps merged fields when the update omits them", () => {
    const { add } = useNotificationStore.getState();
    add({
      kind: "reload",
      title: "Updates pending",
      body: "Will apply when tasks finish.",
      dedupeKey: "engine-reload",
      severity: "info",
    });
    add({
      kind: "reload",
      title: "Updates applied",
      dedupeKey: "engine-reload",
      severity: "success",
    });

    const [entry] = useNotificationStore.getState().notifications;
    expect(entry.title).toBe("Updates applied");
    expect(entry.severity).toBe("success");
    expect(entry.body).toBe("Will apply when tasks finish.");
  });

  test("markAllRead is a no-op when everything is read", () => {
    const { add, markAllRead } = useNotificationStore.getState();
    add({ kind: "system", title: "One" });
    markAllRead();
    const before = useNotificationStore.getState().notifications;
    markAllRead();
    expect(useNotificationStore.getState().notifications).toBe(before);
  });

  test("clearAll empties the list", () => {
    const { add, clearAll } = useNotificationStore.getState();
    add({ kind: "system", title: "One" });
    add({ kind: "system", title: "Two" });
    clearAll();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  test("caps the list at 100 entries", () => {
    const { add } = useNotificationStore.getState();
    for (let index = 0; index < 110; index += 1) {
      add({ kind: "system", title: `Entry ${index}` });
    }
    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(100);
    expect(notifications[0].title).toBe("Entry 109");
  });

  test("source-aware add remains idempotent after read and clear", () => {
    const source = { key: "workspace:org:member:marketplace:plugin", version: 3 };
    const { add, markAllRead, clearAll } = useNotificationStore.getState();
    add({ kind: "cloud", title: "Removed", source });
    markAllRead();
    add({ kind: "cloud", title: "Removed again", source });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);

    clearAll();
    add({ kind: "cloud", title: "Removed after clear", source });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);

    add({ kind: "cloud", title: "Later removal", source: { ...source, version: 4 } });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().sourceVersions[source.key]?.version).toBe(4);
  });

  test("source cursors survive persisted rehydration independently of visible rows", async () => {
    const source = { key: "workspace:org:member:marketplace:plugin", version: 7 };
    useNotificationStore.getState().add({ kind: "cloud", title: "Removed", source });
    useNotificationStore.getState().clearAll();
    const persisted = storage.get(PERSISTED_NOTIFICATION_STORE_KEY);
    expect(persisted).toBeTruthy();

    useNotificationStore.setState({ notifications: [], sourceVersions: {} });
    storage.set(PERSISTED_NOTIFICATION_STORE_KEY, persisted!);
    await useNotificationStore.persist.rehydrate();
    useNotificationStore.getState().add({ kind: "cloud", title: "Duplicate", source });

    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(useNotificationStore.getState().sourceVersions[source.key]?.version).toBe(7);
  });

  test("migrates an existing legacy removal notification into a source cursor without notifying again", () => {
    const { add } = useNotificationStore.getState();
    add({
      kind: "cloud",
      title: "Extension removed by admin",
      dedupeKey: "plugin-removed:plugin_1",
    });
    const legacyNotificationId = useNotificationStore.getState().notifications[0]?.id;

    add({
      kind: "cloud",
      title: "Extension removed by admin",
      dedupeKey: "scoped-removal:7",
      source: {
        key: "workspace:org:member:marketplace:plugin_1",
        version: 7,
        legacyDedupeKeys: ["plugin-removed:plugin_1"],
      },
    });

    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().notifications[0]?.id).toBe(legacyNotificationId);
    expect(useNotificationStore.getState().sourceVersions["workspace:org:member:marketplace:plugin_1"]?.version).toBe(7);
  });

  test("bounds persisted source cursors", () => {
    const { add } = useNotificationStore.getState();
    for (let index = 0; index < 1_010; index += 1) {
      add({
        kind: "cloud",
        title: `Source ${index}`,
        source: { key: `source:${index}`, version: 1 },
      });
    }
    expect(Object.keys(useNotificationStore.getState().sourceVersions)).toHaveLength(1_000);
  });

  test("cloud plugin producer scopes and delivers each occurrence once", () => {
    const installedPlugins = {
      plugin_1: {
        pluginId: "plugin_1",
        marketplaceId: "market_1",
        name: "Plugin One",
        description: null,
        updatedAt: "2026-01-01",
        files: [],
        importedAt: 1,
      },
    };
    const removal = (changeVersion: number) => ({
      id: "plugin_1",
      kind: "removed" as const,
      resourceKind: "plugin" as const,
      changeVersion,
      marketplaceId: "market_1",
      previousLastUpdatedAt: "2026-01-01",
      nextLastUpdatedAt: null,
      queuedAt: changeVersion,
    });
    const notify = (changeVersion: number) => notifyPendingCloudPluginChanges({
      workspaceId: "workspace_1",
      organizationId: "org_1",
      orgMemberId: "member_1",
      changes: [removal(changeVersion)],
      installedPlugins,
      pending: { plugin_1: "removed" },
    });

    notify(1);
    notify(1);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    const sourceKey = Object.keys(useNotificationStore.getState().sourceVersions)[0];
    expect(JSON.parse(sourceKey!)).toEqual([
      "desktop-cloud-resource",
      "workspace_1",
      "org_1",
      "member_1",
      "plugin",
      "market_1",
      "plugin_1",
    ]);

    notifyPendingCloudPluginChanges({
      workspaceId: "workspace_2",
      organizationId: "org_1",
      orgMemberId: "member_1",
      changes: [removal(1)],
      installedPlugins,
      pending: { plugin_1: "removed" },
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(2);

    useNotificationStore.getState().clearAll();
    notify(1);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    notify(2);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });
});
