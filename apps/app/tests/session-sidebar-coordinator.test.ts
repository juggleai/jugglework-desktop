import { describe, expect, test } from "bun:test";

import { reconcileCoordinatorProbeSessionIds } from "../src/react-app/domains/session/sidebar/utils";

describe("session sidebar coordinator probes", () => {
  test("removes a completed session while another session in the workspace remains active", () => {
    expect(reconcileCoordinatorProbeSessionIds(
      ["session-completed", "session-running"],
      ["session-running"],
    )).toEqual(["session-running"]);
  });

  test("clears probes after an authoritative empty response", () => {
    expect(reconcileCoordinatorProbeSessionIds(["session-completed"], [])).toEqual([]);
  });

  test("preserves probes while the coordinator endpoint is unavailable", () => {
    expect(reconcileCoordinatorProbeSessionIds(["session-running"], null)).toEqual(["session-running"]);
  });
});
