import { declaresBlockingConfirmation } from "./jugglework-confirmation-gate-policy.js";

type TextCompleteInput = {
  sessionID: string;
  messageID: string;
  partID: string;
};

type ToolInput = {
  tool: string;
  sessionID: string;
  callID: string;
};

type EventEnvelope = {
  type?: unknown;
  properties?: unknown;
};

type UserPart = {
  synthetic?: unknown;
  ignored?: unknown;
};

function repliedQuestionSession(event: EventEnvelope): string | null {
  if (event.type !== "question.replied" && event.type !== "question.v2.replied") return null;
  if (!event.properties || typeof event.properties !== "object" || Array.isArray(event.properties)) return null;
  const properties = event.properties as Record<string, unknown>;
  return typeof properties.sessionID === "string" && properties.sessionID ? properties.sessionID : null;
}

function hasGenuineUserPart(parts: UserPart[]): boolean {
  return parts.some((part) => part.synthetic !== true && part.ignored !== true);
}

/**
 * Defense in depth for models that announce a blocking confirmation in prose
 * and then try to continue in the same turn. The structured question tool is
 * the authoritative waiting mechanism; ordinary text never is.
 */
export const JuggleWorkConfirmationGate = async () => {
  const blockedSessions = new Map<string, { messageID: string; partID: string }>();

  return {
    "chat.message": async (input: { sessionID: string }, output: { parts: UserPart[] }) => {
      // A genuine new user turn is the fallback answer path when the model had
      // to end its turn because the structured question tool was unavailable.
      // Compaction and other synthetic continuation turns must not bypass it.
      if (hasGenuineUserPart(output.parts)) blockedSessions.delete(input.sessionID);
    },

    "experimental.text.complete": async (input: TextCompleteInput, output: { text: string }) => {
      if (!declaresBlockingConfirmation(output.text)) return;
      blockedSessions.set(input.sessionID, { messageID: input.messageID, partID: input.partID });
    },

    event: async (input: { event: EventEnvelope }) => {
      const sessionID = repliedQuestionSession(input.event);
      if (sessionID) blockedSessions.delete(sessionID);
    },

    "tool.execute.before": async (input: ToolInput) => {
      if (input.tool === "question" || !blockedSessions.has(input.sessionID)) return;
      throw new Error(
        "jugglework_user_confirmation_required: this turn said user confirmation is required; call the question tool and wait for its answer, or end the turn without calling more tools",
      );
    },
  };
};
