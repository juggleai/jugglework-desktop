import { expect, test } from "bun:test";
import { currentRunTerminalStatus, hasCurrentRunFinalResponse } from "./session-completion-evidence.js";

const message = (created: number, finish: string, extra = {}) => ({
  info: { role: "assistant", finish, time: { created, completed: created + 1 }, ...extra },
});

test("本轮最新 assistant 明确失败不需要 completed 时间，旧错误和非顶层错误不构成终态", () => {
  const failed = { info: { role: "assistant", time: { created: 30 }, error: { name: "APIError" } } };
  expect(currentRunTerminalStatus([failed], 20)).toBe("failed");
  expect(currentRunTerminalStatus([{ info: { ...failed.info, error: { name: "MessageAbortedError" } } }], 20)).toBe("aborted");
  expect(currentRunTerminalStatus([{ info: { ...failed.info, error: { name: "AbortError", data: { name: "MessageAbortedError" } } } }], 20)).toBe("failed");
  expect(currentRunTerminalStatus([failed], 40)).toBeNull();
  expect(currentRunTerminalStatus([failed, message(40, "tool-calls")], 20)).toBeNull();
  expect(currentRunTerminalStatus([{ info: { ...failed.info, summary: true } }], 20)).toBeNull();
  expect(currentRunTerminalStatus([{ info: { role: "assistant", time: { created: 30 } }, parts: [{ error: { name: "APIError" } }] }], 20)).toBeNull();
  expect(hasCurrentRunFinalResponse([failed], 20)).toBe(false);
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

test("本轮原生权限拒绝且全部工具结束可证明取消，普通工具错误和未完成工具不构成终态", () => {
  const rejected = { type: "tool", state: { status: "error", error: "The user rejected permission to use this specific tool call.", time: { end: 32 } } };
  const latest = { ...message(30, "tool-calls"), parts: [rejected] };
  expect(currentRunTerminalStatus([latest], 20)).toBe("aborted");
  expect(hasCurrentRunFinalResponse([latest], 20)).toBe(false);
  expect(currentRunTerminalStatus([{ ...latest, parts: [{ ...rejected, state: { ...rejected.state, error: "Command failed" } }] }], 20)).toBeNull();
  expect(currentRunTerminalStatus([{ ...latest, parts: [rejected, { type: "tool", state: { status: "running" } }] }], 20)).toBeNull();
  expect(currentRunTerminalStatus([{ ...latest, parts: [{ ...rejected, state: { ...rejected.state, time: { end: 19 } } }] }], 20)).toBeNull();
  expect(currentRunTerminalStatus([latest, message(40, "tool-calls")], 20)).toBeNull();
  expect(currentRunTerminalStatus([latest], 40)).toBeNull();
});
