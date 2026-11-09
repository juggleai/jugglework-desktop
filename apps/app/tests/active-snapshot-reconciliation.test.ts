import { describe, expect, test } from "bun:test";

import { createActiveSnapshotReconciler } from "../src/react-app/domains/session/surface/active-snapshot-reconciliation";

describe("active snapshot reconciliation", () => {
  test("coalesces periodic reads while retaining one final reconciliation", async () => {
    const releases: Array<() => void> = [];
    let reads = 0;
    const reconciler = createActiveSnapshotReconciler(() => {
      reads += 1;
      return new Promise<void>((resolve) => releases.push(resolve));
    });

    const first = reconciler.reconcile();
    await reconciler.reconcile();
    await reconciler.reconcile(true);
    expect(reads).toBe(1);

    releases.shift()!();
    await Promise.resolve();
    expect(reads).toBe(2);
    releases.shift()!();
    await first;
    expect(reads).toBe(2);
  });

  test("permits a later snapshot after a user-only first snapshot", async () => {
    const snapshots = [["user"], ["user", "assistant"]];
    let visible = snapshots[0]!;
    const reconciler = createActiveSnapshotReconciler(async () => {
      visible = snapshots.shift() ?? visible;
    });

    await reconciler.reconcile();
    expect(visible).toEqual(["user"]);
    await reconciler.reconcile();
    expect(visible).toEqual(["user", "assistant"]);
  });

  test("contains failed recovery reads so later intervals can retry", async () => {
    let reads = 0;
    const reconciler = createActiveSnapshotReconciler(async () => {
      reads += 1;
      if (reads === 1) throw new Error("temporary snapshot failure");
    });

    await expect(reconciler.reconcile()).resolves.toBeUndefined();
    await reconciler.reconcile();
    expect(reads).toBe(2);
  });
});
