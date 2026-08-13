import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

import { ClaudeRunService } from "../src/execution.ts"
import type { ClaudeWorkerRunRequest } from "../src/schemas.ts"

function request(index: number, sessionId = "long-session"): ClaudeWorkerRunRequest {
  return {
    workspaceId: "workspace-a",
    sessionId,
    runId: `run-${index}`,
    backendSessionId: null,
    cwd: "/workspace",
    prompt: `turn ${index}`,
    delivery: "start",
    limits: { maxTurns: 2, maxBudgetUsd: 1, wallClockMs: 5_000, hardCloseMs: 10, approvalDeadlineMs: 500 },
    permissionPolicy: { mode: "default" },
  }
}

function completedQuery(index: number): Query {
  const messages = [{
    type: "assistant",
    uuid: `message-${index}`,
    session_id: "10000000-0000-4000-8000-000000000001",
    message: { model: "fixture", content: [{ type: "text", text: `reply ${index}` }] },
  }, {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "10000000-0000-4000-8000-000000000001",
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  }]
  const generator = (async function* () {
    for (const message of messages) yield message as SDKMessage
  })()
  return Object.assign(generator, { close() {} }) as Query
}

function deferredQuery(): { query: Query; release: () => void } {
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  const generator = (async function* () {
    await wait
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "10000000-0000-4000-8000-000000000001",
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as SDKMessage
  })()
  return { query: Object.assign(generator, { close: release }) as Query, release }
}

function service(query: (params: { prompt: string; options: Options }) => Query, limits = {}) {
  return new ClaudeRunService({
    claudeExecutablePath: "/runtime/claude",
    claudeConfigDir: "/app-data/profile/claude",
    claudeEnv: { ANTHROPIC_API_KEY: "fixture-only-not-a-real-key" },
    query,
    publishEvent: (type, payload = {}) => ({
      protocolVersion: 1,
      sequence: 1,
      id: "fixture-event",
      type,
      createdAt: "2026-08-13T00:00:00.000Z",
      payload,
    }),
    ...limits,
  })
}

describe("Claude worker reliability without provider credentials", () => {
  test("bounds completed runs and transcript projection state across a long session", async () => {
    let turn = 0
    const runService = service(() => completedQuery(turn++), {
      maxRetainedRuns: 12,
      maxRetainedProjectionEntries: 25,
    })

    for (let index = 0; index < 250; index += 1) {
      await runService.start(request(index))
      await runService.waitForRun(`run-${index}`)
    }

    assert.deepEqual(runService.resourceCounts(), {
      activeSessions: 0,
      retainedRuns: 12,
      messages: 25,
      tools: 0,
      toolResolutionStates: 0,
      completedMessages: 25,
      pendingInteractions: 0,
      pendingToolPolicies: 0,
      resolvedInteractions: 0,
    })
    assert.equal(runService.observe("run-0"), null)
    assert.equal(runService.observe("run-249")?.status, "completed")
  })

  test("runs many sessions concurrently and releases every active query", async () => {
    const deferred = Array.from({ length: 32 }, () => deferredQuery())
    let next = 0
    const runService = service(() => deferred[next++]!.query, { maxRetainedRuns: 40 })

    await Promise.all(deferred.map((_, index) => runService.start(request(index, `session-${index}`))))
    assert.equal(runService.resourceCounts().activeSessions, 32)
    deferred.forEach(({ release }) => release())
    await Promise.all(deferred.map((_, index) => runService.waitForRun(`run-${index}`)))

    assert.equal(runService.resourceCounts().activeSessions, 0)
    assert.equal(runService.resourceCounts().retainedRuns, 32)
  })

  test("does not leak approval waits or let a faulty cancellation block cleanup", async () => {
    const deferred = deferredQuery()
    let options: Options | undefined
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const runService = new ClaudeRunService({
      claudeExecutablePath: "/runtime/claude",
      claudeConfigDir: "/app-data/profile/claude",
      claudeEnv: { ANTHROPIC_API_KEY: "fixture-only-not-a-real-key" },
      query: (params) => {
        options = params.options
        return deferred.query
      },
      publishEvent: (type, payload = {}) => {
        events.push({ type, payload })
        return {
          protocolVersion: 1,
          sequence: events.length,
          id: `event-${events.length}`,
          type,
          createdAt: "2026-08-13T00:00:00.000Z",
          payload,
        }
      },
    })
    await runService.start(request(1, "approval-session"))

    const permission = options!.canUseTool!("Read", { file_path: "/workspace/README.md" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-read",
      requestId: "request-read",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const policyId = events.find(({ type }) => type === "tool.policy.requested")?.payload.requestId
    await runService.resolveInteraction(String(policyId), "approval-session", "run-1", {
      outcome: "allow",
      updatedInput: { file_path: "/workspace/README.md" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const requested = events.find(({ type, payload }) => type === "agent.event"
      && (payload.data as { type?: string })?.type === "interaction.requested")
    const interactionId = ((requested?.payload.data as { interaction?: { id?: string } })?.interaction?.id)
    await runService.resolveInteraction(String(interactionId), "approval-session", "run-1", { outcome: "deny", reason: "fixture" })
    await permission

    let healthyCancellationRan = false
    runService.registerApprovalWait("run-1", () => { throw new Error("faulty waiter") })
    runService.registerApprovalWait("run-1", () => { healthyCancellationRan = true })
    await runService.abort("approval-session", "run-1")
    await runService.waitForRun("run-1")

    assert.equal(healthyCancellationRan, true)
    assert.deepEqual(runService.resourceCounts(), {
      activeSessions: 0,
      retainedRuns: 1,
      messages: 0,
      tools: 0,
      toolResolutionStates: 1,
      completedMessages: 0,
      pendingInteractions: 0,
      pendingToolPolicies: 0,
      resolvedInteractions: 1,
    })
  })
})
