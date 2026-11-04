import { describe, expect, test } from "bun:test";

import { sessionRunObservation } from "../src/app/lib/opencode";

test("persisting a user message is not evidence that the engine started work", () => {
  expect(sessionRunObservation({ type: "message.updated", properties: {
    info: { role: "user", sessionID: "ses_start" },
  } })).toBeNull();
});

describe("mounted session run observations", () => {
  test("only the engine MessageAbortedError class is cancellation, not arbitrary errors during Stop", () => {
    for (const [error, status] of [
      [{ name: "MessageAbortedError", data: { message: "Aborted" } }, "aborted"],
      [{ name: "APIError", data: { message: "Aborted provider request", statusCode: 500 } }, "failed"],
      [{ name: "APIError", data: { responseBody: '{"error":{"name":"MessageAbortedError"}}' } }, "failed"],
      [{ name: "APIError", error: { name: "MessageAbortedError" } }, "failed"],
      [{ name: "messageabortederror" }, "failed"],
      [{ name: "AbortError", data: { message: "Transport cancelled" } }, "failed"],
      [{ name: "UnknownError", data: { message: "MessageAbortedError" } }, "failed"],
      [undefined, "failed"],
    ] as const) {
      expect(sessionRunObservation({ payload: { type: "session.error", properties: { sessionID: "session-stop", error } } }))
        .toEqual({ sessionId: "session-stop", status });
    }
  });

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
