import type { UIMessage } from "ai";

import { SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX } from "@/app/types";

type CompletionTodo = {
  content: string;
  status: string;
  priority: string;
};

export type RunCompletionDiagnostic = {
  message: UIMessage;
  finishReason: string;
  incomplete: boolean;
  unverified: boolean;
  anomalousEmptyTurn: boolean;
};

const FILE_MUTATION_TOOLS = new Set(["apply_patch", "edit", "write"]);
const VERIFICATION_COMMAND_RE = /(?:^|[\s;&|])(?:bun|deno|go|npm|pnpm|yarn|npx|cargo|dotnet|gradle|mvn|python|python3|pytest|ruby|rspec|swift)\b[^\n]*(?:\btest\b|\bbuild\b|\bcheck\b|\btypecheck\b|\blint\b|\bcompile\b)|(?:^|[\s;&|])(?:pytest|vitest|jest|mocha|tsc|eslint|ruff|mypy|make|cmake|xcodebuild)\b/i;

function opencodeMetadata(message: UIMessage): Record<string, unknown> {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return {};
  const opencode = (metadata as { opencode?: unknown }).opencode;
  return opencode && typeof opencode === "object" ? opencode as Record<string, unknown> : {};
}

function isSyntheticDiagnostic(message: UIMessage) {
  return message.id.startsWith(SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX);
}

function hasVisibleOutput(message: UIMessage) {
  return message.parts.some((part) => {
    if ((part.type === "text" || part.type === "reasoning") && part.text.trim()) return true;
    return part.type === "dynamic-tool" || part.type === "file" || part.type === "source-url" || part.type === "source-document";
  });
}

function successfulTool(part: UIMessage["parts"][number]) {
  return part.type === "dynamic-tool" && part.state === "output-available";
}

function normalizedToolName(part: Extract<UIMessage["parts"][number], { type: "dynamic-tool" }>) {
  return part.toolName.trim().toLowerCase().replace(/^functions\./, "");
}

function isFileMutation(part: UIMessage["parts"][number]) {
  return successfulTool(part) && FILE_MUTATION_TOOLS.has(normalizedToolName(part));
}

function isVerification(part: UIMessage["parts"][number]) {
  if (!successfulTool(part)) return false;
  const toolName = normalizedToolName(part);
  if (/^(?:test|build|compile|typecheck|lint)$/.test(toolName)) return true;
  if (toolName !== "bash") return false;
  const input = part.input && typeof part.input === "object" ? part.input as Record<string, unknown> : {};
  const command = typeof input.command === "string" ? input.command : "";
  return VERIFICATION_COMMAND_RE.test(command);
}

function currentTurn(messages: UIMessage[]) {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return null;
  const user = messages[latestUserIndex]!;
  const messagesAfterUser = messages
    .slice(latestUserIndex + 1)
    .filter((message) => !isSyntheticDiagnostic(message));
  const assistants = messagesAfterUser.filter((message) => message.role === "assistant");
  const terminalAssistant = assistants[assistants.length - 1];
  if (!terminalAssistant) return null;
  return { user, messagesAfterUser, terminalAssistant };
}

export function runDiagnosticMessageId(userMessageId: string) {
  return `${SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX}${userMessageId}`;
}

export function analyzeRunCompletion(
  messages: UIMessage[],
  todos: CompletionTodo[],
  options: { finishReason?: string | null } = {},
): RunCompletionDiagnostic | null {
  const turn = currentTurn(messages);
  if (!turn) return null;

  const tools = turn.messagesAfterUser.flatMap((message) => message.parts.filter((part) => part.type === "dynamic-tool"));
  const lastMutationIndex = tools.findLastIndex(isFileMutation);
  const changedFiles = lastMutationIndex >= 0;
  const verified = changedFiles && tools.slice(lastMutationIndex + 1).some(isVerification);
  const unverified = changedFiles && !verified;
  const terminalIsEmpty = turn.terminalAssistant.parts.length === 0 || !hasVisibleOutput(turn.terminalAssistant);
  const priorAssistantHadMutation = turn.messagesAfterUser.some(
    (message) => message !== turn.terminalAssistant && message.parts.some(isFileMutation),
  );
  const anomalousEmptyTurn = terminalIsEmpty && priorAssistantHadMutation;
  const openTodos = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
  const explicitFinishReason = options.finishReason?.trim() || null;
  const abnormalFinish = Boolean(explicitFinishReason && explicitFinishReason !== "stop");
  const incomplete = openTodos.length > 0 || anomalousEmptyTurn || unverified || abnormalFinish;
  if (!incomplete) return null;

  const metadata = opencodeMetadata(turn.terminalAssistant);
  const providerFinish = typeof metadata.finish === "string" && metadata.finish.trim()
    ? metadata.finish.trim()
    : "stop";
  const finishReason = anomalousEmptyTurn ? "tool_loop_terminated" : explicitFinishReason ?? providerFinish;
  const lines = ["Task incomplete.", `finish_reason: ${finishReason}`];
  if (openTodos.length > 0) {
    lines.push(`${openTodos.length} todo item${openTodos.length === 1 ? " remains" : "s remain"} pending or in progress.`);
  }
  if (anomalousEmptyTurn) {
    lines.push("A successful file modification was followed by an empty assistant turn; this was treated as an abnormal end.");
  }
  if (unverified) {
    lines.push("Changes applied but not verified");
  }

  const id = runDiagnosticMessageId(turn.user.id);
  return {
    finishReason,
    incomplete,
    unverified,
    anomalousEmptyTurn,
    message: {
      id,
      role: "assistant",
      metadata: {
        opencode: {
          created: Date.now(),
          finish: finishReason,
          syntheticRunDiagnostic: true,
        },
      },
      parts: [{
        type: "text",
        text: lines.join("\n"),
        state: "done",
        providerMetadata: { opencode: { partId: `${id}:text` } },
      }],
    },
  };
}

export function reconcileRunCompletionDiagnostic(
  messages: UIMessage[],
  todos: CompletionTodo[],
  options: { finishReason?: string | null } = {},
) {
  // Completion diagnostics are structured session state, not assistant output.
  // Strip any diagnostics produced by older builds before grouping assistant
  // messages so a synthetic warning cannot displace the real final summary.
  const withoutDiagnostics = messages.filter((message) => !isSyntheticDiagnostic(message));
  const diagnostic = analyzeRunCompletion(withoutDiagnostics, todos, options);
  return {
    messages: withoutDiagnostics,
    diagnostic,
  };
}
