import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  agentRuntimeCatalogSchema,
  agentRuntimeDescriptorSchema,
  canonicalAgentEventSchema,
  canonicalAgentMessageSchema,
  canonicalInteractionSchema,
  canonicalSessionSnapshotSchema,
  canonicalToolPartSchema,
  hasAgentRuntimeCapability,
  type AgentRuntimeCapabilities,
  type AgentRuntimeDescriptor,
  agentRuntimeSupportDiagnosticsSchema,
  CLAUDE_ADVANCED_FEATURES,
  agentRuntimeCurrentTurnConfigurationSchema,
} from "../dist/agent-runtime.js"

const noCapabilities: AgentRuntimeCapabilities = {
  models: false,
  variants: false,
  "reasoning-stream": false,
  commands: false,
  shell: false,
  compact: false,
  resume: false,
  fork: false,
  steer: false,
  enqueue: false,
  permissions: false,
  questions: false,
  todos: false,
  mcp: false,
  subagents: false,
  "file-checkpointing": false,
  "usage-and-cost": false,
  prewarm: false,
  "resident-session": false,
  "plan-mode": false,
  rewind: false,
  "dynamic-model": false,
  "dynamic-effort": false,
  "dynamic-permission-mode": false,
}

const descriptor: AgentRuntimeDescriptor = {
  schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
  id: "jugglework",
  engine: "opencode",
  label: "JuggleWork Agent",
  isDefault: true,
  capabilities: { ...noCapabilities, models: true, resume: true, permissions: true },
  health: { status: "healthy", checkedAt: 1, reasonCode: null, message: null },
  models: [{ id: "gpt", providerId: "openai", label: "GPT", isDefault: true, capabilities: [] }],
}

const session = {
  id: "session-1",
  workspaceId: "workspace-1",
  runtimeId: "jugglework",
  backendSessionId: "backend-1",
  title: "Test session",
  canonicalCwd: "/workspace",
  status: { type: "idle" as const },
  configuration: {},
  createdAt: 1,
  updatedAt: 1,
  lastError: null,
}

const textPart = {
  id: "part-1",
  messageId: "message-1",
  sessionId: "session-1",
  ordinal: 0,
  createdAt: 1,
  updatedAt: 1,
  type: "text" as const,
  text: "hello",
  state: "complete" as const,
}

const message = {
  id: "message-1",
  sessionId: "session-1",
  role: "assistant" as const,
  parentId: null,
  createdAt: 1,
  completedAt: 2,
  parts: [textPart],
}

describe("agent runtime contracts", () => {
  test("support diagnostics are bounded and reject private fields", () => {
    const distribution = { count: 0, total: 0, max: 0 }
    const diagnostics = {
      schemaVersion: 1,
      capturedAt: 1,
      windowStartedAt: 1,
      worker: { status: "disabled", statusChanges: 0, starts: 0, restarts: 0, crashes: 0, circuitOpens: 0 },
      query: { active: 0, started: 0, completed: 0, failed: 0, aborted: 0, durationMs: distribution },
      mcp: { events: 0, initializing: 0, pending: 0, connected: 0, failed: 0, needsAuth: 0, expired: 0, removed: 0, outputTruncated: 0 },
      interaction: { requested: 0, resolved: 0, allowed: 0, denied: 0, answered: 0, rejected: 0, timedOut: 0, cancelled: 0, failed: 0, durationMs: distribution },
      event: { observed: 0, persisted: 0, duplicates: 0, streamErrors: 0, lagMs: distribution },
      queue: { created: 0, pending: 0, dispatching: 0, admitted: 0, completed: 0, failed: 0, cancelled: 0, waitMs: distribution },
      advancedRollout: { features: CLAUDE_ADVANCED_FEATURES.map((feature) => ({
        feature,
        enabled: false,
        attempts: 0,
        used: 0,
        fallbacks: 0,
        flagDisabled: 0,
        policyDenied: 0,
        killed: 0,
        capabilityMissing: 0,
      })) },
      usage: { samples: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0, estimatedCostUsd: 0 },
      crash: { total: 0, worker: 0, query: 0, eventStream: 0, lastAt: null, lastReason: null },
    }
    assert.equal(agentRuntimeSupportDiagnosticsSchema.safeParse(diagnostics).success, true)
    assert.equal(agentRuntimeSupportDiagnosticsSchema.safeParse({
      ...diagnostics,
      advancedRollout: {
        features: diagnostics.advancedRollout.features.map((metric) => ({
          ...metric,
          feature: diagnostics.advancedRollout.features[0]!.feature,
        })),
      },
    }).success, false)
    assert.equal(agentRuntimeSupportDiagnosticsSchema.safeParse({ ...diagnostics, transcript: "private" }).success, false)
    assert.equal(agentRuntimeSupportDiagnosticsSchema.safeParse({ ...diagnostics, usage: { ...diagnostics.usage, inputTokens: 1_000_000_000_001 } }).success, false)
  })

  test("accepts a valid descriptor and derives capabilities", () => {
    assert.equal(agentRuntimeDescriptorSchema.safeParse(descriptor).success, true)
    assert.equal(hasAgentRuntimeCapability(descriptor, "resume"), true)
    assert.equal(hasAgentRuntimeCapability(descriptor, "steer"), false)
  })

  test("rejects unavailable health without a reason and rejects unknown fields", () => {
    assert.equal(agentRuntimeDescriptorSchema.safeParse({
      ...descriptor,
      health: { status: "unavailable", checkedAt: 1, reasonCode: null, message: null },
    }).success, false)
    assert.equal(agentRuntimeDescriptorSchema.safeParse({ ...descriptor, secretBackendPayload: true }).success, false)
  })

  test("rejects duplicate runtimes, invalid defaults, and model capability mismatch", () => {
    assert.equal(agentRuntimeCatalogSchema.safeParse({
      schemaVersion: 1,
      runtimes: [descriptor, descriptor],
    }).success, false)
    assert.equal(agentRuntimeCatalogSchema.safeParse({
      schemaVersion: 1,
      runtimes: [{ ...descriptor, isDefault: false }],
    }).success, false)
    assert.equal(agentRuntimeDescriptorSchema.safeParse({
      ...descriptor,
      capabilities: noCapabilities,
    }).success, false)
  })

  test("validates message ownership and terminal tool errors", () => {
    assert.equal(canonicalAgentMessageSchema.safeParse(message).success, true)
    assert.equal(canonicalAgentMessageSchema.safeParse({
      ...message,
      parts: [{ ...textPart, sessionId: "another-session" }],
    }).success, false)
    assert.equal(canonicalToolPartSchema.safeParse({
      ...textPart,
      type: "tool",
      toolCallId: "tool-1",
      toolName: "read",
      state: "error",
    }).success, false)
  })

  test("requires terminal interaction resolution and question content", () => {
    const pending = {
      id: "interaction-1",
      sessionId: "session-1",
      runId: "run-1",
      kind: "permission",
      state: "pending",
      title: "Allow tool",
      requestedAt: 1,
      deadlineAt: null,
      resolvedAt: null,
      resolution: null,
    }
    assert.equal(canonicalInteractionSchema.safeParse(pending).success, true)
    assert.equal(canonicalInteractionSchema.safeParse({ ...pending, state: "resolved" }).success, false)
    assert.equal(canonicalInteractionSchema.safeParse({ ...pending, kind: "question" }).success, false)
  })

  test("validates snapshots and event ownership", () => {
    assert.equal(canonicalSessionSnapshotSchema.safeParse({
      schemaVersion: 1,
      session,
      messages: [message],
      todos: [],
      interactions: [],
      latestSequence: 0,
    }).success, true)
    assert.equal(canonicalAgentEventSchema.safeParse({
      schemaVersion: 1,
      id: "event-1",
      workspaceId: "workspace-1",
      sessionId: "different-session",
      runtimeId: "jugglework",
      sequence: 1,
      occurredAt: 1,
      data: { type: "message.updated", message },
    }).success, false)
  })

  test("validates bounded current-turn controls and canonical audit events", () => {
    assert.equal(agentRuntimeCurrentTurnConfigurationSchema.safeParse({
      model: { providerId: "anthropic", modelId: "claude-sonnet" },
      effort: "high",
      permissionMode: "dont-ask",
    }).success, true)
    assert.equal(agentRuntimeCurrentTurnConfigurationSchema.safeParse({}).success, false)
    assert.equal(agentRuntimeCurrentTurnConfigurationSchema.safeParse({ permissionMode: "bypassPermissions" }).success, false)
    assert.equal(canonicalAgentEventSchema.safeParse({
      schemaVersion: 1,
      id: "event-config",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      runtimeId: "claude-agent",
      sequence: 1,
      occurredAt: 1,
      data: {
        type: "run.configuration",
        runId: "run-1",
        semantics: "current-turn",
        actor: "local-renderer",
        configuration: { effort: "high" },
      },
    }).success, true)
  })

  test("fails closed for a future schema version", () => {
    assert.equal(agentRuntimeDescriptorSchema.safeParse({ ...descriptor, schemaVersion: 2 }).success, false)
  })
})
