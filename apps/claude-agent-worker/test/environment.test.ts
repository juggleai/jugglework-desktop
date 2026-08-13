import assert from "node:assert/strict"
import { describe, it } from "node:test"
import path from "node:path"

import {
  assertIsolatedClaudeConfigDirectory,
  buildClaudeSubprocessEnvironment,
  scrubClaudeSubprocessSecrets,
} from "../src/environment.ts"

describe("Claude subprocess environment", () => {
  it("passes only the allowlist, isolated config, and Anthropic credential", () => {
    const root = path.resolve("/jugglework/profile/claude-agent")
    const environment = buildClaudeSubprocessEnvironment({
      PATH: "/bin",
      HOME: "/profile",
      JUGGLEWORK_CLAUDE_PROFILE_DATA_DIR: root,
      CLAUDE_CONFIG_DIR: path.join(root, "config"),
      ANTHROPIC_API_KEY: "sk-ant-worker-secret",
      AWS_SECRET_ACCESS_KEY: "must-not-inherit",
      JUGGLEWORK_CLAUDE_WORKER_TOKEN: "must-not-inherit",
      RANDOM_PARENT_VALUE: "must-not-inherit",
    })

    assert.deepEqual(environment, {
      PATH: "/bin",
      HOME: "/profile",
      CLAUDE_CONFIG_DIR: path.join(root, "config"),
      ANTHROPIC_API_KEY: "sk-ant-worker-secret",
    })
  })

  it("rejects config outside the JuggleWork profile root", () => {
    assert.throws(() => assertIsolatedClaudeConfigDirectory({
      JUGGLEWORK_CLAUDE_PROFILE_DATA_DIR: path.resolve("/jugglework/profile/claude-agent"),
      CLAUDE_CONFIG_DIR: path.resolve("/standalone/.claude"),
    }), /must be contained/)
  })

  it("passes the official Vertex contract without unrelated worker secrets", () => {
    const root = path.resolve("/jugglework/profile/claude-agent")
    const environment = buildClaudeSubprocessEnvironment({
      JUGGLEWORK_CLAUDE_PROFILE_DATA_DIR: root,
      CLAUDE_CONFIG_DIR: path.join(root, "config"),
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "global",
      ANTHROPIC_VERTEX_PROJECT_ID: "fixture-project",
      GOOGLE_APPLICATION_CREDENTIALS: path.join(root, "credentials", "fixture-adc.json"),
      JUGGLEWORK_CLAUDE_WORKER_TOKEN: "must-not-inherit",
    })
    assert.deepEqual(environment, {
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "global",
      ANTHROPIC_VERTEX_PROJECT_ID: "fixture-project",
      GOOGLE_APPLICATION_CREDENTIALS: path.join(root, "credentials", "fixture-adc.json"),
      CLAUDE_CONFIG_DIR: path.join(root, "config"),
    })
  })

  it("rejects conflicting or absent provider contracts", () => {
    const root = path.resolve("/jugglework/profile/claude-agent")
    const base = { JUGGLEWORK_CLAUDE_PROFILE_DATA_DIR: root, CLAUDE_CONFIG_DIR: path.join(root, "config") }
    assert.throws(() => buildClaudeSubprocessEnvironment(base), /Exactly one/)
    assert.throws(() => buildClaudeSubprocessEnvironment({
      ...base,
      ANTHROPIC_API_KEY: "fixture-only",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "fixture-resource",
      ANTHROPIC_FOUNDRY_API_KEY: "fixture-only-foundry",
    }), /Exactly one/)
    assert.throws(() => buildClaudeSubprocessEnvironment({
      ...base,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
    }), /Bedrock credential contract is incomplete/)
    assert.throws(() => buildClaudeSubprocessEnvironment({
      ...base,
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "fixture-resource",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://fixture.example.test",
      ANTHROPIC_FOUNDRY_API_KEY: "fixture-only",
    }), /Foundry credential contract is incomplete/)
  })

  it("scrubs injected and formatted credentials from errors", () => {
    const secret = "sk-ant-exact-canary"
    const output = scrubClaudeSubprocessSecrets(
      new Error(`provider failed ANTHROPIC_API_KEY=${secret} authorization=Bearer visible-token`),
      { ANTHROPIC_API_KEY: secret },
    )
    assert.doesNotMatch(output, /exact-canary|visible-token/)
    assert.match(output, /\[REDACTED\]/)
  })
})
