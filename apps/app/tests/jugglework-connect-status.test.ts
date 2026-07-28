import { describe, expect, test } from "bun:test";

import {
  juggleWorkConnectAttentionTitle,
  resolveJuggleWorkConnectStatus,
} from "../src/react-app/domains/connections/jugglework-connect-status";
import type { SessionCloudMcpMaintenanceState } from "../src/react-app/domains/connections/use-session-mcp-maintenance";

function maintenance(
  status: SessionCloudMcpMaintenanceState["status"],
): SessionCloudMcpMaintenanceState {
  return {
    status,
    issue: status === "failed"
      ? {
          code: "cloud_mcp_unavailable",
          stage: "engine_delivery",
          retryable: false,
          recommendedAction: "Run diagnostics",
          message: "Connected service tools could not be verified.",
        }
      : null,
    attempt: status === "retrying" ? 2 : 1,
    maxAttempts: 3,
  };
}

describe("JuggleWork Connect status", () => {
  test("labels the diagnosed message as one possible issue for native tooltips", () => {
    expect(juggleWorkConnectAttentionTitle("Connected service tools could not be verified."))
      .toBe("One possible issue: Connected service tools could not be verified.");
  });

  test("is hidden while signed out", () => {
    expect(resolveJuggleWorkConnectStatus(false, maintenance("ready"))).toBeNull();
  });

  test("maps the shared lifecycle to checking, ready, and needs attention", () => {
    expect(resolveJuggleWorkConnectStatus(true, undefined)).toMatchObject({
      state: "checking",
      label: "Checking",
    });
    expect(resolveJuggleWorkConnectStatus(true, maintenance("checking"))).toMatchObject({
      state: "checking",
      label: "Checking",
    });
    expect(resolveJuggleWorkConnectStatus(true, maintenance("retrying"))).toMatchObject({
      state: "checking",
      description: "Restoring connected service tools (2/3).",
    });
    expect(resolveJuggleWorkConnectStatus(true, maintenance("ready"))).toMatchObject({
      state: "ready",
      label: "Ready",
    });
    expect(resolveJuggleWorkConnectStatus(true, maintenance("failed"))).toEqual({
      state: "needs_attention",
      label: "Needs attention",
      description: "Connected service tools could not be verified.",
    });
    expect(resolveJuggleWorkConnectStatus(true, maintenance("skipped"))).toMatchObject({
      state: "needs_attention",
      label: "Needs attention",
    });
  });
});
