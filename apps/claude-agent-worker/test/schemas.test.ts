import assert from "node:assert/strict"
import { test } from "node:test"

import {
  CLAUDE_AGENT_SDK_VERSION,
  claudeWorkerCapabilitiesSchema,
  claudeWorkerGenerationTokenSchema,
} from "../src/schemas.ts"
import { generateClaudeWorkerGenerationToken } from "../src/transport.ts"

test("generation tokens carry 256 bits and use base64url encoding", () => {
  const token = generateClaudeWorkerGenerationToken()
  assert.equal(token.length, 43)
  assert.equal(claudeWorkerGenerationTokenSchema.parse(token), token)
  assert.throws(() => claudeWorkerGenerationTokenSchema.parse("short"))
})

test("capabilities require the exact SDK version", () => {
  const result = claudeWorkerCapabilitiesSchema.safeParse({
    protocolVersion: 1,
    sdkVersion: `${CLAUDE_AGENT_SDK_VERSION}-other`,
    cliVersion: "2.1.226 (Claude Code)",
  })
  assert.equal(result.success, false)
})
