import { describe, expect, test } from "bun:test";

import {
  SESSION_MCP_MAINTENANCE_STALL_MARGIN_MS,
  SESSION_MCP_MAINTENANCE_TIMEOUT_MS,
  resolveStalledMaintenanceState,
} from "../src/react-app/domains/connections/use-session-mcp-maintenance";

const STALL_THRESHOLD = SESSION_MCP_MAINTENANCE_TIMEOUT_MS + SESSION_MCP_MAINTENANCE_STALL_MARGIN_MS;

describe("session MCP maintenance watchdog", () => {
  test("terminal statuses never stall", () => {
    for (const status of ["ready", "skipped", "failed"] as const) {
      expect(resolveStalledMaintenanceState({
        status,
        nonTerminalSince: 0,
        now: STALL_THRESHOLD + 60_000,
        inputsValid: true,
      })).toBeNull();
    }
  });

  test("non-terminal status inside the window keeps waiting", () => {
    expect(resolveStalledMaintenanceState({
      status: "checking",
      nonTerminalSince: 1_000,
      now: 1_000 + STALL_THRESHOLD - 1,
      inputsValid: true,
    })).toBeNull();
  });

  test("wedged checking with valid inputs reports a stall failure", () => {
    const stalled = resolveStalledMaintenanceState({
      status: "checking",
      nonTerminalSince: 1_000,
      now: 1_000 + STALL_THRESHOLD + 1,
      inputsValid: true,
    });
    expect(stalled?.status).toBe("failed");
    expect(stalled?.issue.code).toBe("cloud_mcp_maintenance_stalled");
  });

  test("idle with invalid inputs reports a missing-runtime failure", () => {
    const stalled = resolveStalledMaintenanceState({
      status: "idle",
      nonTerminalSince: 1_000,
      now: 1_000 + STALL_THRESHOLD + 1,
      inputsValid: false,
    });
    expect(stalled?.status).toBe("failed");
    expect(stalled?.issue.code).toBe("cloud_mcp_maintenance_missing_runtime");
  });

  test("no non-terminal timestamp means nothing to judge yet", () => {
    expect(resolveStalledMaintenanceState({
      status: "checking",
      nonTerminalSince: null,
      now: STALL_THRESHOLD + 60_000,
      inputsValid: true,
    })).toBeNull();
  });
});
