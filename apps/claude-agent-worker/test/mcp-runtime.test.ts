import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { McpServerConfig, Query } from "@anthropic-ai/claude-agent-sdk"

import { ClaudeMcpRuntime, ClaudeMcpRuntimeError } from "../src/mcp-runtime.ts"
import type { ClaudeWorkerEvent } from "../src/schemas.ts"

function harness(now = 1_000) {
  const events: ClaudeWorkerEvent[] = []
  let sequence = 0
  const runtime = new ClaudeMcpRuntime({
    now: () => now,
    publishEvent: (type, payload = {}) => {
      const event: ClaudeWorkerEvent = {
        protocolVersion: 1,
        sequence: ++sequence,
        id: `event-${sequence}`,
        type,
        createdAt: new Date(now).toISOString(),
        payload,
      }
      events.push(event)
      return event
    },
  })
  return { runtime, events }
}

function query(calls: unknown[]): Query {
  return {
    setMcpServers: async (servers: Record<string, McpServerConfig>) => {
      calls.push(servers)
      return { added: Object.keys(servers), removed: [], errors: {} }
    },
    reconnectMcpServer: async (name: string) => { calls.push(`reconnect:${name}`) },
  } as unknown as Query
}

describe("Claude worker MCP runtime", () => {
  test("isolates workspace snapshots and expires credentials before SDK initialization", async () => {
    const { runtime } = harness()
    await runtime.refresh({
      workspaceId: "workspace-a",
      revision: 1,
      generatedAt: 1_000,
      servers: {
        live: { type: "http", url: "https://live.example/mcp", headers: { Authorization: "Bearer live" }, credentialExpiresAt: 2_000 },
        expired: { type: "http", url: "https://expired.example/mcp", headers: { Authorization: "Bearer expired" }, credentialExpiresAt: 1_000 },
      },
    })
    assert.deepEqual(Object.keys(runtime.configurationForRun({ workspaceId: "workspace-a", sessionId: "session-a" })), ["live"])
    assert.deepEqual(runtime.configurationForRun({ workspaceId: "workspace-b", sessionId: "session-b" }), {})
    assert.equal(runtime.diagnostics("workspace-a").items.find(({ serverName }: { serverName: string }) => serverName === "expired")?.code, "mcp_credential_expired")
  })

  test("dynamically adds, updates, removes, reconnects, and rejects stale reloads", async () => {
    const { runtime } = harness()
    const calls: unknown[] = []
    runtime.attachQuery("workspace-a", query(calls))
    await runtime.refresh({ workspaceId: "workspace-a", revision: 1, generatedAt: 1_000, servers: { alpha: { type: "http", url: "https://a.example/mcp" } } })
    const result = await runtime.refresh({ workspaceId: "workspace-a", revision: 2, generatedAt: 1_001, servers: { beta: { type: "sse", url: "https://b.example/sse" } } })
    assert.deepEqual(result, { accepted: true, workspaceId: "workspace-a", revision: 2, added: ["beta"], updated: [], removed: ["alpha"] })
    await runtime.reconnect("workspace-a", "beta")
    assert.equal(calls.at(-1), "reconnect:beta")
    await assert.rejects(
      runtime.refresh({ workspaceId: "workspace-a", revision: 1, generatedAt: 999, servers: {} }),
      (error: unknown) => error instanceof ClaudeMcpRuntimeError && error.code === "configuration_stale",
    )
  })

  test("bounds and redacts internal/external handler output and isolates crashes", async () => {
    const { runtime } = harness()
    const bounded = await runtime.executeHandler({
      workspaceId: "workspace-a",
      serverName: "jugglework",
      maxOutputBytes: 256,
      handler: () => ({ Authorization: "Bearer token-canary", content: "x".repeat(2_000), nested: { api_key: "secret-canary" } }),
    })
    assert.equal(bounded.truncated, true)
    assert.doesNotMatch(JSON.stringify(bounded.value), /token-canary|secret-canary/)
    assert.equal(runtime.diagnostics("workspace-a").items[0]?.code, "mcp_output_truncated")

    await assert.rejects(runtime.executeHandler({
      workspaceId: "workspace-b",
      serverName: "external",
      handler: () => { throw new Error("handler secret-canary") },
    }), /MCP handler failed/)
    assert.equal(runtime.diagnostics("workspace-b").items[0]?.code, "mcp_handler_failed")
    assert.doesNotMatch(JSON.stringify(runtime.diagnostics("workspace-b")), /secret-canary/)
  })

  test("never accepts interactive OAuth elicitation in the agent process", () => {
    const { runtime } = harness()
    assert.deepEqual(runtime.rejectInteractiveOAuth("workspace-a", "cloud"), { action: "decline" })
    assert.equal(runtime.diagnostics("workspace-a").items[0]?.state, "needs_auth")
  })
})
