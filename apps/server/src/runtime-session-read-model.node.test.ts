import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RuntimeEvent } from "@jugglework/types/agent-runtime";
import type { RuntimeSessionRecord } from "@jugglework/types/runtime-session";
import { buildRuntimeSessionSnapshot } from "./session-read-model.js";

describe("runtime session read model", () => {
  test("projects canonical text, reasoning, attachments, tools and terminal status", () => {
    const record: RuntimeSessionRecord = {
      schemaVersion: 1, id: "ses_1", orgId: "org_1", workspaceId: "ws_1", runtimeKind: "codex", backendThreadId: "thr_1",
      agentProfileId: null, modelProviderId: "gateway", modelId: "model", reasoningEffort: null, cwd: "/workspace", title: "Runtime",
      runtimeLocked: true, configSnapshot: {}, attachments: [], createdAt: 1, updatedAt: 9, archivedAt: null,
    };
    const base = { schemaVersion: 1 as const, workspaceId: "ws_1", orgId: "org_1", runtimeKind: "codex" as const,
      sessionId: "ses_1", threadId: "thr_1", turnId: "turn_1" };
    const events: RuntimeEvent[] = [
      { ...base, eventId: "1", occurredAt: 2, type: "turn.started" },
      { ...base, eventId: "2", occurredAt: 3, type: "user.message", content: [
        { type: "text", text: "describe" },
        { type: "attachment", attachment: { attachmentId: "img", kind: "image", name: "a.png", mimeType: "image/png", sizeBytes: 3, objectRef: "attachment://img" } },
      ] },
      { ...base, eventId: "3", occurredAt: 4, type: "reasoning.delta", text: "think" },
      { ...base, eventId: "4", occurredAt: 5, type: "assistant.delta", text: "hello " },
      { ...base, eventId: "5", occurredAt: 6, type: "assistant.delta", text: "world" },
      { ...base, eventId: "6", occurredAt: 7, type: "tool.started", toolCallId: "tool_1", name: "read", arguments: { path: "README" } },
      { ...base, eventId: "7", occurredAt: 8, type: "tool.completed", toolCallId: "tool_1", success: true, output: "ok" },
      { ...base, eventId: "8", occurredAt: 9, type: "turn.completed" },
    ];
    const snapshot = buildRuntimeSessionSnapshot({ record, events });
    assert.equal(snapshot.session.id, "ses_1");
    assert.equal(snapshot.status.type, "idle");
    assert.equal(snapshot.messages.length, 2);
    assert.equal((snapshot.messages[1]?.parts.find((part) => part.type === "text") as { text?: string }).text, "hello world");
    assert.equal(snapshot.messages[1]?.parts.some((part) => part.type === "reasoning"), true);
    assert.equal(snapshot.messages[1]?.parts.some((part) => part.type === "tool"), true);
  });
});
