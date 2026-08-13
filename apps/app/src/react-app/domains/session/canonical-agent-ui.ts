import type { UIMessage } from "ai";
import type {
  CanonicalAgentMessage,
  CanonicalAgentPart,
  CanonicalInteraction,
  CanonicalSessionSnapshot,
} from "@jugglework/types/agent-runtime";

import type { PendingPermission, PendingQuestion, TodoItem } from "@/app/types";

function canonicalPartToUi(part: CanonicalAgentPart, interactions: CanonicalInteraction[]): UIMessage["parts"] {
  const interaction = part.type === "tool" ? interactions.find((item) => (
    item.metadata?.toolCallId === part.toolCallId || item.metadata?.toolPartId === part.id
  )) : undefined;
  const providerMetadata = { canonical: {
    partId: part.id,
    ...(interaction ? { interactionId: interaction.id, interactionState: interaction.state, outcome: interaction.resolution?.outcome } : {}),
  } };
  if (part.type === "text") {
    return [{ type: "text", text: part.text, state: part.state === "complete" ? "done" : "streaming", providerMetadata }];
  }
  if (part.type === "reasoning") {
    if (part.visibility === "hidden") return [];
    return [{ type: "reasoning", text: part.text, state: part.state === "complete" ? "done" : "streaming", providerMetadata }];
  }
  if (part.type === "tool") {
    if (part.state === "error") {
      return [{
        type: "dynamic-tool",
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        state: "output-error",
        input: part.input ?? {},
        errorText: part.error ?? "Tool failed",
        callProviderMetadata: providerMetadata,
      }];
    }
    if (part.state === "cancelled") {
      return [{
        type: "dynamic-tool",
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        state: "output-error",
        input: part.input ?? {},
        errorText: part.error ?? (interaction?.resolution?.outcome === "deny" ? "Tool denied" : "Tool cancelled"),
        callProviderMetadata: providerMetadata,
      }];
    }
    if (part.state === "completed") {
      return [{
        type: "dynamic-tool",
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        state: "output-available",
        input: part.input ?? {},
        output: part.output ?? null,
        callProviderMetadata: providerMetadata,
      }];
    }
    return [{
      type: "dynamic-tool",
      toolName: part.toolName,
      toolCallId: part.toolCallId,
        state: interaction?.state === "pending" || part.state === "waiting" || part.state === "pending" ? "input-available" : "input-streaming",
      input: part.input ?? {},
      callProviderMetadata: providerMetadata,
    }];
  }
  if (part.type === "file") {
    return [{
      type: "file",
      url: part.uri ?? `file://${part.workspacePath}`,
      filename: part.name,
      mediaType: part.mime ?? "application/octet-stream",
      providerMetadata,
    }];
  }
  if (part.type === "agent") {
    const metadata = part.metadata ?? {};
    const usage = metadata.usage && typeof metadata.usage === "object" && !Array.isArray(metadata.usage)
      ? metadata.usage as Record<string, string | number | boolean | null> : null;
    const description = typeof metadata.description === "string" ? metadata.description : undefined;
    const summary = typeof metadata.summary === "string" ? metadata.summary : undefined;
    const backendTaskId = typeof metadata.backendTaskId === "string" ? metadata.backendTaskId : undefined;
    const base = {
      type: "dynamic-tool",
      toolName: "claude_subagent",
      toolCallId: part.agentId,
      input: {
        label: part.label ?? part.agentId,
        ...(description ? { description } : {}),
        ...(part.parentToolCallId ? { parentToolCallId: part.parentToolCallId } : {}),
      },
      callProviderMetadata: { canonical: {
        ...providerMetadata.canonical,
        agentId: part.agentId,
        ...(backendTaskId ? { backendTaskId } : {}),
        ...(part.parentToolCallId ? { parentToolCallId: part.parentToolCallId } : {}),
        ...(usage ? { usage } : {}),
        summary,
        stoppable: metadata.stoppable === true,
      } },
    } as const;
    if (part.state === "completed") {
      return [{ ...base, state: "output-available", output: { summary: summary ?? "Completed", ...(usage ? { usage } : {}) } }];
    }
    if (part.state === "error" || part.state === "cancelled") {
      return [{ ...base, state: "output-error", errorText: part.state === "error" ? "Subagent failed" : "Subagent stopped" }];
    }
    return [{ ...base, state: "input-streaming" }];
  }
  if (part.type === "structured") {
    return [{ type: "text", text: JSON.stringify(part.value, null, 2), state: "done", providerMetadata }];
  }
  return [{ type: "text", text: part.message, state: "done", providerMetadata }];
}

function canonicalMessageToUi(message: CanonicalAgentMessage, interactions: CanonicalInteraction[]): UIMessage {
  return {
    id: message.id,
    role: message.role,
    metadata: { canonical: { created: message.createdAt, completed: message.completedAt ?? undefined } },
    parts: message.parts.flatMap((part) => canonicalPartToUi(part, interactions)),
  };
}

export function canonicalSnapshotToUIMessages(snapshot: CanonicalSessionSnapshot): UIMessage[] {
  const messages = snapshot.messages.map((message) => canonicalMessageToUi(message, snapshot.interactions));
  if (!snapshot.session.lastError) return messages;
  const id = `canonical-error:${snapshot.session.id}:${snapshot.session.updatedAt}:${snapshot.session.lastError.code}`;
  return [...messages, {
    id,
    role: "assistant",
    metadata: { canonical: { created: snapshot.session.updatedAt } },
    parts: [{
      type: "text",
      text: snapshot.session.lastError.message,
      state: "done",
      providerMetadata: { canonical: { partId: `${id}:text`, errorCode: snapshot.session.lastError.code } },
    }],
  }];
}

export function canonicalTodosToUi(snapshot: CanonicalSessionSnapshot): TodoItem[] {
  return snapshot.todos.map((todo) => ({ ...todo }));
}

export function canonicalPermissionToUi(interaction: CanonicalInteraction): PendingPermission | null {
  if (interaction.kind !== "permission" || interaction.state !== "pending") return null;
  const input = interaction.input && typeof interaction.input === "object" && !Array.isArray(interaction.input)
    ? interaction.input as Record<string, unknown>
    : {};
  return {
    id: interaction.id,
    sessionID: interaction.sessionId,
    permission: interaction.toolName ?? "tool",
    patterns: [],
    metadata: { ...input, description: interaction.description, tool: interaction.toolName },
    always: [],
    receivedAt: interaction.requestedAt,
    protocol: "legacy",
  } as PendingPermission;
}

export function canonicalQuestionToUi(interaction: CanonicalInteraction): PendingQuestion | null {
  if (interaction.kind !== "question" || interaction.state !== "pending" || !interaction.questions?.length) return null;
  return {
    id: interaction.id,
    sessionID: interaction.sessionId,
    questions: interaction.questions.map((question) => ({
      header: interaction.title,
      question: question.prompt,
      options: (question.options ?? []).map((option) => ({ label: option, description: "" })),
      multiple: question.multiple,
      custom: true,
    })),
    receivedAt: interaction.requestedAt,
  } as PendingQuestion;
}

export function latestCanonicalRunError(snapshot: CanonicalSessionSnapshot | null | undefined): string | null {
  if (!snapshot) return null;
  if (snapshot.session.status.type === "unavailable" || snapshot.session.status.type === "interrupted") {
    return snapshot.session.status.message;
  }
  return snapshot.session.lastError?.message ?? null;
}

export function requiresAmbiguousRetryConfirmation(snapshot: CanonicalSessionSnapshot | null | undefined): boolean {
  return snapshot?.session.status.type === "interrupted" && snapshot.session.status.ambiguous;
}

export function confirmAmbiguousRetry(
  snapshot: CanonicalSessionSnapshot | null | undefined,
  confirm: (message: string) => boolean,
): boolean {
  if (!requiresAmbiguousRetryConfirmation(snapshot)) return true;
  return confirm(
    "The previous Claude turn was interrupted after a tool may have changed external state. "
    + "Verify the result first. Retry this turn anyway?",
  );
}
