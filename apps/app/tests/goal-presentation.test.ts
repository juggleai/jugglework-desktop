import { expect, test } from "bun:test";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import { isGoalContinuationPart } from "../src/react-app/domains/session/sync/usechat-adapter";
import { promptSuggestionUserHistory } from "../src/react-app/domains/session/surface/prompt-suggestions-history";

const sessionID = "ses_goal";
const goalPart = (id: string, messageID: string, trigger: string, text: string) => ({
  id, sessionID, messageID, type: "text", text,
  metadata: { jugglework_goal: { goalId: "goal_1", ordinal: trigger === "create" ? 1 : 2, trigger } },
  time: { start: 1, end: 1 },
});
const userMessage = (id: string, created: number, parts: unknown[]) => ({ info: { id, sessionID, role: "user", time: { created } }, parts });
const snapshot = (messages: unknown[]) => snapshotToUIMessages({ session: { id: sessionID } as Session, messages, status: { type: "idle" }, todos: [] } as never);

test("a goal continuation request is hidden from the task transcript; the creation request stays", () => {
  const messages = snapshot([
    userMessage("m1", 1, [goalPart("p1", "m1", "create", "Start working on the goal: Ship CSV export")]),
    userMessage("m2", 2, [goalPart("p2", "m2", "user_continue", "Continue working on the goal from the latest checkpoint.")]),
    userMessage("m3", 3, [{ id: "p3", sessionID, messageID: "m3", type: "text", text: "Also add a header row", time: { start: 3, end: 3 } }]),
  ]);
  expect(messages.map((message) => message.id)).toEqual(["m1", "m3"]);
  expect(messages[0]!.parts[0]).toMatchObject({ type: "text", text: "Start working on the goal: Ship CSV export" });
});

test("an ordinary message that looks like a continuation is not treated as one", () => {
  const lookalike = { id: "p", sessionID, messageID: "m", type: "text", text: "Continue working on the goal from the latest checkpoint." };
  expect(isGoalContinuationPart(lookalike as never)).toBe(false);
  expect(snapshot([userMessage("m", 1, [lookalike])]).map((message) => message.id)).toEqual(["m"]);
  expect(isGoalContinuationPart(goalPart("p", "m", "create", "x") as never)).toBe(false);
  expect(isGoalContinuationPart(goalPart("p", "m", "user_continue", "x") as never)).toBe(true);
});

test("a continuation message that also holds real user content keeps that content visible", () => {
  const messages = snapshot([userMessage("m", 1, [
    goalPart("p1", "m", "user_continue", "Continue working on the goal from the latest checkpoint."),
    { id: "p2", sessionID, messageID: "m", type: "text", text: "Prefer semicolons", time: { start: 1, end: 1 } },
  ])]);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.parts.map((part) => (part as { text?: string }).text)).toEqual(["Prefer semicolons"]);
});

test("prompt suggestions ignore goal continuation requests", () => {
  const goalOnly = [userMessage("m2", 200, [goalPart("p2", "m2", "user_continue", "Continue working on the goal from the latest checkpoint.")])];
  const real = userMessage("m3", 300, [{ id: "p3", sessionID, messageID: "m3", type: "text", text: "Also add a header row", time: { start: 3, end: 3 } }]);
  // A continuation alone is not user evidence; with a real message the baseline is that message's time.
  expect(promptSuggestionUserHistory(goalOnly as never).userCreatedAtBaseline).not.toBe(200);
  expect(promptSuggestionUserHistory([...goalOnly, real] as never).userCreatedAtBaseline).toBe(300);
  expect(promptSuggestionUserHistory([real, ...goalOnly.map((message) => ({ ...message, info: { ...message.info, time: { created: 400 } } }))] as never).userCreatedAtBaseline).toBe(300);
});
