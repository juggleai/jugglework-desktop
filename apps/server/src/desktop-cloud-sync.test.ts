import { describe, expect, test } from "bun:test";
import {
  readDesktopCloudSyncState,
  syncDesktopCloudResources,
  type ResourceSnapshot,
} from "./desktop-cloud-sync.js";

const baseSnapshot: ResourceSnapshot = {
  organizationId: "org_1",
  orgMemberId: "member_1",
  teamIds: [],
  resources: {
    llmProviders: {
      lpr_existing: "2026-06-02T00:00:00.000Z",
      lpr_new: "2026-06-02T00:00:00.000Z",
    },
    marketplaces: {},
  },
};

describe("desktop cloud sync", () => {
  test("queues provider update and remove changes", () => {
    const jugglework = {
      cloudImports: {
        providers: {
          lpr_existing: {
            cloudProviderId: "lpr_existing",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
          lpr_removed: {
            cloudProviderId: "lpr_removed",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
        },
      },
    };

    const result = syncDesktopCloudResources({ now: 1780442400000, jugglework, snapshot: baseSnapshot });

    expect(result.changes).toEqual([
      {
        id: "lpr_existing",
        kind: "modified",
        resourceKind: "llmProvider",
        changeVersion: 1,
        previousLastUpdatedAt: "2026-06-01T00:00:00.000Z",
        nextLastUpdatedAt: "2026-06-02T00:00:00.000Z",
        queuedAt: 1780442400000,
      },
      {
        id: "lpr_removed",
        kind: "removed",
        resourceKind: "llmProvider",
        changeVersion: 2,
        previousLastUpdatedAt: "2026-06-01T00:00:00.000Z",
        nextLastUpdatedAt: null,
        queuedAt: 1780442400000,
      },
    ]);

    const state = readDesktopCloudSyncState(result.jugglework);
    expect(state.entries["org_1::member_1"]?.pendingChanges).toHaveLength(2);
    expect(state.entries["org_1::member_1"]?.nextChangeVersion).toBe(3);
  });

  test("preserves a removal occurrence, clears it on reappearance, and versions a later removal", () => {
    const installedAt = "2026-06-01T00:00:00.000Z";
    const jugglework = {
      cloudImports: {
        plugins: {
          plugin_1: {
            pluginId: "plugin_1",
            marketplaceId: "market_1",
            updatedAt: installedAt,
            files: [],
          },
        },
      },
    };
    const absent: ResourceSnapshot = {
      organizationId: "org_1",
      orgMemberId: "member_1",
      teamIds: [],
      resources: { llmProviders: {}, marketplaces: {} },
    };
    const present: ResourceSnapshot = {
      ...absent,
      resources: {
        llmProviders: {},
        marketplaces: {
          market_1: {
            lastUpdatedAt: installedAt,
            plugins: [{ pluginId: "plugin_1", lastUpdatedAt: installedAt, configItems: [] }],
          },
        },
      },
    };

    const first = syncDesktopCloudResources({ now: 10, jugglework, snapshot: absent });
    const repeated = syncDesktopCloudResources({ now: 20, jugglework: first.jugglework, snapshot: absent });
    expect(repeated.changes).toEqual(first.changes);
    expect(repeated.changes[0]).toMatchObject({ changeVersion: 1, queuedAt: 10 });

    const reappeared = syncDesktopCloudResources({ now: 30, jugglework: repeated.jugglework, snapshot: present });
    expect(reappeared.changes).toEqual([]);
    expect(reappeared.state.entries["org_1::member_1"]?.pendingChanges).toEqual([]);

    const removedAgain = syncDesktopCloudResources({ now: 40, jugglework: reappeared.jugglework, snapshot: absent });
    expect(removedAgain.changes[0]).toMatchObject({ changeVersion: 2, queuedAt: 40 });
  });

  test("migrates legacy pending changes deterministically in persisted order", () => {
    const snapshot: ResourceSnapshot = {
      organizationId: "org_1",
      orgMemberId: "member_1",
      teamIds: [],
      resources: { llmProviders: {}, marketplaces: {} },
    };
    const state = readDesktopCloudSyncState({
      desktopCloudSync: {
        version: 1,
        updatedAt: 5,
        entries: {
          "org_1::member_1": {
            contextKey: "org_1::member_1",
            fetchedAt: 5,
            organizationId: "org_1",
            orgMemberId: "member_1",
            snapshot,
            teamIds: [],
            pendingChanges: [
              {
                id: "plugin_a",
                kind: "removed",
                resourceKind: "plugin",
                marketplaceId: "market_1",
                previousLastUpdatedAt: "2026-01-01",
                nextLastUpdatedAt: null,
                queuedAt: 1,
              },
              {
                id: "plugin_b",
                kind: "removed",
                resourceKind: "plugin",
                marketplaceId: "market_1",
                previousLastUpdatedAt: "2026-01-01",
                nextLastUpdatedAt: null,
                queuedAt: 2,
              },
            ],
          },
        },
      },
    });

    expect(state.version).toBe(2);
    expect(state.entries["org_1::member_1"]?.pendingChanges.map((change) => change.changeVersion)).toEqual([1, 2]);
    expect(state.entries["org_1::member_1"]?.nextChangeVersion).toBe(3);
  });

  test("syncs large provider snapshots within an interactive budget", () => {
    const providerCount = 1_000;
    const llmProviders = Object.fromEntries(
      Array.from({ length: providerCount }, (_, index) => [
        `lpr_provider_${index}`,
        "2026-06-02T00:00:00.000Z",
      ]),
    );
    const importedProviders = Object.fromEntries(
      Array.from({ length: providerCount }, (_, index) => [
        `lpr_provider_${index}`,
        {
          cloudProviderId: `lpr_provider_${index}`,
          updatedAt: index % 2 === 0 ? "2026-06-01T00:00:00.000Z" : "2026-06-02T00:00:00.000Z",
        },
      ]),
    );
    const snapshot: ResourceSnapshot = {
      organizationId: "org_perf",
      orgMemberId: "member_perf",
      teamIds: [],
      resources: { llmProviders, marketplaces: {} },
    };
    const jugglework = { cloudImports: { providers: importedProviders } };

    const start = performance.now();
    const result = syncDesktopCloudResources({ now: 1780442400000, jugglework, snapshot });
    const elapsedMs = performance.now() - start;

    expect(result.changes).toHaveLength(providerCount / 2);
    expect(elapsedMs).toBeLessThan(50);
  });
});
