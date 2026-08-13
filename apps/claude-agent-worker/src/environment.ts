import { isAbsolute, relative } from "node:path"

const CLAUDE_INHERITED_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const

const SECRET_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
] as const
const ANTHROPIC_PROVIDER_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const
const BEDROCK_PROVIDER_ENV = [
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const
const VERTEX_PROVIDER_ENV = [
  "CLAUDE_CODE_USE_VERTEX",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const
const FOUNDRY_PROVIDER_ENV = [
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
] as const
const SECRET_ASSIGNMENT = /\b(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|FOUNDRY_(?:API_KEY|AUTH_TOKEN))|AWS_(?:BEARER_TOKEN_BEDROCK|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)\s*[=:]\s*([^\s,;]+)/gi
const KNOWN_SECRET_FORMAT = /\b(?:sk-ant-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]+=*)\b/gi

export function scrubClaudeSubprocessSecrets(value: unknown, env: NodeJS.ProcessEnv = {}): string {
  let output = value instanceof Error ? value.message : String(value)
  for (const name of SECRET_ENV) {
    const secret = env[name]
    if (secret) output = output.split(secret).join("[REDACTED]")
  }
  return output
    .replace(SECRET_ASSIGNMENT, (match, assigned: string) => match.replace(assigned, "[REDACTED]"))
    .replace(KNOWN_SECRET_FORMAT, "[REDACTED]")
}

export function assertIsolatedClaudeConfigDirectory(env: NodeJS.ProcessEnv): {
  profileDataDir: string
  configDir: string
} {
  const profileDataDir = env.JUGGLEWORK_CLAUDE_PROFILE_DATA_DIR?.trim() ?? ""
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() ?? ""
  if (!isAbsolute(profileDataDir) || !isAbsolute(configDir)) {
    throw new Error("Claude profile and config directories must be absolute")
  }
  const relativeConfig = relative(profileDataDir, configDir)
  if (!relativeConfig || relativeConfig.startsWith("..") || isAbsolute(relativeConfig)) {
    throw new Error("CLAUDE_CONFIG_DIR must be contained by the JuggleWork profile data directory")
  }
  return { profileDataDir, configDir }
}

export function buildClaudeSubprocessEnvironment(workerEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { configDir } = assertIsolatedClaudeConfigDirectory(workerEnv)
  const environment: NodeJS.ProcessEnv = {}
  for (const name of CLAUDE_INHERITED_ENV) {
    const value = workerEnv[name]
    if (typeof value === "string" && value.length > 0) environment[name] = value
  }
  const providerContracts = [
    { enabled: Boolean(workerEnv.ANTHROPIC_API_KEY || workerEnv.ANTHROPIC_AUTH_TOKEN), names: ANTHROPIC_PROVIDER_ENV },
    { enabled: workerEnv.CLAUDE_CODE_USE_BEDROCK === "1", names: BEDROCK_PROVIDER_ENV },
    { enabled: workerEnv.CLAUDE_CODE_USE_VERTEX === "1", names: VERTEX_PROVIDER_ENV },
    { enabled: workerEnv.CLAUDE_CODE_USE_FOUNDRY === "1", names: FOUNDRY_PROVIDER_ENV },
  ]
  const selected = providerContracts.filter((provider) => provider.enabled)
  if (selected.length !== 1) throw new Error("Exactly one Claude credential provider is required")
  if (selected[0]!.names === ANTHROPIC_PROVIDER_ENV) {
    if (Boolean(workerEnv.ANTHROPIC_API_KEY) === Boolean(workerEnv.ANTHROPIC_AUTH_TOKEN)) {
      throw new Error("Exactly one Anthropic credential is required")
    }
  } else if (selected[0]!.names === BEDROCK_PROVIDER_ENV) {
    const bearer = Boolean(workerEnv.AWS_BEARER_TOKEN_BEDROCK)
    const accessKey = Boolean(workerEnv.AWS_ACCESS_KEY_ID && workerEnv.AWS_SECRET_ACCESS_KEY)
    if (bearer === accessKey || !workerEnv.AWS_REGION) throw new Error("Bedrock credential contract is incomplete")
  } else if (selected[0]!.names === VERTEX_PROVIDER_ENV) {
    if (!workerEnv.CLOUD_ML_REGION || !workerEnv.ANTHROPIC_VERTEX_PROJECT_ID || !workerEnv.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error("Vertex credential contract is incomplete")
    }
  } else {
    const endpoint = Boolean(workerEnv.ANTHROPIC_FOUNDRY_RESOURCE) !== Boolean(workerEnv.ANTHROPIC_FOUNDRY_BASE_URL)
    const credential = Boolean(workerEnv.ANTHROPIC_FOUNDRY_API_KEY) !== Boolean(workerEnv.ANTHROPIC_FOUNDRY_AUTH_TOKEN)
    if (!endpoint || !credential) throw new Error("Foundry credential contract is incomplete")
  }
  for (const name of selected[0]!.names) {
    const value = workerEnv[name]
    if (value === undefined) continue
    if (!value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
      throw new Error("Claude provider environment is invalid")
    }
    environment[name] = value
  }
  environment.CLAUDE_CONFIG_DIR = configDir
  return environment
}
