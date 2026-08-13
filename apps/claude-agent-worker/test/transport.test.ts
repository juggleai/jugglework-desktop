import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"

import {
  CLAUDE_WORKER_MAX_REQUEST_BYTES,
  claudeWorkerCapabilitiesSchema,
  claudeWorkerHealthSchema,
  claudeWorkerShutdownResponseSchema,
  type ClaudeWorkerRunObservation,
} from "../src/schemas.ts"
import type { ClaudeRunController } from "../src/execution.ts"
import {
  CLAUDE_WORKER_TOKEN_HEADER,
  generateClaudeWorkerGenerationToken,
  startClaudeWorkerTransport,
  type ClaudeWorkerTransport,
} from "../src/transport.ts"
import { ClaudeMcpRuntime } from "../src/mcp-runtime.ts"

const transports = new Set<ClaudeWorkerTransport>()

afterEach(async () => {
  await Promise.allSettled([...transports].map((transport) => transport.close()))
  transports.clear()
})

async function start(createRunController?: Parameters<typeof startClaudeWorkerTransport>[0]["createRunController"]): Promise<{ token: string; transport: ClaudeWorkerTransport }> {
  const token = generateClaudeWorkerGenerationToken()
  const transport = await startClaudeWorkerTransport({
    generationToken: token,
    cliVersion: "2.1.226 (Claude Code)",
    createRunController,
  })
  transports.add(transport)
  return { token, transport }
}

function headers(token: string): Record<string, string> {
  return { [CLAUDE_WORKER_TOKEN_HEADER]: token }
}

describe("Claude worker loopback transport", () => {
  test("requires generation authentication without revealing state", async () => {
    const { token, transport } = await start()
    const missing = await fetch(`${transport.url}/v1/health`)
    const wrong = await fetch(`${transport.url}/v1/health`, {
      headers: headers(generateClaudeWorkerGenerationToken()),
    })
    assert.equal(missing.status, 401)
    assert.equal(wrong.status, 401)
    assert.deepEqual(await missing.json(), await wrong.json())

    const browser = await fetch(`${transport.url}/v1/health`, {
      headers: { ...headers(token), origin: "app://jugglework" },
    })
    assert.equal(browser.status, 403)
  })

  test("reports health and bounded baseline capabilities", async () => {
    const { token, transport } = await start()
    const healthResponse = await fetch(`${transport.url}/v1/health`, { headers: headers(token) })
    assert.equal(healthResponse.status, 200)
    assert.equal(claudeWorkerHealthSchema.parse(await healthResponse.json()).status, "healthy")

    const capabilitiesResponse = await fetch(`${transport.url}/v1/capabilities`, { headers: headers(token) })
    const capabilities = claudeWorkerCapabilitiesSchema.parse(await capabilitiesResponse.json())
    assert.equal(capabilities.operations.events, true)
    assert.equal(capabilities.cliVersion, "2.1.226 (Claude Code)")
    assert.equal(capabilities.operations.run, false)
    assert.equal(capabilities.limits.maxRequestBytes, CLAUDE_WORKER_MAX_REQUEST_BYTES)
  })

  test("streams authenticated sequenced events and enforces event limits", async () => {
    const { token, transport } = await start()
    const response = await fetch(`${transport.url}/v1/events?cursor=0`, { headers: headers(token) })
    assert.equal(response.status, 200)
    const reader = response.body?.getReader()
    assert.ok(reader)
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    assert.match(text, /event: worker\.ready/)
    assert.match(text, /"sequence":1/)
    await reader.cancel()

    assert.throws(() => transport.publishEvent("worker.health.changed", { value: "x".repeat(70_000) }), /size limit/)
  })

  test("namespaces event identifiers by worker generation", async () => {
    const first = await start()
    const second = await start()
    const firstEvent = first.transport.publishEvent("worker.health.changed")
    const secondEvent = second.transport.publishEvent("worker.health.changed")
    assert.notEqual(firstEvent.id, secondEvent.id)
    assert.equal(firstEvent.sequence, secondEvent.sequence)
  })

  test("closes the listener even when run cleanup fails", async () => {
    const controller: ClaudeRunController = {
      async start() { throw new Error("not used") },
      async abort() {},
      observe() { return null },
      async resolveInteraction() {},
      async closeAll() { throw new Error("cleanup failed") },
    }
    const { token, transport } = await start(() => controller)
    await assert.rejects(transport.close(), /cleanup failed/)
    await assert.rejects(fetch(`${transport.url}/v1/health`, { headers: headers(token) }))
  })

  test("rejects oversized and malformed shutdown requests", async () => {
    const { token, transport } = await start()
    const oversized = await fetch(`${transport.url}/v1/shutdown`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ reason: "x".repeat(CLAUDE_WORKER_MAX_REQUEST_BYTES) }),
    })
    assert.equal(oversized.status, 413)

    const malformed = await fetch(`${transport.url}/v1/shutdown`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: "not-json",
    })
    assert.equal(malformed.status, 400)
  })

  test("accepts authenticated shutdown and closes once", async () => {
    const { token, transport } = await start()
    const response = await fetch(`${transport.url}/v1/shutdown`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ reason: "test complete" }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(claudeWorkerShutdownResponseSchema.parse(await response.json()), {
      accepted: true,
      status: "stopping",
    })
    await transport.close()
    await transport.close()
  })

  test("routes run, observation and abort through the injected controller", async () => {
    const calls: string[] = []
    const observations = new Map<string, ClaudeWorkerRunObservation>()
    const controller: ClaudeRunController = {
      async start(input) {
        calls.push(`start:${input.delivery}`)
        observations.set(input.runId, {
          runId: input.runId,
          sessionId: input.sessionId,
          backendSessionId: null,
          status: "starting",
          terminal: false,
          errorCode: null,
        })
        return { accepted: true, runId: input.runId, status: "starting" }
      },
      async abort(sessionId, runId) {
        calls.push(`abort:${sessionId}:${runId}`)
      },
      observe(runId) {
        return observations.get(runId) ?? null
      },
      async resolveInteraction(interactionId, sessionId, runId, resolution) {
        calls.push(`resolve:${interactionId}:${sessionId}:${runId}:${resolution.outcome}`)
      },
      async stopSubagent(sessionId, runId, taskId) {
        calls.push(`stop-subagent:${sessionId}:${runId}:${taskId}`)
      },
      async forkSession(input) {
        calls.push(`fork:${input.sourceBackendSessionId}:${input.upToMessageId}`)
        return {
          accepted: true,
          backendSessionId: "20000000-0000-4000-8000-000000000002",
          filesystemState: {
            sharedWorkingTree: true,
            checkpointHistoryCopied: false,
            filesRewound: false,
            warning: "Conversation only; shared working tree.",
          },
        }
      },
      async closeAll() {
        calls.push("close")
      },
    }
    const { token, transport } = await start(() => controller)
    const capabilities = await fetch(`${transport.url}/v1/capabilities`, { headers: headers(token) }).then((response) => response.json()) as {
      operations: { run: boolean; abort: boolean; interactions: boolean }
    }
    assert.deepEqual(
      { run: capabilities.operations.run, abort: capabilities.operations.abort, interactions: capabilities.operations.interactions },
      { run: true, abort: true, interactions: true },
    )

    const body = {
      workspaceId: "workspace-a",
      sessionId: "session-a",
      runId: "run-a",
      backendSessionId: null,
      cwd: "/workspace",
      prompt: "hello",
      delivery: "enqueue",
      limits: { maxTurns: 5, maxBudgetUsd: 1, wallClockMs: 1_000, hardCloseMs: 100, approvalDeadlineMs: 500 },
      permissionPolicy: { mode: "default" },
    }
    const started = await fetch(`${transport.url}/v1/runs`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    assert.equal(started.status, 202)
    assert.deepEqual(await started.json(), { accepted: true, runId: "run-a", status: "starting" })

    const observed = await fetch(`${transport.url}/v1/runs/run-a`, { headers: headers(token) })
    assert.equal(observed.status, 200)
    assert.equal((await observed.json() as { runId: string }).runId, "run-a")

    const aborted = await fetch(`${transport.url}/v1/runs/run-a/abort`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-a", runId: "run-a" }),
    })
    assert.equal(aborted.status, 202)
    assert.deepEqual(calls.slice(0, 2), ["start:enqueue", "abort:session-a:run-a"])

    const resolved = await fetch(`${transport.url}/v1/interactions/interaction-a/resolve`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-a", runId: "run-a", resolution: { outcome: "deny", reason: "No" } }),
    })
    assert.equal(resolved.status, 200)
    assert.deepEqual(await resolved.json(), { accepted: true, interactionId: "interaction-a" })
    assert.equal(calls.at(-1), "resolve:interaction-a:session-a:run-a:deny")

    const stopped = await fetch(`${transport.url}/v1/runs/run-a/subagents/task-a/stop`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-a", runId: "run-a", taskId: "task-a" }),
    })
    assert.equal(stopped.status, 202)
    assert.equal(calls.at(-1), "stop-subagent:session-a:run-a:task-a")

    const forked = await fetch(`${transport.url}/v1/sessions/fork`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({
        sourceBackendSessionId: "10000000-0000-4000-8000-000000000001",
        cwd: "/workspace",
        upToMessageId: "message-a",
      }),
    })
    assert.equal(forked.status, 201)
    assert.deepEqual(await forked.json(), {
      accepted: true,
      backendSessionId: "20000000-0000-4000-8000-000000000002",
      filesystemState: {
        sharedWorkingTree: true,
        checkpointHistoryCopied: false,
        filesRewound: false,
        warning: "Conversation only; shared working tree.",
      },
    })
    assert.equal(calls.at(-1), "fork:10000000-0000-4000-8000-000000000001:message-a")
  })

  test("refreshes, inspects, reconnects, and removes workspace MCP snapshots", async () => {
    const token = generateClaudeWorkerGenerationToken()
    let transportRef: ClaudeWorkerTransport | null = null
    const runtime = new ClaudeMcpRuntime({
      now: () => 1_000,
      publishEvent: (type, payload) => transportRef!.publishEvent(type, payload),
    })
    const transport = await startClaudeWorkerTransport({
      generationToken: token,
      cliVersion: "2.1.226 (Claude Code)",
      mcpRuntime: runtime,
    })
    transportRef = transport
    transports.add(transport)
    const first = await fetch(`${transport.url}/v1/configuration/refresh`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace-a",
        revision: 1,
        generatedAt: 1_000,
        servers: { allowed: { type: "http", url: "https://allowed.example/mcp" } },
      }),
    })
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), {
      accepted: true,
      workspaceId: "workspace-a",
      revision: 1,
      added: ["allowed"],
      updated: [],
      removed: [],
    })
    const diagnostics = await fetch(`${transport.url}/v1/workspaces/workspace-a/mcp/diagnostics`, {
      headers: headers(token),
    })
    assert.equal(diagnostics.status, 200)
    assert.equal((await diagnostics.json() as { items: Array<{ serverName: string }> }).items[0]?.serverName, "allowed")
    const reconnect = await fetch(`${transport.url}/v1/workspaces/workspace-a/mcp/allowed/reconnect`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-a" }),
    })
    assert.equal(reconnect.status, 200)
    const removed = await fetch(`${transport.url}/v1/configuration/refresh`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-a", revision: 2, generatedAt: 1_001, servers: {} }),
    })
    assert.equal(removed.status, 200)
    assert.deepEqual((await removed.json() as { removed: string[] }).removed, ["allowed"])
  })
})
