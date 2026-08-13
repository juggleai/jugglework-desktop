import { describe, expect, test } from "bun:test";
import type { CanonicalAgentMessage, CanonicalAgentPart, CanonicalSessionSnapshot } from "@jugglework/types/agent-runtime";

import {
  AGENT_CONTINUATION_MAX_CHARACTERS,
  AgentContinuationError,
  buildAgentContinuationPreview,
  containsContinuationSecret,
  digestAgentContinuation,
  validateAgentContinuationContext,
} from "./agent-runtime-continuation.js";

const NOW = Date.parse("2026-08-13T00:00:00Z");

describe("cross-runtime continuation context", () => {
  test("selects only bounded attributed user/assistant text and excludes tools, hidden state, attachments, pending interactions, and secrets", () => {
    const snapshot = fixtureSnapshot([
      message("user-safe", "user", [textPart("user-safe", "Please continue the implementation."), filePart("user-safe")]),
      message("assistant-safe", "assistant", [
        textPart("assistant-safe", "The API design is ready."),
        toolPart("assistant-safe"),
        reasoningPart("assistant-safe"),
      ]),
      message("user-secret", "user", [textPart("user-secret", "api_key=sk-ant-this-must-never-migrate")]),
      message("system-hidden", "system", [textPart("system-hidden", "hidden system prompt")]),
    ], [{
      id: "pending",
      sessionId: "source",
      runId: "run",
      kind: "permission",
      state: "pending",
      title: "Approve?",
      toolName: "bash",
      requestedAt: NOW,
      deadlineAt: NOW + 1_000,
      resolvedAt: null,
      resolution: null,
    }]);

    const preview = buildAgentContinuationPreview(snapshot, "claude-agent");

    expect(preview.context.transcript).toEqual([
      { sourceMessageId: "user-safe", role: "user", text: "Please continue the implementation." },
      { sourceMessageId: "assistant-safe", role: "assistant", text: "The API design is ready." },
    ]);
    expect(preview.omissions).toEqual({
      secretBearingText: 1,
      oversizedText: 0,
      attachments: 1,
      tools: 1,
      hiddenOrReasoning: 1,
      pendingInteractions: 1,
    });
    expect(JSON.stringify(preview)).not.toContain("sk-ant-");
    expect(JSON.stringify(preview)).not.toContain("README.md");
    expect(JSON.stringify(preview)).not.toContain("tool output");
    expect(JSON.stringify(preview)).not.toContain("hidden system prompt");
  });

  test("bounds oversized entries and total selected context", () => {
    const messages = Array.from({ length: 80 }, (_, index) => message(`message-${index}`, index % 2 ? "assistant" : "user", [
      textPart(`message-${index}`, `${index}: ${"x".repeat(50_000)}`),
    ]));
    const preview = buildAgentContinuationPreview(fixtureSnapshot(messages), "claude-agent");
    const selected = preview.context.transcript.reduce((total, entry) => total + entry.text.length, 0);
    expect(preview.context.transcript.length).toBeLessThanOrEqual(64);
    expect(selected).toBeLessThanOrEqual(AGENT_CONTINUATION_MAX_CHARACTERS);
    expect(preview.omissions.oversizedText).toBeGreaterThan(0);
  });

  test("requires an idle source and a different target runtime", () => {
    expect(() => buildAgentContinuationPreview(fixtureSnapshot([], [], "running"), "claude-agent"))
      .toThrow(new AgentContinuationError("source_busy", "The source session must be idle before continuing with another runtime"));
    expect(() => buildAgentContinuationPreview(fixtureSnapshot([]), "jugglework"))
      .toThrow(new AgentContinuationError("same_runtime", "Cross-runtime continuation requires a different target runtime"));
  });

  test("rejects secrets or oversized edits and produces a stable source-bound digest", () => {
    const safe = { summary: "Continue reviewed work", transcript: [{ role: "user" as const, text: "Implement the API" }] };
    expect(containsContinuationSecret("Authorization: Bearer abcdefghijklmnop")).toBe(true);
    expect(() => validateAgentContinuationContext({ ...safe, summary: "password=very-secret-value" }))
      .toThrow(new AgentContinuationError("context_secret", "Migration context contains secret-bearing content"));
    expect(() => validateAgentContinuationContext({ summary: "x".repeat(8_001), transcript: [] }))
      .toThrow(AgentContinuationError);
    expect(digestAgentContinuation("source", "claude-agent", safe)).toMatch(/^[a-f0-9]{64}$/);
    expect(digestAgentContinuation("source", "claude-agent", safe)).not.toBe(digestAgentContinuation("other", "claude-agent", safe));
  });
});

function fixtureSnapshot(
  messages: CanonicalAgentMessage[],
  interactions: CanonicalSessionSnapshot["interactions"] = [],
  status: CanonicalSessionSnapshot["session"]["status"]["type"] = "idle",
): CanonicalSessionSnapshot {
  return {
    schemaVersion: 1,
    session: {
      id: "source",
      workspaceId: "workspace",
      runtimeId: "jugglework",
      backendSessionId: "backend",
      title: "Source session",
      canonicalCwd: "/workspace",
      status: status === "idle" ? { type: "idle" } : { type: status as "running" },
      configuration: {},
      createdAt: NOW,
      updatedAt: NOW,
      lastError: null,
    },
    messages,
    todos: [],
    interactions,
    latestSequence: 0,
  };
}

function message(id: string, role: CanonicalAgentMessage["role"], parts: CanonicalAgentPart[]): CanonicalAgentMessage {
  return { id, sessionId: "source", role, parentId: null, createdAt: NOW, completedAt: NOW, parts };
}

function basePart(messageId: string, id: string, ordinal = 0) {
  return { id, messageId, sessionId: "source", ordinal, createdAt: NOW, updatedAt: NOW };
}

function textPart(messageId: string, text: string): CanonicalAgentPart {
  return { ...basePart(messageId, `${messageId}:text`), type: "text", text, state: "complete" };
}

function filePart(messageId: string): CanonicalAgentPart {
  return { ...basePart(messageId, `${messageId}:file`, 1), type: "file", name: "README.md", workspacePath: "README.md" };
}

function toolPart(messageId: string): CanonicalAgentPart {
  return { ...basePart(messageId, `${messageId}:tool`, 1), type: "tool", toolCallId: "tool-call", toolName: "bash", state: "completed", output: "tool output" };
}

function reasoningPart(messageId: string): CanonicalAgentPart {
  return { ...basePart(messageId, `${messageId}:reasoning`, 2), type: "reasoning", text: "hidden chain", visibility: "hidden", state: "complete" };
}
