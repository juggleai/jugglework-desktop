import { describe, expect, test } from "bun:test";
import { withPluginOwnershipLock } from "./plugin-ownership-lock.js";

describe("withPluginOwnershipLock", () => {
  test("serializes concurrent operations for the same plugin id", async () => {
    let releaseFirst!: () => void;
    let firstStarted = false;
    let secondStarted = false;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withPluginOwnershipLock("plugin-1", async () => {
      firstStarted = true;
      await firstBlocked;
    });
    while (!firstStarted) await Bun.sleep(1);

    const second = withPluginOwnershipLock("plugin-1", async () => {
      secondStarted = true;
    });
    await Bun.sleep(20);
    expect(secondStarted).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });
});
