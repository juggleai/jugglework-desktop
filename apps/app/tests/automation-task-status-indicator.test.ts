import { describe, expect, test } from "bun:test";

import { resolveAutomationTaskVisualStatus } from "../src/react-app/domains/automations/automation-task-status-indicator";

const succeeded = {
  hasUnreadResult: true,
  latestResultRun: { id: "run-ok", state: "succeeded" as const, endedAt: 10, workspaceId: "workspace" },
};

describe("automation task status indicator", () => {
  test("prioritizes queued and running work over unread terminal outcomes", () => {
    expect(resolveAutomationTaskVisualStatus(succeeded, { state: "queued" })).toBe("running");
    expect(resolveAutomationTaskVisualStatus(succeeded, { state: "running" })).toBe("running");
  });

  test("uses distinct unread success and failure outcomes", () => {
    expect(resolveAutomationTaskVisualStatus(succeeded)).toBe("succeeded-unread");
    expect(resolveAutomationTaskVisualStatus({
      hasUnreadResult: true,
      latestResultRun: { id: "run-failed", state: "failed", endedAt: 20, workspaceId: "workspace" },
    })).toBe("failed-unread");
  });

  test("hides terminal outcomes after they are viewed", () => {
    expect(resolveAutomationTaskVisualStatus({ ...succeeded, hasUnreadResult: false })).toBeNull();
    expect(resolveAutomationTaskVisualStatus({ hasUnreadResult: true })).toBeNull();
  });
});
