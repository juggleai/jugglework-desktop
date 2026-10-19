import { expect, test } from "bun:test";
import { hasCurrentRunFinalResponse } from "./session-completion-evidence.js";

const message = (created: number, finish: string, extra = {}) => ({
  info: { role: "assistant", finish, time: { created, completed: created + 1 }, ...extra },
});

test("only the latest current-run successful final response proves completion", () => {
  expect(hasCurrentRunFinalResponse([message(10, "stop")], 20)).toBe(false);
  expect(hasCurrentRunFinalResponse([message(30, "tool-calls")], 20)).toBe(false);
  expect(hasCurrentRunFinalResponse([message(30, "stop", { summary: true })], 20)).toBe(false);
  expect(hasCurrentRunFinalResponse([message(30, "stop", { error: { name: "AbortError" } })], 20)).toBe(false);
  expect(hasCurrentRunFinalResponse([message(40, "tool-calls"), message(30, "stop")], 20)).toBe(false);
  expect(hasCurrentRunFinalResponse([message(30, "stop")], 20)).toBe(true);
  expect(hasCurrentRunFinalResponse(null, 20)).toBe(false);
});
