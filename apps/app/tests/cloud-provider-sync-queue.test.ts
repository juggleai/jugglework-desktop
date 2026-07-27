import { describe, expect, test } from "bun:test";

import {
  createLatestSyncQueue,
  shouldAdoptWorkspaceSnapshot,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-sync-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createLatestSyncQueue", () => {
  test("waits for the queued workspace pass before resolving callers", async () => {
    const firstPass = deferred();
    const calls: string[] = [];
    const queue = createLatestSyncQueue(async (workspace: string) => {
      calls.push(workspace);
      if (workspace === "old-workspace") await firstPass.promise;
    });

    const first = queue.run("old-workspace");
    const switched = queue.run("new-workspace");

    expect(calls).toEqual(["old-workspace"]);
    firstPass.resolve();
    await switched;

    expect(calls).toEqual(["old-workspace", "new-workspace"]);
    await first;
  });

  test("coalesces repeated requests to the latest queued reason", async () => {
    const firstPass = deferred();
    const calls: string[] = [];
    const queue = createLatestSyncQueue(async (reason: string) => {
      calls.push(reason);
      if (reason === "app_launch") await firstPass.promise;
    });

    const pending = queue.run("app_launch");
    void queue.run("model_picker_open");
    void queue.run("new_chat");
    firstPass.resolve();
    await pending;

    expect(calls).toEqual(["app_launch", "new_chat"]);
  });
});

describe("shouldAdoptWorkspaceSnapshot", () => {
  test("adopts an empty snapshot after switching workspaces", () => {
    expect(
      shouldAdoptWorkspaceSnapshot({
        currentWorkspaceKey: "new-workspace",
        snapshotWorkspaceKey: "old-workspace",
        currentEntryCount: 1,
        nextEntryCount: 0,
      }),
    ).toBe(true);
  });

  test("retains a non-empty snapshot on a transient empty read in the same workspace", () => {
    expect(
      shouldAdoptWorkspaceSnapshot({
        currentWorkspaceKey: "current-workspace",
        snapshotWorkspaceKey: "current-workspace",
        currentEntryCount: 1,
        nextEntryCount: 0,
      }),
    ).toBe(false);
  });
});
