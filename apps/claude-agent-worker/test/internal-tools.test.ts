import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createInternalToolBridge, createJuggleWorkSdkMcpServer } from "../src/internal-tools.ts"

const configuration = {
  url: "http://127.0.0.1:9999/v1/internal-tools/call",
  credential: "a".repeat(43),
  actor: "claude-worker" as const,
  schemaVersion: 1 as const,
  credentialExpiresAt: 2_000,
}

describe("JuggleWork internal SDK MCP tools", () => {
  test("builds exactly the narrow seven-tool SDK server", () => {
    const server = createJuggleWorkSdkMcpServer({ bridge: { call: async () => ({ ok: true }) } })
    const registered = (server.instance as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
    assert.deepEqual(Object.keys(registered ?? {}).sort(), ["artifact", "context", "execute", "query", "safe_glob", "search", "skill"])
  })

  test("sends scoped actor/workspace/session/schema/revision/side-effect on every call", async () => {
    let request: Request | undefined
    const bridge = createInternalToolBridge({
      configuration,
      run: { workspaceId: "workspace-a", sessionId: "session-a" },
      now: () => 1_000,
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json({ ok: true, result: { revision: 7 } })
      },
    })
    assert.deepEqual(await bridge.call("context", { expectedRevision: 0 }, "read"), { revision: 7 })
    const body = await request!.json()
    assert.deepEqual(body, {
      schemaVersion: 1,
      workspaceId: "workspace-a",
      sessionId: "session-a",
      actor: "claude-worker",
      tool: "context",
      sideEffect: "read",
      expectedRevision: 0,
      args: { expectedRevision: 0 },
    })
    assert.equal(request!.headers.get("x-jugglework-claude-tool-credential"), configuration.credential)
  })

  test("fails before dispatch when the worker-only credential is expired", async () => {
    const bridge = createInternalToolBridge({
      configuration,
      run: { workspaceId: "workspace-a", sessionId: "session-a" },
      now: () => 2_000,
      fetch: async () => { throw new Error("must not dispatch") },
    })
    await assert.rejects(bridge.call("query", { expectedRevision: 1, id: "session.snapshot" }, "read"), /credential expired/)
  })
})
