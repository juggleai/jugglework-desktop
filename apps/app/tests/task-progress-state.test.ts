import { describe, expect, test } from "bun:test";

import {
  classifyTaskProgress,
  shouldAcknowledgeTerminalProgress,
  shouldShowTaskProgress,
  shouldSynthesizeBusyAfterAcceptance,
} from "../src/react-app/domains/session/surface/task-progress-state";

describe("task progress presentation", () => {
  test("classifies empty, open, and terminal progress", () => {
    expect(classifyTaskProgress([])).toBe("empty");
    expect(classifyTaskProgress([{ id: "1", content: "work", status: "in_progress", priority: "high" }])).toBe("open");
    expect(classifyTaskProgress([
      { id: "1", content: "done", status: "completed", priority: "high" },
      { id: "2", content: "skipped", status: "cancelled", priority: "low" },
    ])).toBe("terminal");
  });

  test("keeps open work visible after a run ends", () => {
    expect(shouldShowTaskProgress({
      kind: "open",
      runActive: false,
      terminalAcknowledgement: false,
    })).toBe(true);
  });

  test("hides terminal work after acknowledgement", () => {
    expect(shouldShowTaskProgress({
      kind: "terminal",
      runActive: false,
      terminalAcknowledgement: false,
    })).toBe(false);
    expect(shouldShowTaskProgress({
      kind: "terminal",
      runActive: false,
      terminalAcknowledgement: true,
    })).toBe(true);
  });

  test("acknowledges terminal progress for either idle/todo event order", () => {
    expect(shouldAcknowledgeTerminalProgress({
      runJustEnded: true,
      terminalJustArrivedAfterRunEnd: false,
      kind: "terminal",
    })).toBe(true);
    expect(shouldAcknowledgeTerminalProgress({
      runJustEnded: false,
      terminalJustArrivedAfterRunEnd: true,
      kind: "terminal",
    })).toBe(true);
  });

  test("does not synthesize busy after a newer terminal event", () => {
    expect(shouldSynthesizeBusyAfterAcceptance({
      runGenerationBeforeSend: 1,
      activityAfterSend: {
        runGeneration: 2,
        liveRunEnded: true,
        runActive: false,
      } as any,
    })).toBe(false);
  });

  test("synthesizes busy when no lifecycle event arrived during acceptance", () => {
    expect(shouldSynthesizeBusyAfterAcceptance({
      runGenerationBeforeSend: 1,
      activityAfterSend: undefined,
    })).toBe(true);
  });

  test("ignores terminal evidence left by an earlier run", () => {
    expect(shouldSynthesizeBusyAfterAcceptance({
      runGenerationBeforeSend: 1,
      activityAfterSend: {
        runGeneration: 1,
        liveRunEnded: true,
        runActive: false,
      } as any,
    })).toBe(true);
  });
});
