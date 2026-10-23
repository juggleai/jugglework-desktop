import { describe, expect, test } from "bun:test";
import type { ReviewConnectionStatus } from "@jugglework/types/reviews";
import { readReviewConnectionWithRecovery } from "../src/react-app/domains/reviews/review-connection-recovery";

const unavailable: ReviewConnectionStatus = { schemaVersion: 1, provider: "github", state: "unavailable", hint: "JuggleWork Connect is unavailable." };
const ready: ReviewConnectionStatus = { schemaVersion: 1, provider: "github", state: "ready", connectionId: "github" };

describe("Review Connect transport recovery", () => {
  test("refreshes rejected transport credentials before returning GitHub readiness", async () => {
    const calls: string[] = [];
    let repaired = false;
    const result = await readReviewConnectionWithRecovery({
      isScopeCurrent: () => true,
      readConnection: async () => { calls.push("read"); return repaired ? ready : unavailable; },
      repairTransport: async () => { calls.push("repair"); repaired = true; return { outcome: "failed", health: { usable: false } }; },
    });
    expect(result).toEqual(ready);
    expect(calls).toEqual(["read", "repair", "read"]);
  });

  test("does not repair ready, disabled, missing, or authorization-required connectors", async () => {
    for (const state of ["ready", "disabled_in_workspace", "not_connected", "member_authorization_required", "organization_admin_action_required", "provider_admin_action_required"] as const) {
      let repairs = 0;
      const result = await readReviewConnectionWithRecovery({
        isScopeCurrent: () => true,
        readConnection: async () => ({ ...ready, state }),
        repairTransport: async () => { repairs++; },
      });
      expect(result.state).toBe(state);
      expect(repairs).toBe(0);
    }
  });

  test("persistent unavailability performs only one repair and one recheck", async () => {
    let reads = 0;
    let repairs = 0;
    expect(await readReviewConnectionWithRecovery({
      isScopeCurrent: () => true,
      readConnection: async () => { reads++; return unavailable; },
      repairTransport: async () => { repairs++; },
    })).toEqual(unavailable);
    expect(reads).toBe(2);
    expect(repairs).toBe(1);
  });

  test("repair failure preserves the recoverable provider state", async () => {
    expect(await readReviewConnectionWithRecovery({
      isScopeCurrent: () => true,
      readConnection: async () => unavailable,
      repairTransport: async () => { throw new Error("offline"); },
    })).toEqual(unavailable);
  });

  test("account changes or cancellation stop recovery before another read", async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let current = true;
      let reads = 0;
      await expect(readReviewConnectionWithRecovery({
        signal: controller.signal,
        isScopeCurrent: () => current,
        readConnection: async () => { reads++; return unavailable; },
        repairTransport: async () => { if (cancel) controller.abort(); else current = false; },
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(reads).toBe(1);
    }
  });
});
