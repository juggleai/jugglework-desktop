#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"

import { ClaudeRunService } from "./execution.js"
import {
  CLAUDE_AGENT_WORKER_PATH_ENV,
  CLAUDE_EXECUTABLE_PATH_ENV,
  inspectClaudeRuntimeAvailability,
} from "./feature.js"
import { assertIsolatedClaudeConfigDirectory } from "./environment.js"
import { startClaudeWorkerTransport, type ClaudeWorkerTransport } from "./transport.js"
import { ClaudeMcpRuntime } from "./mcp-runtime.js"
import { inspectClaudeSandboxCapability } from "./sandbox.js"
import type { ClaudeRunController } from "./execution.js"
import type { ClaudeWorkerRunObservation } from "./schemas.js"

const token = process.env.JUGGLEWORK_CLAUDE_WORKER_TOKEN
if (!token) throw new Error("JUGGLEWORK_CLAUDE_WORKER_TOKEN is required")

const host = process.env.JUGGLEWORK_CLAUDE_WORKER_HOST === "::1" ? "::1" : "127.0.0.1"
const port = Number(process.env.JUGGLEWORK_CLAUDE_WORKER_PORT ?? "0")
assertIsolatedClaudeConfigDirectory(process.env)
const availability = await inspectClaudeRuntimeAvailability({
  workerPath: process.env[CLAUDE_AGENT_WORKER_PATH_ENV] ?? process.argv[1],
  claudeExecutablePath: process.env[CLAUDE_EXECUTABLE_PATH_ENV],
})
if (availability.status !== "healthy") {
  throw new Error(`${availability.reasonCode}: ${availability.message}`)
}

const claudeExecutablePath = process.env[CLAUDE_EXECUTABLE_PATH_ENV]
if (!claudeExecutablePath) throw new Error(`${CLAUDE_EXECUTABLE_PATH_ENV} is required`)
const cliVersionProbe = spawnSync(claudeExecutablePath, ["--version"], {
  encoding: "utf8",
  env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  },
  timeout: 10_000,
  windowsHide: true,
})
const cliVersion = String(cliVersionProbe.stdout || cliVersionProbe.stderr || "").trim()
if (cliVersionProbe.status !== 0 || !cliVersion) throw new Error("Claude executable version probe failed")
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR
if (!claudeConfigDir) throw new Error("CLAUDE_CONFIG_DIR is required")
await mkdir(claudeConfigDir, { recursive: true, mode: 0o700 })
const sandboxCapability = inspectClaudeSandboxCapability()
if (!sandboxCapability.supported && process.env.JUGGLEWORK_CLAUDE_PACKAGE_SMOKE !== "1") {
  throw new Error("sandbox_unsupported_host: Claude Agent requires the fail-closed SDK sandbox")
}

function createPackageSmokeRunController(
  publishEvent: Parameters<NonNullable<Parameters<typeof startClaudeWorkerTransport>[0]["createRunController"]>>[0],
): ClaudeRunController {
  const runs = new Map<string, ClaudeWorkerRunObservation>()
  return {
    async start(input) {
      const observation: ClaudeWorkerRunObservation = {
        runId: input.runId,
        sessionId: input.sessionId,
        backendSessionId: input.backendSessionId ?? randomUUID(),
        status: "running",
        terminal: false,
        errorCode: null,
      }
      runs.set(input.runId, observation)
      publishEvent("session.initialized", {
        sessionId: input.sessionId,
        backendSessionId: observation.backendSessionId,
      })
      publishEvent("session.status", { sessionId: input.sessionId, status: { type: "running" } })
      return { accepted: true, runId: input.runId, status: "starting" }
    },
    async abort(sessionId, runId) {
      const current = runs.get(runId)
      if (!current || current.sessionId !== sessionId) return
      runs.set(runId, { ...current, status: "aborted", terminal: true })
      publishEvent("run.aborted", { sessionId, runId, reason: "package_smoke" })
    },
    observe(runId) {
      return runs.get(runId) ?? null
    },
    async resolveInteraction() {},
    async closeAll() {
      for (const [runId, current] of runs) {
        if (!current.terminal) await this.abort(current.sessionId, runId)
      }
    },
  }
}

let mcpRuntime!: ClaudeMcpRuntime
let transportRef: ClaudeWorkerTransport | null = null
const transport = await startClaudeWorkerTransport({
  generationToken: token,
  cliVersion,
  host,
  port,
  sandboxCapability,
  mcpRuntime: mcpRuntime = new ClaudeMcpRuntime({
    publishEvent: (type, payload) => {
      if (!transportRef) throw new Error("Claude worker transport is not ready")
      return transportRef.publishEvent(type, payload)
    },
  }),
  createRunController: (publishEvent) => process.env.JUGGLEWORK_CLAUDE_PACKAGE_SMOKE === "1"
    ? createPackageSmokeRunController(publishEvent)
    : new ClaudeRunService({ claudeExecutablePath, claudeConfigDir, publishEvent, mcpRuntime }),
})
transportRef = transport
process.stdout.write(`${JSON.stringify({ type: "ready", url: transport.url })}\n`)

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await transport.close()
}

process.once("SIGINT", () => void stop())
process.once("SIGTERM", () => void stop())
