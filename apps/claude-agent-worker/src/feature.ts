import { access } from "node:fs/promises"
import { constants } from "node:fs"

import {
  CLAUDE_WORKER_PROTOCOL_VERSION,
  type ClaudeWorkerHealth,
  claudeWorkerHealthSchema,
} from "./schemas.js"

export const CLAUDE_AGENT_RUNTIME_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_AGENT_ENABLED" as const
export const CLAUDE_AGENT_WORKER_PATH_ENV = "JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH" as const
export const CLAUDE_EXECUTABLE_PATH_ENV = "JUGGLEWORK_CLAUDE_EXECUTABLE_PATH" as const
export const CLAUDE_WORKER_MINIMUM_NODE_MAJOR = 24

const supportedArchitectures: Readonly<Record<NodeJS.Platform, readonly string[] | undefined>> = {
  aix: undefined,
  android: undefined,
  darwin: ["arm64", "x64"],
  freebsd: undefined,
  haiku: undefined,
  linux: ["arm64", "x64"],
  openbsd: undefined,
  sunos: undefined,
  win32: ["arm64", "x64"],
  cygwin: undefined,
  netbsd: undefined,
}

export interface ClaudeRuntimeAvailabilityOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  architecture?: string
  nodeVersion?: string
  workerPath?: string | null
  claudeExecutablePath?: string | null
  checkPaths?: boolean
}

function health(
  status: ClaudeWorkerHealth["status"],
  reasonCode: ClaudeWorkerHealth["reasonCode"],
  message: string | null,
): ClaudeWorkerHealth {
  return claudeWorkerHealthSchema.parse({
    protocolVersion: CLAUDE_WORKER_PROTOCOL_VERSION,
    status,
    checkedAt: new Date().toISOString(),
    reasonCode,
    message,
  })
}

export function isClaudeAgentRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CLAUDE_AGENT_RUNTIME_FEATURE_FLAG]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

async function isAccessible(
  path: string | null | undefined,
  checkPaths: boolean,
  mode: number,
): Promise<boolean> {
  if (!path?.trim()) return false
  if (!checkPaths) return true
  try {
    await access(path, mode)
    return true
  } catch {
    return false
  }
}

export async function inspectClaudeRuntimeAvailability(
  options: ClaudeRuntimeAvailabilityOptions = {},
): Promise<ClaudeWorkerHealth> {
  const env = options.env ?? process.env
  if (!isClaudeAgentRuntimeEnabled(env)) {
    return health("disabled", "feature_disabled", `Set ${CLAUDE_AGENT_RUNTIME_FEATURE_FLAG}=1 to enable Claude Agent.`)
  }

  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const platformArchitectures = supportedArchitectures[platform]
  if (!platformArchitectures) {
    return health("unavailable", "unsupported_platform", `Claude Agent is not supported on ${platform}.`)
  }
  if (!platformArchitectures.includes(architecture)) {
    return health(
      "unavailable",
      "unsupported_architecture",
      `Claude Agent is not supported on ${platform}/${architecture}.`,
    )
  }

  const nodeVersion = options.nodeVersion ?? process.versions.node
  const nodeMajor = Number.parseInt(nodeVersion.split(".", 1)[0] ?? "", 10)
  if (!Number.isInteger(nodeMajor) || nodeMajor < CLAUDE_WORKER_MINIMUM_NODE_MAJOR) {
    return health(
      "unavailable",
      "unsupported_node_version",
      `Claude Agent Worker requires Node ${CLAUDE_WORKER_MINIMUM_NODE_MAJOR} or newer.`,
    )
  }

  const checkPaths = options.checkPaths ?? true
  const workerPath = options.workerPath ?? env[CLAUDE_AGENT_WORKER_PATH_ENV]
  if (!await isAccessible(workerPath, checkPaths, constants.R_OK)) {
    return health(
      "unavailable",
      "worker_not_provisioned",
      `Configure a readable worker entry with ${CLAUDE_AGENT_WORKER_PATH_ENV}.`,
    )
  }

  const claudeExecutablePath = options.claudeExecutablePath ?? env[CLAUDE_EXECUTABLE_PATH_ENV]
  if (!await isAccessible(claudeExecutablePath, checkPaths, constants.R_OK | constants.X_OK)) {
    return health(
      "unavailable",
      "claude_executable_not_provisioned",
      `Configure an executable Claude binary with ${CLAUDE_EXECUTABLE_PATH_ENV}.`,
    )
  }

  return health("healthy", "worker_ready", "Claude Agent runtime assets are provisioned for this host.")
}
