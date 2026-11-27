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

const assistantMessage = (id: string, created: number, text: string) => ({
  info: { id, sessionID, role: "assistant", time: { created, completed: created + 1 }, finish: "stop" },
  parts: [{ id: `${id}:text`, sessionID, messageID: id, type: "text", text, time: { start: created, end: created + 1 } }],
});

test("several continuations stay one goal presentation: one task bubble, one assistant group, no repeated tool output", async () => {
  const { groupMessages, isMessageGroup } = await import("../src/components/chat/utils");
  const { transcriptToText } = await import("../src/react-app/domains/session/surface/transcript-text");
  const messages = snapshot([
    userMessage("u1", 1, [goalPart("p1", "u1", "create", "Start working on the goal: Ship CSV export")]),
    assistantMessage("a1", 2, "Wired the export button."),
    userMessage("u2", 3, [goalPart("p2", "u2", "auto", "Continue working on the goal from the latest checkpoint.")]),
    assistantMessage("a2", 4, "Added the header row."),
    userMessage("u3", 5, [goalPart("p3", "u3", "auto", "Continue working on the goal from the latest checkpoint.")]),
    assistantMessage("a3", 6, "Documented the export."),
  ]);
  expect(messages.map((message) => message.id)).toEqual(["u1", "a1", "a2", "a3"]);

  const items = groupMessages(messages, "idle" as never);
  const userBubbles = items.filter((item) => !isMessageGroup(item));
  const groups = items.filter(isMessageGroup);
  expect(userBubbles).toHaveLength(1);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.messages).toHaveLength(3);

  // Copy and export read the same presentation, so internal requests never show up in them.
  const copied = transcriptToText(messages);
  expect(copied.match(/^You$/gm)).toHaveLength(1);
  expect(copied).not.toContain("Continue working on the goal from the latest checkpoint.");
  for (const text of ["Wired the export button.", "Added the header row.", "Documented the export."]) {
    expect(copied.split(text)).toHaveLength(2);
  }
});

test("a continuation that follows a real user message does not merge that message away", async () => {
  const { groupMessages, isMessageGroup } = await import("../src/components/chat/utils");
  const messages = snapshot([
    userMessage("u1", 1, [goalPart("p1", "u1", "create", "Start working on the goal: Ship CSV export")]),
    assistantMessage("a1", 2, "Wired the export button."),
    userMessage("u2", 3, [{ id: "p2", sessionID, messageID: "u2", type: "text", text: "Use semicolons", time: { start: 3, end: 3 } }]),
    assistantMessage("a2", 4, "Switched to semicolons."),
    userMessage("u3", 5, [goalPart("p3", "u3", "auto", "Continue working on the goal from the latest checkpoint.")]),
    assistantMessage("a3", 6, "Documented the export."),
  ]);
  const items = groupMessages(messages, "idle" as never);
  expect(items.filter((item) => !isMessageGroup(item))).toHaveLength(2);
  expect(items.filter(isMessageGroup).map((group) => group.messages.length)).toEqual([1, 2]);
});
