import { describe, expect, test } from "bun:test";
import type { MessageWithParts } from "../src/app/types";
import { resolveRedoHistoryStep } from "../src/react-app/domains/session/sync/history-position";

function message(id: string, role: "user" | "assistant"): MessageWithParts {
  return {
    info: { id, role },
    parts: [],
  } as MessageWithParts;
}

const messageID = (value: MessageWithParts) => (value.info as { id?: string }).id ?? "";

describe("resolveRedoHistoryStep", () => {
  test("uses transcript position across regressed rollover ids", () => {
    const oldUser = message("msg_fff100", "user");
    const oldAssistant = message("msg_fff200", "assistant");
    const newUser = message("msg_00d100", "user");
    const newAssistant = message("msg_00d200", "assistant");

    const step = resolveRedoHistoryStep(
      [oldUser, oldAssistant, newUser, newAssistant],
      "msg_fff100",
      messageID,
    );

    expect(step?.next).toBe(newUser);
    expect(step?.prior).toBe(oldUser);
  });

  test("returns an unrevert step when the cursor is the final user turn", () => {
    const oldUser = message("msg_fff100", "user");
    const newUser = message("msg_00d100", "user");

    expect(resolveRedoHistoryStep(
      [oldUser, newUser],
      "msg_00d100",
      messageID,
    )).toEqual({ next: null, prior: null });
  });

  test("does not guess when the exact cursor is absent", () => {
    expect(resolveRedoHistoryStep(
      [message("msg_00d100", "user")],
      "msg_missing",
      messageID,
    )).toBeNull();
  });
});
