import type { TodoItem } from "@/app/types";

export type TaskProgressKind = "empty" | "open" | "terminal";

export function classifyTaskProgress(todos: TodoItem[]): TaskProgressKind {
  const visible = todos.filter((todo) => todo.content.trim());
  if (visible.length === 0) return "empty";
  return visible.every((todo) => todo.status === "completed" || todo.status === "cancelled")
    ? "terminal"
    : "open";
}

export function shouldShowTaskProgress(input: {
  kind: TaskProgressKind;
  runActive: boolean;
  terminalAcknowledgement: boolean;
}): boolean {
  if (input.kind === "empty") return false;
  if (input.kind === "open") return true;
  return input.runActive || input.terminalAcknowledgement;
}

export function shouldAcknowledgeTerminalProgress(input: {
  runJustEnded: boolean;
  terminalJustArrivedAfterRunEnd: boolean;
  kind: TaskProgressKind;
}): boolean {
  return input.kind === "terminal" && (
    input.runJustEnded || input.terminalJustArrivedAfterRunEnd
  );
}

export function shouldSynthesizeBusyAfterAcceptance(input: {
  runGenerationBeforeSend: number;
  activityAfterSend: SessionActivityRecord | undefined;
}): boolean {
  return (input.activityAfterSend?.runGeneration ?? 0) <= input.runGenerationBeforeSend;
}
import type { SessionActivityRecord } from "@/react-app/domains/session/status/session-activity-store";
