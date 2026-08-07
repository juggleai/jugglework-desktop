import { describe, expect, test } from "bun:test";

import {
  resolveComposerSubmitAction,
  shouldDrainQueuedTask,
} from "../src/react-app/domains/session/surface/queued-draft-policy";

describe("queued draft policy", () => {
  test("queues every composer submission while a task is running", () => {
    expect(resolveComposerSubmitAction(true)).toBe("queue");
    expect(resolveComposerSubmitAction(false)).toBe("send");
  });

  test("drains only after an armed queue observes idle", () => {
    const ready = {
      queuedCount: 2,
      chatStreaming: false,
      liveStatus: "idle",
      waitingForIdle: true,
      draining: false,
      blocked: false,
    };

    expect(shouldDrainQueuedTask(ready)).toBe(true);
    expect(shouldDrainQueuedTask({ ...ready, chatStreaming: true, liveStatus: "busy" })).toBe(false);
    expect(shouldDrainQueuedTask({ ...ready, waitingForIdle: false })).toBe(false);
    expect(shouldDrainQueuedTask({ ...ready, draining: true })).toBe(false);
    expect(shouldDrainQueuedTask({ ...ready, blocked: true })).toBe(false);
    expect(shouldDrainQueuedTask({ ...ready, queuedCount: 0 })).toBe(false);
  });
});
