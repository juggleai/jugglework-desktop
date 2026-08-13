import { randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const secretCanary = "sk-ant-package-smoke-must-not-leak"
const root = resolve(process.argv[2] || process.env.JUGGLEWORK_CLAUDE_ASSETS_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "package"))
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))
const paths = Object.fromEntries(Object.entries(manifest.paths).map(([name, value]) => [name, join(root, String(value))]))
const profile = await mkdtemp(join(tmpdir(), "jugglework-claude-package-smoke-"))
const token = randomBytes(32).toString("base64url")
let stdout = ""
let stderr = ""
let child

function headers() {
  return { "x-jugglework-worker-token": token, "content-type": "application/json" }
}

async function waitForReady() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const lineEnd = stdout.indexOf("\n")
    if (lineEnd >= 0) {
      const line = stdout.slice(0, lineEnd)
      try {
        const value = JSON.parse(line)
        if (value.type === "ready" && typeof value.url === "string") return value.url
      } catch {}
    }
    if (child.exitCode !== null) throw new Error(`Worker exited before readiness: ${stderr}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Worker readiness timed out: ${stderr}`)
}

try {
  child = spawn(paths.node, [paths.worker], {
    cwd: dirname(paths.worker),
    env: {
      PATH: process.env.PATH,
      HOME: profile,
      TMPDIR: profile,
      JUGGLEWORK_CLAUDE_AGENT_ENABLED: "1",
      JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH: paths.worker,
      JUGGLEWORK_CLAUDE_EXECUTABLE_PATH: paths.claude,
      JUGGLEWORK_CLAUDE_PROFILE_DATA_DIR: profile,
      JUGGLEWORK_CLAUDE_WORKER_TOKEN: token,
      JUGGLEWORK_CLAUDE_PACKAGE_SMOKE: "1",
      CLAUDE_CONFIG_DIR: join(profile, "config"),
      ANTHROPIC_API_KEY: secretCanary,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const url = await waitForReady()
  const capabilities = await fetch(`${url}/v1/capabilities`, { headers: headers() }).then((response) => response.json())
  if (capabilities.sdkVersion !== manifest.sdkVersion || !String(capabilities.cliVersion).includes(manifest.cliVersion)) {
    throw new Error(`Version diagnostics mismatch: ${JSON.stringify(capabilities)}`)
  }
  const sessionId = `smoke-${randomUUID()}`
  const runId = `smoke-${randomUUID()}`
  const run = await fetch(`${url}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      workspaceId: "package-smoke",
      sessionId,
      runId,
      backendSessionId: null,
      cwd: profile,
      prompt: "package smoke fixture",
      delivery: "start",
      limits: { maxTurns: 1, maxBudgetUsd: 1, wallClockMs: 10_000, hardCloseMs: 100 },
    }),
  }).then((response) => response.json())
  if (run.accepted !== true) throw new Error(`Worker initialization fixture failed: ${JSON.stringify(run)}`)
  await fetch(`${url}/v1/runs/${encodeURIComponent(runId)}/abort`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ sessionId, runId }),
  })
  const observation = await fetch(`${url}/v1/runs/${encodeURIComponent(runId)}`, { headers: headers() }).then((response) => response.json())
  if (observation.status !== "aborted" || observation.terminal !== true) throw new Error(`Cancellation fixture failed: ${JSON.stringify(observation)}`)
  await fetch(`${url}/v1/shutdown`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ reason: "package smoke complete" }),
  })
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolveExit, rejectExit) => {
        child.once("exit", resolveExit)
        child.once("error", rejectExit)
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Worker shutdown timed out")), 5_000)),
    ])
  }
  if (`${stdout}\n${stderr}`.includes(secretCanary)) throw new Error("Secret canary leaked into worker output")
  process.stdout.write(`${JSON.stringify({ ok: true, target: manifest.target, sdkVersion: capabilities.sdkVersion, cliVersion: capabilities.cliVersion, nodeVersion: capabilities.nodeVersion })}\n`)
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL")
  await rm(profile, { recursive: true, force: true })
}
