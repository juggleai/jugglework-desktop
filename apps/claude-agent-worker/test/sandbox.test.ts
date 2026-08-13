import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { failClosedClaudeSandboxSettings, inspectClaudeSandboxCapability } from "../src/sandbox.ts"

describe("Claude SDK sandbox", () => {
  test("reports supported host backends without allowing unsandboxed commands", () => {
    assert.deepEqual(inspectClaudeSandboxCapability("darwin", "arm64"), {
      supported: true,
      enabled: true,
      failClosed: true,
      allowUnsandboxedCommands: false,
      backend: "seatbelt",
      reasonCode: "sandbox_supported",
    })
    assert.equal(inspectClaudeSandboxCapability("linux", "x64").backend, "bubblewrap")
    assert.equal(inspectClaudeSandboxCapability("win32", "arm64").backend, "windows-sandbox")
  })

  test("fails closed on unsupported hosts and emits restrictive SDK settings", () => {
    const unsupported = inspectClaudeSandboxCapability("freebsd", "x64")
    assert.deepEqual(unsupported, {
      supported: false,
      enabled: false,
      failClosed: true,
      allowUnsandboxedCommands: false,
      backend: "unsupported",
      reasonCode: "sandbox_unsupported_host",
    })
    assert.throws(() => failClosedClaudeSandboxSettings(unsupported), /not supported/)
    assert.deepEqual(failClosedClaudeSandboxSettings(inspectClaudeSandboxCapability("darwin", "x64")), {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true, allowAllUnixSockets: false, allowLocalBinding: false },
    })
  })
})
