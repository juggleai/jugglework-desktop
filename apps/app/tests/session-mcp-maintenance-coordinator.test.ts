import { describe, expect, test } from "bun:test";

import {
  createSessionMcpVisibilityResumeHandler,
  runSessionMcpMaintenanceSingleflight,
  trackSessionMcpResumeMaintenance,
  waitForSessionMcpResumeMaintenance,
} from "../src/react-app/domains/connections/session-mcp-maintenance-coordinator";

describe("session MCP maintenance coordinator", () => {
  test("shares one maintenance task for concurrent triggers", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;

    const first = runSessionMcpMaintenanceSingleflight({
      targetKey: "singleflight",
      timeoutMs: 1_000,
      task: async () => {
        runs += 1;
        await gate;
      },
    });
    const second = runSessionMcpMaintenanceSingleflight({
      targetKey: "singleflight",
      timeoutMs: 1_000,
      task: async () => {
        runs += 1;
      },
    });

    release();
    await expect(first).resolves.toMatchObject({ started: true, completion: { status: "ok" } });
    await expect(second).resolves.toMatchObject({ started: false, completion: { status: "ok" } });
    expect(runs).toBe(1);
  });

  test("only visible transitions trigger resume maintenance", () => {
    let visibility: DocumentVisibilityState = "hidden";
    let runs = 0;
    const handleVisibilityChange = createSessionMcpVisibilityResumeHandler({
      visibilityState: () => visibility,
      run: () => {
        runs += 1;
      },
    });

    handleVisibilityChange();
    visibility = "visible";
    handleVisibilityChange();
    expect(runs).toBe(1);
  });

  test("send waits for the active resume maintenance without starting another task", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resumeTask = runSessionMcpMaintenanceSingleflight({
      targetKey: "resume-wait",
      timeoutMs: 1_000,
      task: () => gate,
    });
    trackSessionMcpResumeMaintenance("resume-wait", resumeTask);

    let settled = false;
    const waiting = waitForSessionMcpResumeMaintenance("resume-wait", 1_000).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(waiting).resolves.toEqual({ outcome: "ready" });
    await expect(waitForSessionMcpResumeMaintenance("resume-wait", 1_000))
      .resolves.toEqual({ outcome: "not_running" });
  });

  test("send wait has a bounded timeout", async () => {
    const resumeTask = runSessionMcpMaintenanceSingleflight({
      targetKey: "resume-timeout",
      timeoutMs: 1_000,
      task: () => new Promise<void>(() => {}),
    });
    trackSessionMcpResumeMaintenance("resume-timeout", resumeTask);

    await expect(waitForSessionMcpResumeMaintenance("resume-timeout", 5))
      .resolves.toEqual({ outcome: "timed_out" });
  });
});
