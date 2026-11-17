import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_WORKSPACE_DISCOVERY_INTERVAL_MS,
  BACKGROUND_WORKSPACE_SYNC_BATCH_INTERVAL_MS,
  backgroundWorkspaceDiscoveryCycleDelay,
  backgroundWorkspaceSyncDelay,
  backgroundWorkspaceSyncIsReady,
  scheduleBatchedWorkspaceSync,
} from "../src/react-app/shell/workspace-sync-startup";

describe("workspace sync startup", () => {
  test("waits for desktop runtime readiness but preserves web and HMR behavior", () => {
    expect(backgroundWorkspaceSyncIsReady({ desktop: false, phase: "idle", routeReady: false })).toBe(true);
    expect(backgroundWorkspaceSyncIsReady({ desktop: true, phase: "starting-engine", routeReady: true })).toBe(false);
    expect(backgroundWorkspaceSyncIsReady({ desktop: true, phase: "ready", routeReady: false })).toBe(true);
    expect(backgroundWorkspaceSyncIsReady({ desktop: true, phase: "idle", routeReady: true })).toBe(true);
  });

  test("starts two background workspaces per batch and cleans up pending work", () => {
    const pending: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
    const started: string[] = [];
    const released: string[] = [];
    const cleanup = scheduleBatchedWorkspaceSync(
      ["a", "b", "c", "d", "e"],
      (item) => {
        started.push(item);
        return () => released.push(item);
      },
      {
        schedule: (callback, delay) => {
          const entry = { callback, delay, cancelled: false };
          pending.push(entry);
          return entry as unknown as ReturnType<typeof globalThis.setTimeout>;
        },
        cancel: (handle) => {
          (handle as unknown as { cancelled: boolean }).cancelled = true;
        },
      },
    );

    expect(started).toEqual(["a", "b"]);
    expect(pending.map((entry) => entry.delay)).toEqual([
      BACKGROUND_WORKSPACE_SYNC_BATCH_INTERVAL_MS,
      BACKGROUND_WORKSPACE_SYNC_BATCH_INTERVAL_MS,
      BACKGROUND_WORKSPACE_SYNC_BATCH_INTERVAL_MS * 2,
    ]);
    expect(backgroundWorkspaceSyncDelay(4)).toBe(BACKGROUND_WORKSPACE_SYNC_BATCH_INTERVAL_MS * 2);
    expect(BACKGROUND_WORKSPACE_DISCOVERY_INTERVAL_MS).toBeGreaterThan(BACKGROUND_WORKSPACE_SYNC_BATCH_INTERVAL_MS);
    expect(backgroundWorkspaceDiscoveryCycleDelay(100)).toBe(
      BACKGROUND_WORKSPACE_DISCOVERY_INTERVAL_MS + BACKGROUND_WORKSPACE_SYNC_BATCH_INTERVAL_MS * 49,
    );

    pending[0]!.callback();
    pending[1]!.callback();
    expect(started).toEqual(["a", "b", "c", "d"]);
    cleanup();
    pending[2]!.callback();
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(pending.every((entry) => entry.cancelled)).toBe(true);
    expect(released).toEqual(["d", "c", "b", "a"]);
  });
});
