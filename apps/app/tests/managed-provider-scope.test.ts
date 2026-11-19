import { expect, test } from "bun:test";
import { duringManagedProviderSwitch, managedProviderConfirmationCurrent, managedProviderEpoch, subscribeManagedProviderSwitchSettled } from "../src/app/lib/managed-provider-scope";

test("overlapping switches invalidate an older confirmation and resume sync only after the last switch settles", async () => {
  const epoch = managedProviderEpoch();
  const order: string[] = [];
  const unsubscribe = subscribeManagedProviderSwitchSettled(() => order.push("sync"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const first = duringManagedProviderSwitch(async () => {
      order.push("first");
      await held;
      throw new Error("uncertain switch response");
    });
    const second = duringManagedProviderSwitch(async () => {
      expect(managedProviderConfirmationCurrent(managedProviderEpoch())).toBe(false);
      order.push("second");
    });
    expect(managedProviderConfirmationCurrent(epoch)).toBe(false);
    release();
    await expect(first).rejects.toThrow("uncertain switch response");
    await second;
    expect(order).toEqual(["first", "second", "sync"]);
    expect(managedProviderConfirmationCurrent(managedProviderEpoch())).toBe(true);
  } finally {
    unsubscribe();
  }
});
