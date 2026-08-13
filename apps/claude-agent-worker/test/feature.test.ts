import assert from "node:assert/strict"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import {
  inspectClaudeRuntimeAvailability,
  isClaudeAgentRuntimeEnabled,
} from "../src/feature.ts"

describe("Claude Agent runtime availability", () => {
  test("is disabled by default and only accepts explicit true values", () => {
    assert.equal(isClaudeAgentRuntimeEnabled({}), false)
    assert.equal(isClaudeAgentRuntimeEnabled({ JUGGLEWORK_CLAUDE_AGENT_ENABLED: "false" }), false)
    assert.equal(isClaudeAgentRuntimeEnabled({ JUGGLEWORK_CLAUDE_AGENT_ENABLED: "1" }), true)
    assert.equal(isClaudeAgentRuntimeEnabled({ JUGGLEWORK_CLAUDE_AGENT_ENABLED: "ON" }), true)
  })

  test("returns actionable disabled and unsupported-host diagnostics", async () => {
    const disabled = await inspectClaudeRuntimeAvailability({ env: {}, checkPaths: false })
    assert.equal(disabled.status, "disabled")
    assert.equal(disabled.reasonCode, "feature_disabled")

    const unsupported = await inspectClaudeRuntimeAvailability({
      env: { JUGGLEWORK_CLAUDE_AGENT_ENABLED: "1" },
      platform: "aix",
      architecture: "ppc64",
      checkPaths: false,
    })
    assert.equal(unsupported.status, "unavailable")
    assert.equal(unsupported.reasonCode, "unsupported_platform")
  })

  test("distinguishes Node, worker, and Claude executable provisioning", async () => {
    const base = {
      env: { JUGGLEWORK_CLAUDE_AGENT_ENABLED: "1" },
      platform: "darwin" as const,
      architecture: "arm64",
      checkPaths: false,
    }
    assert.equal((await inspectClaudeRuntimeAvailability({ ...base, nodeVersion: "22.0.0" })).reasonCode, "unsupported_node_version")
    assert.equal((await inspectClaudeRuntimeAvailability({ ...base, nodeVersion: "24.0.0" })).reasonCode, "worker_not_provisioned")
    assert.equal((await inspectClaudeRuntimeAvailability({
      ...base,
      nodeVersion: "24.0.0",
      workerPath: "/worker",
    })).reasonCode, "claude_executable_not_provisioned")
    assert.equal((await inspectClaudeRuntimeAvailability({
      ...base,
      nodeVersion: "24.0.0",
      workerPath: "/worker",
      claudeExecutablePath: "/claude",
    })).status, "healthy")
  })

  test("requires a readable worker entry and executable Claude binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-claude-worker-"))
    const workerPath = join(root, "worker.js")
    const claudeExecutablePath = join(root, "claude")
    await writeFile(workerPath, "export {}\n", { mode: 0o600 })
    await writeFile(claudeExecutablePath, "#!/bin/sh\n", { mode: 0o600 })

    const options = {
      env: { JUGGLEWORK_CLAUDE_AGENT_ENABLED: "1" },
      platform: "darwin" as const,
      architecture: "arm64",
      nodeVersion: "24.0.0",
      workerPath,
      claudeExecutablePath,
    }
    assert.equal((await inspectClaudeRuntimeAvailability(options)).reasonCode, "claude_executable_not_provisioned")
    await chmod(claudeExecutablePath, 0o700)
    assert.equal((await inspectClaudeRuntimeAvailability(options)).status, "healthy")
  })
})
