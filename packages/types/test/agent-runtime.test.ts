import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  parseRuntimeEvent,
  runtimeCapabilitiesSchema,
  runtimeErrorSchema,
  runtimeEventSchema,
} from "../src/agent-runtime.ts"

const base = {
  schemaVersion: 1,
  eventId: "evt_1",
  occurredAt: 1_723_456_789_000,
  workspaceId: "ws_1",
  orgId: "org_1",
  sessionId: "jws_1",
  runtimeKind: "codex",
  threadId: "thr_1",
  turnId: "turn_1",
} as const

describe("agent runtime contracts", () => {
  test("round-trips representative content, reasoning, tool, command, file, approval, usage and terminal events", () => {
    const events = [
      {
        schemaVersion: 1,
        eventId: "evt_thread_created",
        occurredAt: base.occurredAt,
        workspaceId: base.workspaceId,
        orgId: base.orgId,
        runtimeKind: base.runtimeKind,
        type: "thread.created",
        thread: {
          id: "thr_1",
          orgId: base.orgId,
          sessionId: base.sessionId,
          workspaceId: base.workspaceId,
          backendThreadId: "backend_thr_1",
          runtimeKind: base.runtimeKind,
          modelProviderId: "jugglework",
          modelId: "gpt-5.6-terra",
          createdAt: base.occurredAt,
        },
      },
      {
        schemaVersion: 1,
        eventId: "evt_thread_updated",
        occurredAt: base.occurredAt,
        workspaceId: base.workspaceId,
        orgId: base.orgId,
        runtimeKind: base.runtimeKind,
        sessionId: base.sessionId,
        threadId: base.threadId,
        type: "thread.updated",
        patch: { title: "Updated title" },
      },
      {
        ...base,
        type: "user.message",
        content: [
          { type: "text", text: "hello" },
          {
            type: "attachment",
            attachment: {
              attachmentId: "att_1",
              kind: "image",
              name: "screen.png",
              mimeType: "image/png",
              sizeBytes: 1024,
              objectRef: "objects/att_1",
            },
          },
        ],
      },
      { ...base, type: "assistant.delta", text: "answer" },
      { ...base, type: "reasoning.delta", text: "summary" },
      { ...base, type: "tool.started", toolCallId: "tool_1", name: "search", arguments: { q: "x" } },
      { ...base, type: "tool.output", toolCallId: "tool_1", chunk: "result" },
      { ...base, type: "tool.completed", toolCallId: "tool_1", success: true, output: { count: 1 } },
      { ...base, type: "command.started", commandId: "cmd_1", command: "git status", cwd: "/workspace" },
      { ...base, type: "command.output", commandId: "cmd_1", chunk: "clean" },
      { ...base, type: "command.completed", commandId: "cmd_1", exitCode: 0, durationMs: 12 },
      { ...base, type: "file.changed", path: "/workspace/a.ts", change: "modified" },
      {
        ...base,
        type: "approval.requested",
        request: {
          id: "approval_1",
          kind: "command",
          title: "Run tests",
          description: "Execute the project test suite",
          choices: ["allow_once", "deny"],
        },
      },
      { ...base, type: "usage.updated", usage: { inputTokens: 10, outputTokens: 5 } },
      { ...base, type: "turn.completed" },
      { ...base, type: "turn.interrupted" },
      {
        ...base,
        type: "turn.failed",
        error: { code: "gateway_auth_expired", message: "Sign in again", retryable: true },
      },
    ]

    for (const event of events) {
      const parsed = runtimeEventSchema.parse(event)
      assert.deepEqual(runtimeEventSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed)
    }
  })

  test("keeps unknown event diagnostics without leaking the backend payload", () => {
    const parsed = parseRuntimeEvent({
      ...base,
      type: "vendor.experimental.delta",
      secretBackendPayload: { token: "must-not-cross-the-contract" },
    })
    assert.deepEqual(parsed, {
      schemaVersion: 1,
      eventId: "evt_1",
      occurredAt: 1_723_456_789_000,
      workspaceId: "ws_1",
      orgId: "org_1",
      runtimeKind: "codex",
      type: "unknown",
      originalType: "vendor.experimental.delta",
      diagnostic: { reason: "unsupported_type" },
    })
    assert.equal(JSON.stringify(parsed).includes("must-not-cross"), false)
  })

  test("converts malformed known events to invalid-payload diagnostics", () => {
    const parsed = parseRuntimeEvent({ ...base, type: "assistant.delta", text: 42 })
    assert.equal(parsed.type, "unknown")
    if (parsed.type === "unknown") {
      assert.equal(parsed.originalType, "assistant.delta")
      assert.equal(parsed.diagnostic.reason, "invalid_payload")
    }
  })

  test("rejects malformed envelopes and expanded capabilities", () => {
    assert.throws(() => parseRuntimeEvent({ type: "future" }))
    assert.equal(runtimeCapabilitiesSchema.safeParse({
      images: true,
      mcp: true,
      skills: true,
      approvals: true,
      steering: true,
      reasoningStream: true,
      planMode: false,
      reviewMode: false,
      sessionFork: false,
      hiddenCapability: true,
    }).success, false)
  })

  test("normalizes stable runtime errors", () => {
    assert.deepEqual(runtimeErrorSchema.parse({
      code: "runtime_crashed",
      message: "Codex stopped unexpectedly",
      retryable: true,
    }), {
      code: "runtime_crashed",
      message: "Codex stopped unexpectedly",
      retryable: true,
      status: null,
      metadata: {},
    })
  })
})
