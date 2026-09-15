import { describe, expect, test } from "bun:test";

import { sessionRunObservation } from "../src/app/lib/opencode";

describe("mounted session run observations", () => {
  test("records provider bytes and persisted parts as run progress", () => {
    expect(sessionRunObservation({
      type: "message.part.delta",
      properties: { sessionID: "session-a", messageID: "message-a", partID: "part-a", delta: "x" },
    })).toEqual({ sessionId: "session-a", status: "running" });

    expect(sessionRunObservation({
      type: "message.part.updated",
      properties: { part: { id: "part-a", sessionID: "session-a", type: "text" } },
    })).toEqual({ sessionId: "session-a", status: "running" });

    expect(sessionRunObservation({
      type: "message.updated",
      properties: { info: { id: "message-a", sessionID: "session-a", role: "assistant" } },
    })).toEqual({ sessionId: "session-a", status: "running" });
  });
});

