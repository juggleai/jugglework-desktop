import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk"

export type ClaudeSandboxBackend = "seatbelt" | "bubblewrap" | "windows-sandbox" | "unsupported"

export interface ClaudeSandboxCapability {
  supported: boolean
  enabled: boolean
  failClosed: true
  allowUnsandboxedCommands: false
  backend: ClaudeSandboxBackend
  reasonCode: "sandbox_supported" | "sandbox_unsupported_host"
}

export function inspectClaudeSandboxCapability(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ClaudeSandboxCapability {
  const supportedArchitecture = architecture === "arm64" || architecture === "x64"
  const backend: ClaudeSandboxBackend = platform === "darwin" && supportedArchitecture ? "seatbelt"
    : platform === "linux" && supportedArchitecture ? "bubblewrap"
      : platform === "win32" && supportedArchitecture ? "windows-sandbox" : "unsupported"
  const supported = backend !== "unsupported"
  return {
    supported,
    enabled: supported,
    failClosed: true,
    allowUnsandboxedCommands: false,
    backend,
    reasonCode: supported ? "sandbox_supported" : "sandbox_unsupported_host",
  }
}

export function failClosedClaudeSandboxSettings(capability: ClaudeSandboxCapability): SandboxSettings {
  if (!capability.supported) throw new Error("Claude sandbox is not supported on this host")
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
  }
}
