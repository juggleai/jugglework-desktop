import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type CliCommand = "run" | "resume" | "sessions" | "status";

export type CliOptions = {
  command: CliCommand;
  prompt: string | null;
  sessionId: string | null;
  continueLatest: boolean;
  serverUrl: string | null;
  token: string | null;
  hostToken: string | null;
  workspace: string;
  workspaceExplicit: boolean;
  workspaceId: string | null;
  opencodeBin: string | null;
  pluginDir: string | null;
  model: string | null;
  agent: string | null;
  reasoningEffort: string | null;
  title: string | null;
  fullAccess: boolean;
  json: boolean;
  color: boolean;
  configPath: string;
  timeoutMs: number;
  help: boolean;
  version: boolean;
};

export type CliConfigFile = Partial<Pick<CliOptions,
  "serverUrl" | "token" | "hostToken" | "workspace" | "workspaceId" |
  "opencodeBin" | "pluginDir" | "model" | "agent" | "reasoningEffort"
>>;

const CONFIG_FIELDS = [
  "serverUrl",
  "token",
  "hostToken",
  "workspace",
  "workspaceId",
  "opencodeBin",
  "pluginDir",
  "model",
  "agent",
  "reasoningEffort",
] as const satisfies readonly (keyof CliConfigFile)[];
const CONFIG_FIELD_SET = new Set<string>(CONFIG_FIELDS);

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export type CliSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

const SIGNAL_EXIT_CODE: Record<CliSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export function createSignalController(options: {
  hasActiveRun: () => boolean;
  abortActiveRun: () => Promise<unknown>;
  beginShutdown: (signal: CliSignal, exitCode: number) => void;
  forceExit: (exitCode: number) => void;
  reportError?: (error: unknown) => void;
}): { handle: (signal: CliSignal) => void; isShuttingDown: () => boolean } {
  let abortRequested = false;
  let shuttingDown = false;
  return {
    handle(signal) {
      const exitCode = SIGNAL_EXIT_CODE[signal];
      if (shuttingDown || abortRequested) {
        options.forceExit(exitCode);
        return;
      }
      if (signal === "SIGINT" && options.hasActiveRun()) {
        if (!abortRequested) {
          abortRequested = true;
          void options.abortActiveRun()
            .then(() => {
              shuttingDown = true;
              options.beginShutdown(signal, exitCode);
            })
            .catch((error) => {
              options.reportError?.(error);
              shuttingDown = true;
              options.beginShutdown(signal, exitCode);
            });
        }
        return;
      }
      shuttingDown = true;
      options.beginShutdown(signal, exitCode);
    },
    isShuttingDown: () => shuttingDown,
  };
}

export function validateHealthPayload(payload: unknown): asserts payload is { ok: true; version: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("JuggleWork Server returned an invalid health response.");
  }
  const health = payload as Record<string, unknown>;
  if (health.ok !== true || typeof health.version !== "string" || !health.version.trim()) {
    throw new Error("JuggleWork Server health check did not report ok=true with a version.");
  }
}

export function isInteractiveCli(options: Pick<CliOptions, "json">, stdinIsTTY: boolean, stdoutIsTTY: boolean): boolean {
  return !options.json && stdinIsTTY && stdoutIsTTY;
}

export function validateCliConfig(value: unknown): CliConfigFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliArgumentError("CLI config root must be an object.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key]) => !CONFIG_FIELD_SET.has(key))) {
    throw new CliArgumentError(`CLI config contains unsupported fields. Allowed fields: ${CONFIG_FIELDS.join(", ")}.`);
  }
  const invalid = entries
    .filter(([, item]) => typeof item !== "string")
    .map(([key]) => key);
  if (invalid.length > 0) {
    throw new CliArgumentError(`CLI config fields must be strings: ${invalid.join(", ")}.`);
  }
  return Object.fromEntries(entries) as CliConfigFile;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JUGGLEWORK_CLI_CONFIG?.trim()) return resolve(env.JUGGLEWORK_CLI_CONFIG.trim());
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), "AppData", "Local"), "JuggleWork", "cli.json");
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jugglework", "cli.json");
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new CliArgumentError(`${flag} requires a value`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CliArgumentError(`${flag} requires a positive integer`);
  return parsed;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let command: CliCommand = "run";
  let sessionId: string | null = null;
  let continueLatest = false;
  let serverUrl: string | null = null;
  let token: string | null = null;
  let hostToken: string | null = null;
  let workspace = process.cwd();
  let workspaceExplicit = false;
  let workspaceId: string | null = null;
  let opencodeBin: string | null = null;
  let pluginDir: string | null = null;
  let model: string | null = null;
  let agent: string | null = null;
  let reasoningEffort: string | null = null;
  let title: string | null = null;
  let fullAccess = false;
  let json = false;
  let color = process.stdout.isTTY === true;
  let configPath = defaultConfigPath(env);
  let timeoutMs = 30 * 60_000;
  let help = false;
  let version = false;
  const positionals: string[] = [];
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (literal) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--version" || arg === "-V") { version = true; continue; }
    if (arg === "--json") { json = true; color = false; continue; }
    if (arg === "--no-color") { color = false; continue; }
    if (arg === "--full-access") { fullAccess = true; continue; }
    if (arg === "--continue" || arg === "-c") { continueLatest = true; continue; }
    if (arg === "--server") { serverUrl = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--token") { token = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--host-token") { hostToken = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--workspace" || arg === "-C") { workspace = valueAfter(argv, index, arg); workspaceExplicit = true; index += 1; continue; }
    if (arg === "--workspace-id") { workspaceId = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--opencode-bin") { opencodeBin = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--plugin-dir") { pluginDir = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--model" || arg === "-m") { model = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--agent" || arg === "-a") { agent = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--reasoning-effort") { reasoningEffort = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--title") { title = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--config") { configPath = resolve(valueAfter(argv, index, arg)); index += 1; continue; }
    if (arg === "--timeout") { timeoutMs = positiveInteger(valueAfter(argv, index, arg), arg) * 1000; index += 1; continue; }
    if (arg.startsWith("-")) throw new CliArgumentError(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  if (positionals[0] === "resume") {
    command = "resume";
    sessionId = positionals[1] ?? null;
    if (positionals.length > 2) throw new CliArgumentError("resume accepts at most one session ID");
  } else if (positionals[0] === "sessions") {
    command = "sessions";
    if (positionals.length > 1) throw new CliArgumentError("sessions does not accept positional arguments");
  } else if (positionals[0] === "status") {
    command = "status";
    if (positionals.length > 1) throw new CliArgumentError("status does not accept positional arguments");
  } else {
    command = continueLatest ? "resume" : "run";
  }

  const prompt = (command === "run" || (command === "resume" && continueLatest)) && positionals.length > 0
    ? positionals.join(" ").trim() || null
    : null;
  return {
    command,
    prompt,
    sessionId,
    continueLatest,
    serverUrl,
    token,
    hostToken,
    workspace: resolve(workspace),
    workspaceExplicit,
    workspaceId,
    opencodeBin,
    pluginDir,
    model,
    agent,
    reasoningEffort,
    title,
    fullAccess,
    json,
    color,
    configPath,
    timeoutMs,
    help,
    version,
  };
}

export function applyConfig(options: CliOptions, config: CliConfigFile, env: NodeJS.ProcessEnv = process.env): CliOptions {
  const clean = (value: string | null | undefined) => value?.trim() || null;
  const pick = (explicit: string | null, envValue: string | undefined, fileValue: string | null | undefined) =>
    clean(explicit) ?? clean(envValue) ?? clean(fileValue);
  return {
    ...options,
    serverUrl: pick(options.serverUrl, env.JUGGLEWORK_SERVER_URL, config.serverUrl),
    token: pick(options.token, env.JUGGLEWORK_TOKEN, config.token),
    hostToken: pick(options.hostToken, env.JUGGLEWORK_HOST_TOKEN, config.hostToken),
    workspace: resolve(options.workspaceExplicit
      ? options.workspace
      : env.JUGGLEWORK_WORKSPACE?.trim() || config.workspace?.trim() || options.workspace),
    workspaceId: pick(options.workspaceId, env.JUGGLEWORK_WORKSPACE_ID, config.workspaceId),
    opencodeBin: pick(options.opencodeBin, env.JUGGLEWORK_OPENCODE_BIN, config.opencodeBin),
    pluginDir: pick(options.pluginDir, env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR, config.pluginDir),
    model: pick(options.model, env.JUGGLEWORK_MODEL, config.model),
    agent: pick(options.agent, env.JUGGLEWORK_AGENT, config.agent),
    reasoningEffort: pick(options.reasoningEffort, env.JUGGLEWORK_REASONING_EFFORT, config.reasoningEffort),
  };
}

export const HELP = `jugglework

Usage:
  jugglework [options] [prompt]
  jugglework resume [session-id] [options]
  jugglework sessions [options]
  jugglework status [options]

Options:
  -C, --workspace <path>       Workspace directory (default: current directory)
      --workspace-id <id>      Workspace ID when connecting to an existing Server
      --server <url>           Connect to an existing JuggleWork Server
      --token <token>          Server bearer token
      --host-token <token>     Host token, required for connected Full access
      --opencode-bin <path>    OpenCode executable for local mode
      --plugin-dir <path>      JuggleWork OpenCode plugin directory
  -m, --model <provider/model> Model for submitted prompts
  -a, --agent <name>           Agent for submitted prompts
      --reasoning-effort <n>   Model reasoning effort
      --full-access            Explicitly enable Full access for new sessions
  -c, --continue               Resume the latest session
      --title <text>           Title for a new session
      --timeout <seconds>      Per-run timeout (default: 1800)
      --config <path>          CLI config file
      --json                   Emit NDJSON records
      --no-color               Disable ANSI colors
  -h, --help                   Show help
  -V, --version                Show version

Interactive commands:
  /help  /new  /sessions  /resume <id>  /status  /stop  /exit
`;
