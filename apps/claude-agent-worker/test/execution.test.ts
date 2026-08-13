import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

import { ClaudeRunError, ClaudeRunService } from "../src/execution.ts"
import type { ClaudeWorkerEvent, ClaudeWorkerRunRequest } from "../src/schemas.ts"
import runFixture from "./fixtures/claude-run.json" with { type: "json" }

const firstBackendSessionId = "10000000-0000-4000-8000-000000000001"
const resumedBackendSessionId = "10000000-0000-4000-8000-000000000002"

function request(overrides: Partial<ClaudeWorkerRunRequest> = {}): ClaudeWorkerRunRequest {
  return {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    runId: "run-a",
    backendSessionId: null,
    cwd: "/workspace",
    prompt: "Inspect the workspace",
    delivery: "start",
    limits: { maxTurns: 7, maxBudgetUsd: 2.5, wallClockMs: 10_000, hardCloseMs: 10, approvalDeadlineMs: 5_000 },
    permissionPolicy: { mode: "default" },
    ...overrides,
  }
}

function fixtureQuery(messages: unknown[], onClose?: () => void): Query {
  const generator = (async function* () {
    for (const message of messages) yield message as SDKMessage
  })()
  return Object.assign(generator, {
    close: () => onClose?.(),
  }) as Query
}

function deferredQuery(): { query: Query; close: () => boolean } {
  let closed = false
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  const generator = (async function* () {
    await wait
  })()
  const query = Object.assign(generator, {
    close: () => {
      closed = true
      release()
    },
  }) as Query
  return { query, close: () => closed }
}

function harness(
  queryFactory: (params: { prompt: string; options: Options }) => Query,
  advancedPolicy: ConstructorParameters<typeof ClaudeRunService>[0]["advancedPolicy"] = {},
) {
  const events: ClaudeWorkerEvent[] = []
  let sequence = 0
  const service = new ClaudeRunService({
    claudeExecutablePath: "/runtime/claude",
    claudeConfigDir: "/app-data/profile/claude",
    query: queryFactory,
    now: () => 1_000,
    claudeEnv: { ANTHROPIC_API_KEY: "fixture-only" },
    advancedPolicy,
    publishEvent: (type, payload = {}) => {
      const event: ClaudeWorkerEvent = {
        protocolVersion: 1,
        sequence: ++sequence,
        id: `fixture-${sequence}`,
        type,
        createdAt: new Date(1_000).toISOString(),
        payload,
      }
      events.push(event)
      return event
    },
  })
  return { service, events }
}

describe("Claude run-per-query execution", () => {
  test("passes isolated exact SDK options and captures the first backend session", async () => {
    const calls: Array<{ prompt: string; options: Options }> = []
    const { service, events } = harness((params) => {
      calls.push(params)
      return fixtureQuery(runFixture)
    })

    await service.start(request())
    await service.waitForRun("run-a")

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.prompt, "Inspect the workspace")
    assert.equal(calls[0]?.options.cwd, "/workspace")
    assert.equal(calls[0]?.options.resume, undefined)
    assert.equal(calls[0]?.options.includePartialMessages, true)
    assert.equal(calls[0]?.options.maxTurns, 7)
    assert.equal(calls[0]?.options.maxBudgetUsd, 2.5)
    assert.deepEqual(calls[0]?.options.settingSources, [])
    assert.equal(calls[0]?.options.strictMcpConfig, true)
    assert.equal(calls[0]?.options.permissionMode, "default")
    assert.equal(calls[0]?.options.allowDangerouslySkipPermissions, false)
    assert.deepEqual(calls[0]?.options.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true, allowAllUnixSockets: false, allowLocalBinding: false },
    })
    assert.ok(calls[0]?.options.hooks?.PreToolUse)
    assert.equal(calls[0]?.options.pathToClaudeCodeExecutable, "/runtime/claude")
    assert.equal(calls[0]?.options.env?.CLAUDE_CONFIG_DIR, "/app-data/profile/claude")
    assert.equal(calls[0]?.options.env?.ANTHROPIC_API_KEY, "fixture-only")
    assert.equal(calls[0]?.options.env?.CLAUDE_AGENT_SDK_CLIENT_APP, "jugglework-claude-agent-worker/1")
    assert.equal(calls[0]?.options.env?.JUGGLEWORK_CLAUDE_WORKER_TOKEN, undefined)
    assert.equal(calls[0]?.options.env?.AWS_SECRET_ACCESS_KEY, undefined)
    assert.equal(service.observe("run-a")?.backendSessionId, firstBackendSessionId)
    assert.equal(events.some((event) => event.type === "session.initialized" && event.payload.firstRun === true), true)
  })

  test("resumes only the exact persisted backend session", async () => {
    let options: Options | undefined
    const fixture = runFixture.map((message) => ({ ...message, session_id: resumedBackendSessionId }))
    const { service } = harness((params) => {
      options = params.options
      return fixtureQuery(fixture)
    })
    await service.start(request({ backendSessionId: resumedBackendSessionId }))
    await service.waitForRun("run-a")
    assert.equal(options?.resume, resumedBackendSessionId)
  })

  test("uses SDK plan mode, stops a subagent, and forks conversation history without claiming filesystem isolation", async () => {
    const deferred = deferredQuery()
    let options: Options | undefined
    let stopped = ""
    const query = Object.assign(deferred.query, {
      stopTask: async (taskId: string) => { stopped = taskId },
    }) as Query
    const { service } = harness((params) => {
      options = params.options
      return query
    }, { subagents: true, planMode: true })
    const forkCalls: unknown[] = []
    const forkService = new ClaudeRunService({
      claudeExecutablePath: "/runtime/claude",
      claudeConfigDir: "/app-data/profile/claude",
      query: () => query,
      forkSession: async (sessionId, forkOptions) => {
        forkCalls.push({ sessionId, forkOptions })
        return { sessionId: resumedBackendSessionId }
      },
      publishEvent: () => ({ protocolVersion: 1, sequence: 1, id: "fixture", type: "worker.ready", createdAt: new Date(0).toISOString(), payload: {} }),
      advancedPolicy: { subagents: true, planMode: true, nativeFork: true },
    })

    await service.start(request({ planMode: true }))
    assert.equal(options?.permissionMode, "plan")
    await service.stopSubagent("session-a", "run-a", "task-a")
    assert.equal(stopped, "task-a")
    await service.abort("session-a", "run-a")
    await service.waitForRun("run-a")

    const forked = await forkService.forkSession({
      sourceBackendSessionId: firstBackendSessionId,
      cwd: "/workspace",
      title: "Fork",
      upToMessageId: "message-a",
    })
    assert.deepEqual(forkCalls, [{ sessionId: firstBackendSessionId, forkOptions: { dir: "/workspace", title: "Fork", upToMessageId: "message-a" } }])
    assert.deepEqual(forked.filesystemState, {
      sharedWorkingTree: true,
      checkpointHistoryCopied: false,
      filesRewound: false,
      warning: "Conversation history was forked, but both sessions share the current working tree. File changes were not isolated or rewound, and Claude checkpoint/undo history was not copied.",
    })
  })

  test("applies model, effort and permission mode only to the requested query", async () => {
    const calls: Options[] = []
    const { service } = harness((params) => {
      calls.push(params.options)
      return fixtureQuery(runFixture)
    }, { dynamicModel: true, dynamicEffort: true, dynamicPermissionMode: true })
    await service.start(request({ model: "claude-sonnet", effort: "xhigh", permissionMode: "dontAsk" }))
    await service.waitForRun("run-a")
    await service.start(request({ runId: "run-b" }))
    await service.waitForRun("run-b")
    assert.deepEqual(calls.map(({ model, effort, permissionMode }) => ({ model, effort, permissionMode })), [
      { model: "claude-sonnet", effort: "xhigh", permissionMode: "dontAsk" },
      { model: undefined, effort: undefined, permissionMode: "default" },
    ])
  })

  test("maps fixture deltas, assistant, tools, retry, compaction, result and usage with stable deduplicated IDs", async () => {
    const { service, events } = harness(() => fixtureQuery(runFixture), { subagents: true })
    await service.start(request())
    await service.waitForRun("run-a")

    const deltas = events.filter((event) => event.type === "message.part.delta")
    assert.deepEqual(deltas.map((event) => event.payload.delta), ["Hello ", "world", "Checking."])
    const assistantEvents = events.filter((event) => event.type === "message.updated"
      && ((event.payload.message as { parts?: Array<{ type?: string }> })?.parts ?? []).some((part) => part.type !== "agent"))
    assert.equal(assistantEvents.length, 1)
    const assistant = assistantEvents[0]?.payload.message as { id: string; parts: Array<Record<string, unknown>> }
    assert.equal(assistant.parts[0]?.id, deltas[0]?.payload.partId)
    assert.equal(assistant.parts[0]?.text, "Hello world")
    assert.equal(assistant.parts[1]?.id, deltas[2]?.payload.partId)

    const toolUpdates = events.filter((event) => event.type === "message.part.updated")
    const toolParts = toolUpdates.map((event) => event.payload.part as Record<string, unknown>)
    assert.equal(new Set(toolParts.map((part) => part.id)).size, 1)
    assert.equal(new Set(toolParts.map((part) => part.toolCallId)).size, 1)
    assert.equal(toolParts.some((part) => part.state === "running"), true)
    assert.equal(toolParts.some((part) => part.state === "completed"), true)

    const subagents = events.filter((event) => event.type === "message.updated")
      .map((event) => event.payload.message as { parts?: Array<Record<string, unknown>> })
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === "agent")
    assert.equal(subagents.length, 3)
    const completedSubagent = subagents.at(-1)
    assert.equal(completedSubagent?.label, "Inspect authentication")
    assert.equal(completedSubagent?.state, "completed")
    assert.equal(completedSubagent?.parentToolCallId, toolParts[0]?.toolCallId)
    assert.deepEqual(completedSubagent?.metadata, {
      backendTaskId: "task_fixture_subagent",
      backendParentToolUseId: "toolu_fixture_read",
      summary: "Authentication flow inspected",
      usage: { totalTokens: 180, toolUses: 4, durationMs: 2000 },
      runId: "run-a",
      stoppable: false,
    })

    assert.equal(events.some((event) => event.type === "session.status"
      && (event.payload.status as { type?: string }).type === "retrying"), true)
    assert.equal(events.some((event) => event.type === "session.compacted"), true)
    const usage = events.find((event) => event.type === "run.usage")?.payload.usage as Record<string, unknown>
    assert.deepEqual(
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        turns: usage.turns,
        estimatedCostUsd: usage.estimatedCostUsd,
      },
      { inputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 2, turns: 2, estimatedCostUsd: 0.012 },
    )
    assert.equal(events.filter((event) => event.type === "run.completed").length, 1)
    assert.deepEqual(service.observe("run-a"), {
      runId: "run-a",
      sessionId: "session-a",
      backendSessionId: firstBackendSessionId,
      status: "completed",
      terminal: true,
      errorCode: null,
    })
  })

  test("cancels approval waits and hard-closes an unresponsive query on abort", async () => {
    const deferred = deferredQuery()
    const { service, events } = harness(() => deferred.query)
    await service.start(request())
    let approvalCancelled = false
    service.registerApprovalWait("run-a", () => { approvalCancelled = true })

    await service.abort("session-a", "run-a")
    assert.equal(approvalCancelled, true)
    await service.waitForRun("run-a")
    assert.equal(deferred.close(), true)
    assert.equal(service.observe("run-a")?.status, "aborted")
    assert.equal(events.filter((event) => event.type === "run.aborted").length, 1)
  })

  test("bridges tool permission and clarification callbacks through stable canonical interactions", async () => {
    const deferred = deferredQuery()
    let options: Options | undefined
    const { service, events } = harness((params) => {
      options = params.options
      return deferred.query
    })
    await service.start(request())
    assert.ok(options?.canUseTool)

    const permission = options.canUseTool("Read", { file_path: "/workspace/README.md" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-read",
      requestId: "permission-request",
      title: "Claude wants to read README.md",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const policyRequested = events.find((event) => event.type === "tool.policy.requested")
    await service.resolveInteraction(String(policyRequested?.payload.requestId), "session-a", "run-a", {
      outcome: "allow",
      updatedInput: { file_path: "/workspace/README.md" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const requested = events.find((event) => event.type === "agent.event"
      && (event.payload.data as { type?: string })?.type === "interaction.requested")
    const interaction = (requested?.payload.data as { interaction?: Record<string, unknown> })?.interaction
    assert.equal(interaction?.kind, "permission")
    assert.match(String((interaction?.metadata as Record<string, unknown>)?.toolCallId), /^claude:tool-call:/)
    await service.resolveInteraction(String(interaction?.id), "session-a", "run-a", { outcome: "allow" })
    assert.deepEqual(await permission, {
      behavior: "allow",
      updatedInput: { file_path: "/workspace/README.md" },
      toolUseID: "tool-read",
    })
    await assert.rejects(
      service.resolveInteraction(String(interaction?.id), "session-a", "run-a", { outcome: "deny", reason: "late" }),
      (error: unknown) => error instanceof ClaudeRunError && error.code === "already_resolved",
    )

    const question = options.canUseTool("AskUserQuestion", {
      questions: [{ question: "Which branch?", options: [{ label: "main" }, { label: "dev" }], multiSelect: false }],
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-question",
      requestId: "question-request",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const questionPolicy = events.filter((event) => event.type === "tool.policy.requested").at(-1)
    await service.resolveInteraction(String(questionPolicy?.payload.requestId), "session-a", "run-a", {
      outcome: "allow",
      updatedInput: {
        questions: [{ question: "Which branch?", options: [{ label: "main" }, { label: "dev" }], multiSelect: false }],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const questionEvent = events.filter((event) => event.type === "agent.event"
      && (event.payload.data as { type?: string })?.type === "interaction.requested").at(-1)
    const questionInteraction = (questionEvent?.payload.data as { interaction?: Record<string, unknown> })?.interaction
    assert.equal(questionInteraction?.kind, "question")
    await service.resolveInteraction(String(questionInteraction?.id), "session-a", "run-a", { outcome: "answer", values: ["main"] })
    assert.deepEqual(await question, {
      behavior: "allow",
      updatedInput: {
        questions: [{ question: "Which branch?", options: [{ label: "main" }, { label: "dev" }], multiSelect: false }],
        answers: { "Which branch?": "main" },
      },
      toolUseID: "tool-question",
    })
    await service.abort("session-a", "run-a")
    await service.waitForRun("run-a")
  })

  test("marks only approved potentially mutating tools before SDK execution", async () => {
    const deferred = deferredQuery()
    let options: Options | undefined
    const { service, events } = harness((params) => {
      options = params.options
      return deferred.query
    })
    await service.start(request())

    const read = options!.canUseTool!("Read", { file_path: "/workspace/a" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-read-safe",
      requestId: "read-safe",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const safePolicy = events.filter((event) => event.type === "tool.policy.requested").at(-1)
    await service.resolveInteraction(String(safePolicy?.payload.requestId), "session-a", "run-a", {
      outcome: "allow",
      updatedInput: { file_path: "/workspace/a" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const readInteraction = events.filter((event) => event.type === "agent.event").at(-1)?.payload.data as { interaction?: { id?: string } }
    await service.resolveInteraction(String(readInteraction.interaction?.id), "session-a", "run-a", { outcome: "allow" })
    await read
    assert.equal(events.some((event) => event.type === "run.mutation.possible"), false)

    const write = options!.canUseTool!("Write", { file_path: "/workspace/a", content: "changed" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-write-risk",
      requestId: "write-risk",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const riskyPolicy = events.filter((event) => event.type === "tool.policy.requested").at(-1)
    await service.resolveInteraction(String(riskyPolicy?.payload.requestId), "session-a", "run-a", {
      outcome: "allow",
      updatedInput: { file_path: "/workspace/a", content: "changed" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const writeInteraction = events.filter((event) => event.type === "agent.event").at(-1)?.payload.data as { interaction?: { id?: string } }
    await service.resolveInteraction(String(writeInteraction.interaction?.id), "session-a", "run-a", { outcome: "allow" })
    await write
    assert.equal(events.some((event) => event.type === "run.mutation.possible"
      && event.payload.toolName === "Write" && event.payload.toolUseId === "tool-write-risk"), true)

    await service.abort("session-a", "run-a")
    await service.waitForRun("run-a")
  })

  test("releases SDK permission callbacks on timeout and cancellation", async () => {
    const timeoutQuery = deferredQuery()
    let timeoutOptions: Options | undefined
    const timeoutHarness = harness((params) => {
      timeoutOptions = params.options
      return timeoutQuery.query
    })
    await timeoutHarness.service.start(request({
      limits: { maxTurns: 1, maxBudgetUsd: 1, wallClockMs: 500, hardCloseMs: 10, approvalDeadlineMs: 250 },
    }))
    const timedOut = timeoutOptions!.canUseTool!("Bash", { command: "pwd" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-timeout",
      requestId: "timeout-request",
    })
    assert.deepEqual(await timedOut, {
      behavior: "deny",
      message: "Mandatory tool policy timed out",
      interrupt: false,
      toolUseID: "tool-timeout",
    })
    assert.equal(timeoutHarness.events.some((event) => event.type === "tool.policy.resolved"
      && event.payload.decision === "deny"), true)
    await timeoutHarness.service.abort("session-a", "run-a")
    await timeoutHarness.service.waitForRun("run-a")

    const cancelledQuery = deferredQuery()
    let cancelledOptions: Options | undefined
    const cancelledHarness = harness((params) => {
      cancelledOptions = params.options
      return cancelledQuery.query
    })
    await cancelledHarness.service.start(request())
    const cancelled = cancelledOptions!.canUseTool!("Write", { file_path: "/workspace/a" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-cancelled",
      requestId: "cancelled-request",
    })
    await cancelledHarness.service.abort("session-a", "run-a")
    assert.deepEqual(await cancelled, {
      behavior: "deny",
      message: "Run was cancelled",
      interrupt: true,
      toolUseID: "tool-cancelled",
    })
    await cancelledHarness.service.waitForRun("run-a")
  })

  test("immediately cancels an interaction whose SDK signal already aborted", async () => {
    const deferred = deferredQuery()
    let options: Options | undefined
    const { service } = harness((params) => {
      options = params.options
      return deferred.query
    })
    await service.start(request())
    const controller = new AbortController()
    controller.abort()
    const result = await options!.canUseTool!("Read", { file_path: "/workspace/a" }, {
      signal: controller.signal,
      toolUseID: "tool-aborted-before-callback",
      requestId: "aborted-before-callback",
    })
    assert.deepEqual(result, {
      behavior: "deny",
      message: "Run was cancelled",
      interrupt: true,
      toolUseID: "tool-aborted-before-callback",
    })
    await service.abort("session-a", "run-a")
    await service.waitForRun("run-a")
  })

  test("enforces mandatory PreToolUse policy before SDK permission handling", async () => {
    const deferred = deferredQuery()
    let options: Options | undefined
    const { service, events } = harness((params) => {
      options = params.options
      return deferred.query
    })
    await service.start(request())
    const hook = options!.hooks!.PreToolUse![0]!.hooks[0]!
    const denied = hook({
      hook_event_name: "PreToolUse",
      session_id: firstBackendSessionId,
      transcript_path: "/app-data/profile/claude/session.jsonl",
      cwd: "/workspace",
      permission_mode: "default",
      tool_name: "Read",
      tool_input: { file_path: "/outside/secret" },
      tool_use_id: "hook-denied",
    }, "hook-denied", { signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const deniedRequest = events.filter((event) => event.type === "tool.policy.requested").at(-1)
    await service.resolveInteraction(String(deniedRequest?.payload.requestId), "session-a", "run-a", {
      outcome: "deny",
      reason: "path_outside_authorized_roots",
    })
    assert.deepEqual(await denied, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "path_outside_authorized_roots",
      },
    })

    const narrowed = hook({
      hook_event_name: "PreToolUse",
      session_id: firstBackendSessionId,
      transcript_path: "/app-data/profile/claude/session.jsonl",
      cwd: "/workspace",
      permission_mode: "default",
      tool_name: "Read",
      tool_input: { file_path: "README.md", ignored: true },
      tool_use_id: "hook-narrowed",
    }, "hook-narrowed", { signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const narrowedRequest = events.filter((event) => event.type === "tool.policy.requested").at(-1)
    await service.resolveInteraction(String(narrowedRequest?.payload.requestId), "session-a", "run-a", {
      outcome: "allow",
      updatedInput: { file_path: "/workspace/README.md" },
    })
    assert.deepEqual(await narrowed, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "defer",
        updatedInput: { file_path: "/workspace/README.md" },
      },
    })
    await service.abort("session-a", "run-a")
    await service.waitForRun("run-a")
  })

  test("applies explicit headless deny, preapproved, and bounded-wait policies", async () => {
    for (const action of ["deny", "preapproved", "wait"] as const) {
      const deferred = deferredQuery()
      let options: Options | undefined
      const current = harness((params) => {
        options = params.options
        return deferred.query
      })
      await current.service.start(request({
        runId: `run-${action}`,
        permissionPolicy: { mode: "headless", action },
        limits: { maxTurns: 1, maxBudgetUsd: 1, wallClockMs: 2_000, hardCloseMs: 10, approvalDeadlineMs: 100 },
      }))
      const result = options!.canUseTool!("Read", { file_path: "/workspace/README.md" }, {
        signal: new AbortController().signal,
        toolUseID: `tool-${action}`,
        requestId: `request-${action}`,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const policy = current.events.find((event) => event.type === "tool.policy.requested")
      await current.service.resolveInteraction(String(policy?.payload.requestId), "session-a", `run-${action}`, {
        outcome: "allow",
        updatedInput: { file_path: "/workspace/README.md" },
      })
      if (action === "wait") {
        assert.deepEqual(await result, {
          behavior: "deny",
          message: "Approval timed out",
          interrupt: false,
          toolUseID: "tool-wait",
        })
      } else if (action === "deny") {
        assert.deepEqual(await result, {
          behavior: "deny",
          message: "Headless permission policy denies unapproved tools",
          toolUseID: "tool-deny",
        })
      } else {
        assert.deepEqual(await result, {
          behavior: "allow",
          updatedInput: { file_path: "/workspace/README.md" },
          toolUseID: "tool-preapproved",
        })
      }
      await current.service.abort("session-a", `run-${action}`)
      await current.service.waitForRun(`run-${action}`)
    }
  })

  test("reauthorizes custom handlers immediately before dispatch", async () => {
    const deferred = deferredQuery()
    const { service, events } = harness(() => deferred.query)
    await service.start(request())
    let dispatched: Record<string, unknown> | null = null
    const execution = service.executeCustomToolHandler({
      runId: "run-a",
      toolName: "jugglework_execute",
      toolUseId: "custom-handler",
      toolInput: { id: "safe", unexpected: "drop" },
      signal: new AbortController().signal,
      handler: (input) => {
        dispatched = input
        return "ok"
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(dispatched, null)
    const policy = events.find((event) => event.type === "tool.policy.requested")
    await service.resolveInteraction(String(policy?.payload.requestId), "session-a", "run-a", {
      outcome: "allow",
      updatedInput: { id: "safe" },
    })
    assert.equal(await execution, "ok")
    assert.deepEqual(dispatched, { id: "safe" })
    await service.abort("session-a", "run-a")
    await service.waitForRun("run-a")
  })

  test("enforces wall-clock timeout and maps SDK error results", async () => {
    const timedOut = deferredQuery()
    const timeoutHarness = harness(() => timedOut.query)
    await timeoutHarness.service.start(request({
      limits: { maxTurns: 1, maxBudgetUsd: 1, wallClockMs: 100, hardCloseMs: 10, approvalDeadlineMs: 50 },
    }))
    await timeoutHarness.service.waitForRun("run-a")
    assert.equal(timeoutHarness.service.observe("run-a")?.errorCode, "wall_clock_limit")
    assert.equal(timeoutHarness.events.some((event) => event.type === "run.failed"
      && event.payload.code === "wall_clock_limit"), true)

    const errorResult = {
      ...(runFixture.at(-1) as Record<string, unknown>),
      subtype: "error_max_budget_usd",
      is_error: true,
      errors: ["Budget exhausted"],
    }
    const resultHarness = harness(() => fixtureQuery([runFixture[0], errorResult]))
    await resultHarness.service.start(request())
    await resultHarness.service.waitForRun("run-a")
    assert.equal(resultHarness.service.observe("run-a")?.errorCode, "error_max_budget_usd")
    assert.equal(resultHarness.events.some((event) => event.type === "run.failed"
      && event.payload.message === "Budget exhausted"), true)
  })

  test("rejects busy runs, accepts a durable enqueue promotion after idle, and rejects unsupported steer", async () => {
    const first = deferredQuery()
    let calls = 0
    const { service } = harness(() => {
      calls += 1
      return calls === 1 ? first.query : fixtureQuery(runFixture)
    })
    await service.start(request())
    await assert.rejects(
      service.start(request({ runId: "run-enqueued", delivery: "enqueue" })),
      (error: unknown) => error instanceof ClaudeRunError && error.code === "session_busy",
    )
    await assert.rejects(
      service.start(request({ runId: "run-steer", sessionId: "session-b", delivery: "steer" })),
      (error: unknown) => error instanceof ClaudeRunError && error.code === "unsupported_capability",
    )
    await service.abort("session-a", "run-a")
    await service.waitForRun("run-a")

    await service.start(request({ runId: "run-enqueued", delivery: "enqueue" }))
    await service.waitForRun("run-enqueued")
    assert.equal(service.observe("run-enqueued")?.status, "completed")
  })
})
