import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Options, Query, SDKMessage, SDKUserMessage, WarmQuery } from "@anthropic-ai/claude-agent-sdk"

import {
  ClaudeStartupPool,
  resolveClaudeAdvancedRuntimePolicy,
} from "../src/advanced-runtime.ts"
import { ClaudeRunService } from "../src/execution.ts"
import type { ClaudeWorkerRunRequest } from "../src/schemas.ts"

const backendSessionId = "10000000-0000-4000-8000-000000000001"

function deferredOutput() {
  const values: IteratorResult<SDKMessage>[] = []
  const waiters: Array<(value: IteratorResult<SDKMessage>) => void> = []
  let interrupts = 0
  const query = {
    next: () => {
      const value = values.shift()
      return value ? Promise.resolve(value) : new Promise<IteratorResult<SDKMessage>>((resolve) => waiters.push(resolve))
    },
    return: async () => ({ value: undefined, done: true as const }),
    throw: async (error?: unknown) => { throw error },
    [Symbol.asyncIterator]() { return this },
    close: () => pushDone(),
    interrupt: async () => {
      interrupts += 1
      return { still_queued: [] }
    },
  } as unknown as Query
  const push = (message: Record<string, unknown>) => {
    const value = { value: message as SDKMessage, done: false as const }
    const waiter = waiters.shift()
    if (waiter) waiter(value)
    else values.push(value)
  }
  const pushDone = () => {
    const value = { value: undefined, done: true as const }
    const waiter = waiters.shift()
    if (waiter) waiter(value)
    else values.push(value)
  }
  return { query, push, pushDone, interrupts: () => interrupts }
}

function request(runId: string, delivery: ClaudeWorkerRunRequest["delivery"] = "start"): ClaudeWorkerRunRequest {
  return {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    runId,
    backendSessionId: null,
    cwd: "/workspace",
    prompt: runId,
    delivery,
    limits: { maxTurns: 5, maxBudgetUsd: 1, wallClockMs: 10_000, hardCloseMs: 10, approvalDeadlineMs: 1_000 },
    permissionPolicy: { mode: "default" },
  }
}

describe("Claude advanced runtime gates", () => {
  test("all advanced kill switches restore strict run-per-query policy", () => {
    const stems = [
      "PREWARM",
      "RESIDENT_SESSIONS",
      "PROTOCOL_INTERRUPT",
      "QUEUED_INPUT",
      "STEER",
      "DYNAMIC_MODEL",
      "DYNAMIC_EFFORT",
      "DYNAMIC_PERMISSION_MODE",
      "SUBAGENTS",
      "PLAN_MODE",
      "FILE_CHECKPOINTING",
      "REWIND",
      "NATIVE_FORK",
    ]
    const env: NodeJS.ProcessEnv = {}
    for (const stem of stems) {
      env[`JUGGLEWORK_CLAUDE_${stem}_ENABLED`] = "1"
      env[`JUGGLEWORK_CLAUDE_${stem}_POLICY_ALLOWED`] = "1"
      env[`JUGGLEWORK_CLAUDE_${stem}_KILL_SWITCH`] = "1"
    }
    const policy = resolveClaudeAdvancedRuntimePolicy(env)
    assert.deepEqual({
      prewarm: policy.prewarm,
      residentSession: policy.residentSession,
      protocolInterrupt: policy.protocolInterrupt,
      queuedInput: policy.queuedInput,
      steer: policy.steer,
      dynamicModel: policy.dynamicModel,
      dynamicEffort: policy.dynamicEffort,
      dynamicPermissionMode: policy.dynamicPermissionMode,
      subagents: policy.subagents,
      planMode: policy.planMode,
      fileCheckpointing: policy.fileCheckpointing,
      rewind: policy.rewind,
      nativeFork: policy.nativeFork,
    }, {
      prewarm: false,
      residentSession: false,
      protocolInterrupt: false,
      queuedInput: false,
      steer: false,
      dynamicModel: false,
      dynamicEffort: false,
      dynamicPermissionMode: false,
      subagents: false,
      planMode: false,
      fileCheckpointing: false,
      rewind: false,
      nativeFork: false,
    })
  })

  test("keeps every feature independent and lets kill switches win", () => {
    const policy = resolveClaudeAdvancedRuntimePolicy({
      JUGGLEWORK_CLAUDE_PREWARM_ENABLED: "1",
      JUGGLEWORK_CLAUDE_PREWARM_POLICY_ALLOWED: "1",
      JUGGLEWORK_CLAUDE_RESIDENT_SESSIONS_ENABLED: "1",
      JUGGLEWORK_CLAUDE_RESIDENT_SESSIONS_POLICY_ALLOWED: "1",
      JUGGLEWORK_CLAUDE_RESIDENT_SESSIONS_KILL_SWITCH: "1",
      JUGGLEWORK_CLAUDE_PROTOCOL_INTERRUPT_ENABLED: "1",
      JUGGLEWORK_CLAUDE_PROTOCOL_INTERRUPT_POLICY_ALLOWED: "1",
      JUGGLEWORK_CLAUDE_QUEUED_INPUT_ENABLED: "1",
      JUGGLEWORK_CLAUDE_QUEUED_INPUT_POLICY_ALLOWED: "1",
      JUGGLEWORK_CLAUDE_STEER_ENABLED: "1",
      JUGGLEWORK_CLAUDE_STEER_POLICY_ALLOWED: "1",
      JUGGLEWORK_CLAUDE_PREWARM_POOL_SIZE: "3",
      JUGGLEWORK_CLAUDE_PREWARM_IDLE_MS: "2000",
    })
    assert.equal(policy.prewarm, true)
    assert.equal(policy.residentSession, false)
    assert.equal(policy.protocolInterrupt, true)
    assert.equal(policy.queuedInput, true)
    assert.equal(policy.steer, true)
    assert.equal(policy.prewarmPoolSize, 3)
    assert.equal(policy.prewarmIdleMs, 2_000)
  })

  test("bounds the startup pool, expires idle handles, and leaves misses for run-per-query fallback", async () => {
    const closed: string[] = []
    const resolvers: Array<(value: WarmQuery) => void> = []
    const pool = new ClaudeStartupPool({
      maxSize: 1,
      idleMs: 1_000,
      startup: () => new Promise((resolve) => resolvers.push(resolve)),
    })
    pool.warm("a", {} as Options)
    pool.warm("b", {} as Options)
    assert.equal(resolvers.length, 1)
    resolvers[0]!({ query: () => ({}) as Query, close: () => closed.push("a"), [Symbol.asyncDispose]: async () => undefined })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(pool.take("missing"), null)
    assert.ok(pool.take("a"))
    pool.warm("expiring", {} as Options)
    resolvers[1]!({ query: () => ({}) as Query, close: () => closed.push("expiring"), [Symbol.asyncDispose]: async () => undefined })
    await new Promise((resolve) => setTimeout(resolve, 1_050))
    assert.equal(pool.take("expiring"), null)
    assert.deepEqual(closed, ["expiring"])
    pool.close()
  })

  test("falls back to run-per-query when startup prewarming fails", async () => {
    let queries = 0
    const fixture = [
      { type: "system", subtype: "init", session_id: backendSessionId, capabilities: [] },
      { type: "result", subtype: "success", is_error: false, session_id: backendSessionId },
    ]
    const service = new ClaudeRunService({
      claudeExecutablePath: "/runtime/claude",
      claudeConfigDir: "/profile/claude",
      claudeEnv: { ANTHROPIC_API_KEY: "fixture-only" },
      publishEvent: (type, payload = {}) => ({ protocolVersion: 1, sequence: 1, id: type, type, createdAt: new Date().toISOString(), payload }),
      startup: async () => { throw new Error("startup unsupported") },
      query: () => {
        queries += 1
        const iterator = (async function* () {
          for (const message of fixture) yield message as SDKMessage
        })()
        return Object.assign(iterator, { close: () => undefined }) as Query
      },
      advancedPolicy: {
        prewarm: true,
        residentSession: false,
        protocolInterrupt: false,
        queuedInput: false,
        steer: false,
        prewarmPoolSize: 1,
        prewarmIdleMs: 1_000,
        residentIdleMs: 1_000,
      },
    })
    await service.start(request("run-one"))
    await service.waitForRun("run-one")
    await new Promise((resolve) => setTimeout(resolve, 0))
    await service.start(request("run-two"))
    await service.waitForRun("run-two")
    assert.equal(queries, 2)
    await service.closeAll()
  })

  test("advertises resident steer only after init capability and preserves queued input order", async () => {
    const output = deferredOutput()
    let input: AsyncIterable<SDKUserMessage> | undefined
    const service = new ClaudeRunService({
      claudeExecutablePath: "/runtime/claude",
      claudeConfigDir: "/profile/claude",
      claudeEnv: { ANTHROPIC_API_KEY: "fixture-only" },
      publishEvent: (type, payload = {}) => ({ protocolVersion: 1, sequence: 1, id: type, type, createdAt: new Date().toISOString(), payload }),
      streamingQuery: ({ prompt }) => {
        input = prompt
        return output.query
      },
      advancedPolicy: {
        prewarm: false,
        residentSession: true,
        protocolInterrupt: true,
        queuedInput: true,
        steer: true,
        prewarmPoolSize: 1,
        prewarmIdleMs: 1_000,
        residentIdleMs: 5_000,
      },
    })
    await service.start(request("run-one"))
    assert.equal(service.advancedCapabilities().steer, false)
    output.push({ type: "system", subtype: "init", session_id: backendSessionId, capabilities: ["interrupt_receipt_v1"] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(service.advancedCapabilities(), {
      prewarm: false,
      residentSession: true,
      protocolInterrupt: true,
      queuedInput: true,
      steer: true,
      dynamicModel: false,
      dynamicEffort: false,
      dynamicPermissionMode: false,
      subagentProjection: false,
      subagentProgress: false,
      subagentStop: false,
      planMode: false,
      fileCheckpointing: false,
      rewind: false,
      nativeFork: false,
    })

    await service.start(request("run-enqueue", "enqueue"))
    await service.start(request("run-steer", "steer"))
    assert.equal(output.interrupts(), 1)
    const iterator = input![Symbol.asyncIterator]()
    const prompts = []
    for (let index = 0; index < 3; index += 1) {
      const message = (await iterator.next()).value!
      prompts.push({ content: message.message.content, priority: message.priority })
    }
    assert.deepEqual(prompts, [
      { content: "run-one", priority: undefined },
      { content: "run-enqueue", priority: "next" },
      { content: "run-steer", priority: "now" },
    ])

    output.push({ type: "result", subtype: "success", is_error: false, session_id: backendSessionId })
    output.push({ type: "result", subtype: "success", is_error: false, session_id: backendSessionId })
    output.push({ type: "result", subtype: "success", is_error: false, session_id: backendSessionId })
    await service.waitForRun("run-enqueue")
    assert.equal(service.observe("run-one")?.status, "aborted")
    assert.equal(service.observe("run-steer")?.status, "completed")
    assert.equal(service.observe("run-enqueue")?.status, "completed")
    await service.closeAll()
  })
})
