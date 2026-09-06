import { describe, expect, test } from "bun:test";

import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import {
  effectiveSessionRunning,
  isSessionBusyError,
  shouldReportAbortFailure,
} from "../src/react-app/domains/session/surface/session-run-recovery";

describe("session run recovery", () => {
  test("keeps Stop/Queue mode when the coordinator is active but OpenCode is idle", () => {
    expect(effectiveSessionRunning({
      sending: false,
      liveStatus: "idle",
      activityRunActive: false,
      activityRunEnded: false,
      coordinatorActive: true,
    })).toBe(true);
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
