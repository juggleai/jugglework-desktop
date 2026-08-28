import { describe, expect, test } from "bun:test";

import { createLatestSyncQueue } from "../src/react-app/kernel/latest-sync-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createLatestSyncQueue", () => {
  test("runs refreshes serially and keeps only the latest trailing pass", async () => {
    const firstGate = deferred();
    const calls: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const queue = createLatestSyncQueue(async (reason: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(reason);
      if (reason === "old") await firstGate.promise;
      active -= 1;
    });

    const first = queue.run("old");
    const intermediate = queue.run("intermediate");
    const latest = queue.run("latest");
    firstGate.resolve();
    await Promise.all([first, intermediate, latest]);

    expect(calls).toEqual(["old", "latest"]);
    expect(maximumActive).toBe(1);
  });

  test("waits for the trailing pass before resolving every caller", async () => {
    const firstGate = deferred();
    const trailingGate = deferred();
    let resolved = false;
    const queue = createLatestSyncQueue(async (reason: string) => {
      if (reason === "old") await firstGate.promise;
      if (reason === "latest") await trailingGate.promise;
    });

    const first = queue.run("old").then(() => { resolved = true; });
    const latest = queue.run("latest");
    firstGate.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    trailingGate.resolve();
    await Promise.all([first, latest]);
    expect(resolved).toBe(true);
  });
});
