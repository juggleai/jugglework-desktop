import { createHash } from "node:crypto";
import {
  agentContinuationContextSchema,
  agentContinuationPreviewSchema,
  type AgentContinuationContext,
  type AgentContinuationOmissions,
  type AgentContinuationPreview,
  type CanonicalSessionSnapshot,
} from "@jugglework/types/agent-runtime";

export const AGENT_CONTINUATION_MAX_CHARACTERS = 120_000;
const AGENT_CONTINUATION_MAX_ENTRY_CHARACTERS = 40_000;
const AGENT_CONTINUATION_MAX_ENTRIES = 64;
const AGENT_CONTINUATION_SUMMARY_RESERVE = 8_000;

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk-ant-|sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export type AgentContinuationErrorCode =
  | "source_busy"
  | "same_runtime"
  | "context_secret"
  | "context_too_large"
  | "context_empty";

export class AgentContinuationError extends Error {
  constructor(public readonly code: AgentContinuationErrorCode, message: string) {
    super(message);
    this.name = "AgentContinuationError";
  }
}

export function containsContinuationSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildAgentContinuationPreview(
  snapshot: CanonicalSessionSnapshot,
  targetRuntimeId: string,
): AgentContinuationPreview {
  if (snapshot.session.status.type !== "idle") {
    throw new AgentContinuationError("source_busy", "The source session must be idle before continuing with another runtime");
  }
  if (snapshot.session.runtimeId === targetRuntimeId) {
    throw new AgentContinuationError("same_runtime", "Cross-runtime continuation requires a different target runtime");
  }

  const omissions: AgentContinuationOmissions = {
    secretBearingText: 0,
    oversizedText: 0,
    attachments: 0,
    tools: 0,
    hiddenOrReasoning: 0,
    pendingInteractions: snapshot.interactions.filter((interaction) => interaction.state === "pending").length,
  };
  const candidates: AgentContinuationContext["transcript"] = [];
  for (const message of snapshot.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    omissions.attachments += message.parts.filter((part) => part.type === "file").length;
    omissions.tools += message.parts.filter((part) => part.type === "tool" || part.type === "agent").length;
    omissions.hiddenOrReasoning += message.parts.filter((part) => part.type === "reasoning" || part.type === "structured" || part.type === "error").length;
    const text = message.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text) continue;
    if (containsContinuationSecret(text)) {
      omissions.secretBearingText += 1;
      continue;
    }
    if (text.length > AGENT_CONTINUATION_MAX_ENTRY_CHARACTERS) omissions.oversizedText += 1;
    candidates.push({ sourceMessageId: message.id, role: message.role, text: text.slice(0, AGENT_CONTINUATION_MAX_ENTRY_CHARACTERS) });
  }

  const transcript: AgentContinuationContext["transcript"] = [];
  let selectedCharacters = 0;
  for (const entry of candidates.slice(-AGENT_CONTINUATION_MAX_ENTRIES).reverse()) {
    const remaining = AGENT_CONTINUATION_MAX_CHARACTERS - AGENT_CONTINUATION_SUMMARY_RESERVE - selectedCharacters;
    if (remaining <= 0) {
      omissions.oversizedText += 1;
      continue;
    }
    const text = entry.text.slice(0, remaining).trim();
    if (text.length < entry.text.length) omissions.oversizedText += 1;
    if (!text) continue;
    transcript.unshift({ ...entry, text });
    selectedCharacters += text.length;
  }
  const safeTitle = containsContinuationSecret(snapshot.session.title) ? "Source session" : snapshot.session.title;
  const summary = generatedSummary(safeTitle, transcript);
  selectedCharacters += summary.length;
  return agentContinuationPreviewSchema.parse({
    sourceSessionId: snapshot.session.id,
    sourceTitle: safeTitle,
    sourceRuntimeId: snapshot.session.runtimeId,
    targetRuntimeId,
    context: { summary, transcript },
    omissions,
    selectedCharacters,
    maxCharacters: AGENT_CONTINUATION_MAX_CHARACTERS,
  });
}

export function validateAgentContinuationContext(value: unknown): AgentContinuationContext {
  const parsed = agentContinuationContextSchema.safeParse(value);
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some((issue) => issue.code === "too_big");
    throw new AgentContinuationError(tooLarge ? "context_too_large" : "context_empty", "Migration context is invalid or exceeds its limit");
  }
  const characters = parsed.data.summary.length + parsed.data.transcript.reduce((total, entry) => total + entry.text.length, 0);
  if (characters > AGENT_CONTINUATION_MAX_CHARACTERS) {
    throw new AgentContinuationError("context_too_large", "Migration context exceeds 120000 characters");
  }
  if (containsContinuationSecret(parsed.data.summary) || parsed.data.transcript.some((entry) => containsContinuationSecret(entry.text))) {
    throw new AgentContinuationError("context_secret", "Migration context contains secret-bearing content");
  }
  return parsed.data;
}

export function digestAgentContinuation(sourceSessionId: string, targetRuntimeId: string, context: AgentContinuationContext): string {
  return createHash("sha256").update(JSON.stringify({ sourceSessionId, targetRuntimeId, context })).digest("hex");
}

function generatedSummary(title: string, transcript: AgentContinuationContext["transcript"]): string {
  const recent = transcript.slice(-4).map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`).join("\n");
  const prefix = `Continue the linked session "${title}" using only the reviewed, attributed text below. The source session remains unchanged. No tool state, pending approvals, hidden prompts, secrets, or attachment contents were transferred.`;
  return `${prefix}${recent ? `\n\nRecent context:\n${recent}` : ""}`.slice(0, 8_000);
}
