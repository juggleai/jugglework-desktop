const WORKER_INHERITED_ENV = [
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
  "JUGGLEWORK_CLAUDE_PREWARM_ENABLED",
  "JUGGLEWORK_CLAUDE_PREWARM_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_PREWARM_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_PREWARM_POOL_SIZE",
  "JUGGLEWORK_CLAUDE_PREWARM_IDLE_MS",
  "JUGGLEWORK_CLAUDE_RESIDENT_SESSIONS_ENABLED",
  "JUGGLEWORK_CLAUDE_RESIDENT_SESSIONS_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_RESIDENT_SESSIONS_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_RESIDENT_IDLE_MS",
  "JUGGLEWORK_CLAUDE_PROTOCOL_INTERRUPT_ENABLED",
  "JUGGLEWORK_CLAUDE_PROTOCOL_INTERRUPT_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_PROTOCOL_INTERRUPT_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_QUEUED_INPUT_ENABLED",
  "JUGGLEWORK_CLAUDE_QUEUED_INPUT_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_QUEUED_INPUT_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_STEER_ENABLED",
  "JUGGLEWORK_CLAUDE_STEER_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_STEER_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_DYNAMIC_MODEL_ENABLED",
  "JUGGLEWORK_CLAUDE_DYNAMIC_MODEL_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_DYNAMIC_MODEL_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_DYNAMIC_EFFORT_ENABLED",
  "JUGGLEWORK_CLAUDE_DYNAMIC_EFFORT_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_DYNAMIC_EFFORT_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_DYNAMIC_PERMISSION_MODE_ENABLED",
  "JUGGLEWORK_CLAUDE_DYNAMIC_PERMISSION_MODE_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_DYNAMIC_PERMISSION_MODE_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_SUBAGENTS_ENABLED",
  "JUGGLEWORK_CLAUDE_SUBAGENTS_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_SUBAGENTS_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_PLAN_MODE_ENABLED",
  "JUGGLEWORK_CLAUDE_PLAN_MODE_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_PLAN_MODE_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_FILE_CHECKPOINTING_ENABLED",
  "JUGGLEWORK_CLAUDE_FILE_CHECKPOINTING_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_FILE_CHECKPOINTING_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_REWIND_ENABLED",
  "JUGGLEWORK_CLAUDE_REWIND_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_REWIND_KILL_SWITCH",
  "JUGGLEWORK_CLAUDE_NATIVE_FORK_ENABLED",
  "JUGGLEWORK_CLAUDE_NATIVE_FORK_POLICY_ALLOWED",
  "JUGGLEWORK_CLAUDE_NATIVE_FORK_KILL_SWITCH",
] as const;

const CLAUDE_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLAUDE_CODE_USE_VERTEX",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
] as const;

const SECRET_ENV_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
]);
const SECRET_ASSIGNMENT = /\b(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|FOUNDRY_(?:API_KEY|AUTH_TOKEN))|AWS_(?:BEARER_TOKEN_BEDROCK|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)\s*[=:]\s*([^\s,;]+)/gi;
const KNOWN_SECRET_FORMAT = /\b(?:sk-ant-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]+=*)\b/gi;

function credentialEnvironment(input: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const unknown = Object.keys(input).filter((name) => !(CLAUDE_CREDENTIAL_ENV as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error("Claude credential broker returned unsupported environment variables");
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CLAUDE_CREDENTIAL_ENV) {
    const value = input[name];
    if (value === undefined) continue;
    if (!value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
      throw new Error(`Claude credential broker returned invalid ${SECRET_ENV_NAMES.has(name) ? "secret" : "configuration"}`);
    }
    environment[name] = value;
  }
  return environment;
}

function additionalEnvironment(input: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    if (
      !(WORKER_INHERITED_ENV as readonly string[]).includes(name)
      && name !== "JUGGLEWORK_CLAUDE_PACKAGE_SMOKE"
      && !name.startsWith("FAKE_WORKER_")
    ) {
      throw new Error("Claude worker additional environment contains an unsupported variable");
    }
    if (typeof value === "string" && value.length > 0 && !/[\r\n\0]/.test(value)) environment[name] = value;
  }
  return environment;
}

export function scrubClaudeSecrets(value: unknown, secretValues: readonly string[] = []): string {
  let output = value instanceof Error ? value.message : String(value);
  for (const secret of secretValues) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  return output
    .replace(SECRET_ASSIGNMENT, (match, assigned: string) => match.replace(assigned, "[REDACTED]"))
    .replace(KNOWN_SECRET_FORMAT, "[REDACTED]");
}

export function buildClaudeWorkerEnvironment(input: {
  inheritedEnv?: NodeJS.ProcessEnv;
  workerPath: string;
  claudeExecutablePath: string;
  profileDataDir: string;
  claudeConfigDir: string;
  generationToken: string;
  credentialEnvironment: Readonly<NodeJS.ProcessEnv>;
  additionalEnvironment?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const inheritedEnv = input.inheritedEnv ?? {};
  const environment: NodeJS.ProcessEnv = {};
  for (const name of WORKER_INHERITED_ENV) {
    const value = inheritedEnv[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  return {
    ...environment,
    ...additionalEnvironment(input.additionalEnvironment),
    JUGGLEWORK_CLAUDE_AGENT_ENABLED: "1",
    JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH: input.workerPath,
    JUGGLEWORK_CLAUDE_EXECUTABLE_PATH: input.claudeExecutablePath,
    JUGGLEWORK_CLAUDE_PROFILE_DATA_DIR: input.profileDataDir,
    JUGGLEWORK_CLAUDE_WORKER_TOKEN: input.generationToken,
    JUGGLEWORK_CLAUDE_WORKER_HOST: "127.0.0.1",
    JUGGLEWORK_CLAUDE_WORKER_PORT: "0",
    CLAUDE_CONFIG_DIR: input.claudeConfigDir,
    ...credentialEnvironment(input.credentialEnvironment),
  };
}
