import { describe, expect, test } from "bun:test";

import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import {
  effectiveSessionRunning,
  effectiveThreadStatus,
  isSessionBusyError,
  shouldReportAbortFailure,
} from "../src/react-app/domains/session/surface/session-run-recovery";

describe("session run recovery", () => {
  test("a temporary engine idle cannot hide a server-owned active task", () => {
    expect(effectiveSessionRunning({
      sending: false, liveStatus: "idle", activityRunActive: false,
      activityRunEnded: true, coordinatorActive: true,
    })).toBe(true);
  });
  test("keeps Stop/Queue mode when the coordinator is active but OpenCode is idle", () => {
    const running = effectiveSessionRunning({
      sending: false,
      liveStatus: "idle",
      activityRunActive: false,
      activityRunEnded: false,
      coordinatorActive: true,
    });
    expect(running).toBe(true);
    expect(effectiveThreadStatus({
      sending: false,
      liveStatus: "idle",
      running,
    })).toBe("streaming");
  });

  test("keeps retry and submission presentation precedence", () => {
    expect(effectiveThreadStatus({ sending: false, liveStatus: "retry", running: true })).toBe("retrying");
    expect(effectiveThreadStatus({ sending: true, liveStatus: "retry", running: true })).toBe("submitted");
    expect(effectiveThreadStatus({ sending: false, liveStatus: "idle", running: false })).toBe("ready");
  });

  test("keeps optimistic run state before the first busy event", () => {
    expect(effectiveSessionRunning({
      sending: false,
      liveStatus: "idle",
      activityRunActive: true,
      activityRunEnded: false,
      coordinatorActive: false,
    })).toBe(true);
  });

  test("a terminal runtime event overrides stale coordinator and status caches", () => {
    expect(effectiveSessionRunning({
      sending: false,
      liveStatus: "retry",
      activityRunActive: false,
      activityRunEnded: true,
      coordinatorActive: true,
      activityTerminalFailure: true,
    })).toBe(false);
  });

  test("treats abort as idempotent only after authoritative confirmation", () => {
    expect(shouldReportAbortFailure({
      abortRequested: false,
      activeRunsRefreshSucceeded: true,
      coordinatorActive: false,
    })).toBe(false);
    expect(shouldReportAbortFailure({
      abortRequested: false,
      activeRunsRefreshSucceeded: true,
      coordinatorActive: true,
    })).toBe(true);
    expect(shouldReportAbortFailure({
      abortRequested: false,
      activeRunsRefreshSucceeded: false,
      coordinatorActive: false,
    })).toBe(true);
  });

  test("recognizes only structured session_busy conflicts", () => {
    expect(isSessionBusyError(new JuggleWorkServerError(409, "session_busy", "busy"))).toBe(true);
    expect(isSessionBusyError(new JuggleWorkServerError(409, "run_mismatch", "mismatch"))).toBe(false);
    expect(isSessionBusyError(new Error("The session already has an active run"))).toBe(false);
  });
});
