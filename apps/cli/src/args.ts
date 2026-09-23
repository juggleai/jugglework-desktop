import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type CliCommand =
  | { group: "runtime"; action: "run" | "exec" | "resume" | "sessions" | "status" }
  | { group: "workspace"; action: "list" | "add" | "open"; target: string | null }
  | { group: "session"; action: "list" }
  | { group: "session"; action: "show" | "resume" | "fork" | "archive" | "unarchive" | "delete"; target: string | null }
  | { group: "session"; action: "queue" | "rename"; target: string | null; value: string | null }
  | { group: "account"; action: "login" | "login-status" | "logout" }
  | { group: "org"; action: "list" | "use"; target: string | null }
  | { group: "catalog"; action: "list" }
  | { group: "provider"; action: "list" | "import" | "remove"; target: string | null }
  | { group: "model"; action: "list" }
  | { group: "diagnostics"; action: "doctor" }
  | { group: "meta"; action: "completion"; shell: "bash" | "zsh" | "fish" | "powershell" };

export type CliOptions = {
  command: CliCommand;
  prompt: string | null;
  sessionId: string | null;
  continueLatest: boolean;
  serverUrl: string | null;
  token: string | null;
  hostToken: string | null;
  cloudUrl: string | null;
  cloudToken: string | null;
  cloudOrg: string | null;
  grantStdin: boolean;
  workspace: string;
  workspaceExplicit: boolean;
  workspaceId: string | null;
  opencodeBin: string | null;
  pluginDir: string | null;
  model: string | null;
  agent: string | null;
  reasoningEffort: string | null;
  title: string | null;
  outputLastMessage: string | null;
  outputSchema: string | null;
  sandbox: "workspace-write" | "danger-full-access";
  approval: "on-request" | "never";
  sandboxExplicit: boolean;
  approvalExplicit: boolean;
  fullAccess: boolean;
  force: boolean;
  json: boolean;
  color: boolean;
  configPath: string;
  timeoutMs: number;
  help: boolean;
  helpTopic: string[];
  version: boolean;
};

export type CliConfigFile = Partial<Pick<CliOptions,
  "serverUrl" | "token" | "hostToken" | "workspace" | "workspaceId" |
  "opencodeBin" | "pluginDir" | "model" | "agent" | "reasoningEffort" |
  "cloudUrl" | "cloudOrg" | "sandbox" | "approval"
>>;

const CONFIG_FIELDS = [
  "serverUrl",
  "token",
  "hostToken",
  "cloudUrl",
  "cloudOrg",
  "workspace",
  "workspaceId",
  "opencodeBin",
  "pluginDir",
  "model",
  "agent",
  "reasoningEffort",
  "sandbox",
  "approval",
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

function choice<T extends string>(value: string, flag: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new CliArgumentError(`${flag} requires one of: ${allowed.join(", ")}`);
  return value as T;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let command: CliCommand = { group: "runtime", action: "run" };
  let sessionId: string | null = null;
  let continueLatest = false;
  let serverUrl: string | null = null;
  let token: string | null = null;
  let hostToken: string | null = null;
  let cloudUrl: string | null = null;
  let grantStdin = false;
  let workspace = process.cwd();
  let workspaceExplicit = false;
  let workspaceId: string | null = null;
  let opencodeBin: string | null = null;
  let pluginDir: string | null = null;
  let model: string | null = null;
  let agent: string | null = null;
  let reasoningEffort: string | null = null;
  let title: string | null = null;
  let outputLastMessage: string | null = null;
  let outputSchema: string | null = null;
  let sandbox: CliOptions["sandbox"] = "workspace-write";
  let approval: CliOptions["approval"] = "on-request";
  let sandboxExplicit = false;
  let approvalExplicit = false;
  let fullAccess = false;
  let force = false;
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
    if (arg === "--full-access" || arg === "--dangerously-enable-full-access" || arg === "--dangerously-bypass-approvals-and-sandbox") {
      sandbox = "danger-full-access";
      approval = "never";
      sandboxExplicit = true;
      approvalExplicit = true;
      fullAccess = true;
      continue;
    }
    if (arg === "--sandbox") {
      sandbox = choice(valueAfter(argv, index, arg), arg, ["workspace-write", "danger-full-access"] as const);
      sandboxExplicit = true;
      index += 1;
      continue;
    }
    if (arg === "--approval") {
      approval = choice(valueAfter(argv, index, arg), arg, ["on-request", "never"] as const);
      approvalExplicit = true;
      index += 1;
      continue;
    }
    if (arg === "--force") { force = true; continue; }
    if (arg === "--grant-stdin") { grantStdin = true; continue; }
    if (arg === "--continue" || arg === "-c") { continueLatest = true; continue; }
    if (arg === "--server") { serverUrl = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--token") { token = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--host-token") { hostToken = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--cloud-url") { cloudUrl = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--workspace" || arg === "-C") { workspace = valueAfter(argv, index, arg); workspaceExplicit = true; index += 1; continue; }
    if (arg === "--workspace-id") { workspaceId = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--opencode-bin") { opencodeBin = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--plugin-dir") { pluginDir = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--model" || arg === "-m") { model = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--agent" || arg === "-a") { agent = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--reasoning-effort") { reasoningEffort = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--title") { title = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--output-last-message") { outputLastMessage = resolve(valueAfter(argv, index, arg)); index += 1; continue; }
    if (arg === "--output-schema") { outputSchema = resolve(valueAfter(argv, index, arg)); index += 1; continue; }
    if (arg === "--config") { configPath = resolve(valueAfter(argv, index, arg)); index += 1; continue; }
    if (arg === "--timeout") { timeoutMs = positiveInteger(valueAfter(argv, index, arg), arg) * 1000; index += 1; continue; }
    if (arg.startsWith("-")) throw new CliArgumentError(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  const helpTopic = help ? positionals.slice(0, 2) : [];
  if (help) {
    command = { group: "runtime", action: "run" };
  } else if (positionals[0] === "exec") {
    command = { group: "runtime", action: "exec" };
  } else if (positionals[0] === "resume") {
    command = { group: "runtime", action: "resume" };
    sessionId = positionals[1] ?? null;
    if (positionals.length > 2) throw new CliArgumentError("resume accepts at most one session ID");
  } else if (positionals[0] === "sessions") {
    command = { group: "runtime", action: "sessions" };
    if (positionals.length > 1) throw new CliArgumentError("sessions does not accept positional arguments");
  } else if (positionals[0] === "fork") {
    if (positionals.length > 2) throw new CliArgumentError("fork accepts at most one session ID");
    command = { group: "session", action: "fork", target: positionals[1] ?? null };
  } else if (positionals[0] === "session") {
    const action = positionals[1];
    if (action === "list" && positionals.length === 2) command = { group: "session", action };
    else if ((action === "resume" || action === "fork") && positionals.length <= 3) {
      command = { group: "session", action, target: positionals[2] ?? null };
    } else if (["show", "archive", "unarchive", "delete"].includes(action ?? "") && positionals.length === 3) {
      command = { group: "session", action: action as "show" | "resume" | "fork" | "archive" | "unarchive" | "delete", target: positionals[2] ?? null };
    } else if ((action === "queue" || action === "rename") && positionals.length >= 4) {
      command = { group: "session", action, target: positionals[2] ?? null, value: positionals.slice(3).join(" ").trim() || null };
    } else throw new CliArgumentError("session requires list, show <id>, resume [id], fork [id], queue <id> <prompt>, rename <id> <title>, archive <id>, unarchive <id>, or delete <id>");
  } else if (positionals[0] === "status") {
    command = { group: "runtime", action: "status" };
    if (positionals.length > 1) throw new CliArgumentError("status does not accept positional arguments");
  } else if (positionals[0] === "login") {
    if (positionals.length === 1) command = { group: "account", action: "login" };
    else if (positionals.length === 2 && positionals[1] === "status") command = { group: "account", action: "login-status" };
    else throw new CliArgumentError("login accepts only the optional 'status' subcommand");
  } else if (positionals[0] === "logout") {
    if (positionals.length > 1) throw new CliArgumentError("logout does not accept positional arguments");
    command = { group: "account", action: "logout" };
  } else if (positionals[0] === "org") {
    if (positionals[1] === "list" && positionals.length === 2) command = { group: "org", action: "list", target: null };
    else if (positionals[1] === "use" && positionals.length <= 3) command = { group: "org", action: "use", target: positionals[2] ?? null };
    else throw new CliArgumentError("org requires 'list' or 'use [id-or-slug]'");
  } else if (positionals[0] === "workspace") {
    const action = positionals[1];
    if (action === "list" && positionals.length === 2) command = { group: "workspace", action, target: null };
    else if ((action === "add" || action === "open") && positionals.length === 3) command = { group: "workspace", action, target: positionals[2] ?? null };
    else throw new CliArgumentError("workspace requires 'list', 'add <path>', or 'open <id>'");
  } else if (positionals[0] === "provider") {
    const action = positionals[1];
    if (action === "list" && positionals.length === 2) command = { group: "provider", action: "list", target: null };
    else if ((action === "import" || action === "remove") && positionals.length === 3) {
      command = { group: "provider", action, target: positionals[2] ?? null };
    } else throw new CliArgumentError("provider requires 'list', 'import <publication-id>', or 'remove <publication-id>'");
  } else if (positionals[0] === "catalog" || positionals[0] === "model") {
    const group = positionals[0];
    if (positionals[1] !== "list" || positionals.length !== 2) throw new CliArgumentError(`${group} requires the 'list' subcommand`);
    command = { group, action: "list" };
  } else if (positionals[0] === "doctor") {
    if (positionals.length !== 1) throw new CliArgumentError("doctor does not accept positional arguments");
    command = { group: "diagnostics", action: "doctor" };
  } else if (positionals[0] === "completion") {
    const shell = positionals[1];
    if (positionals.length !== 2 || !["bash", "zsh", "fish", "powershell"].includes(shell ?? "")) {
      throw new CliArgumentError("completion requires one of: bash, zsh, fish, powershell");
    }
    command = { group: "meta", action: "completion", shell: shell as "bash" | "zsh" | "fish" | "powershell" };
  } else {
    command = { group: "runtime", action: continueLatest ? "resume" : "run" };
  }

  if ((outputLastMessage || outputSchema) && !(command.group === "runtime" && command.action === "exec")) {
    throw new CliArgumentError("--output-last-message and --output-schema are supported only with 'jugglework exec'");
  }
  fullAccess = sandbox === "danger-full-access" && approval === "never";
  if (sandbox === "danger-full-access" && approval !== "never") {
    throw new CliArgumentError("--sandbox danger-full-access requires --approval never; the Server exposes this combination only as versioned Full access.");
  }
  if (force && !(command.group === "session" && command.action === "delete")) {
    throw new CliArgumentError("--force is supported only with 'jugglework session delete <exact-session-id>'");
  }

  const promptPositionals = command.group === "runtime" && command.action === "exec" ? positionals.slice(1) : positionals;
  const prompt = command.group === "runtime" && (command.action === "run" || command.action === "exec" || (command.action === "resume" && continueLatest)) && promptPositionals.length > 0
    ? promptPositionals.join(" ").trim() || null
    : null;
  return {
    command,
    prompt,
    sessionId,
    continueLatest,
    serverUrl,
    token,
    hostToken,
    cloudUrl,
    cloudToken: null,
    cloudOrg: null,
    grantStdin,
    workspace: resolve(workspace),
    workspaceExplicit,
    workspaceId,
    opencodeBin,
    pluginDir,
    model,
    agent,
    reasoningEffort,
    title,
    outputLastMessage,
    outputSchema,
    sandbox,
    approval,
    sandboxExplicit,
    approvalExplicit,
    fullAccess,
    force,
    json,
    color,
    configPath,
    timeoutMs,
    help,
    helpTopic,
    version,
  };
}

export function applyConfig(options: CliOptions, config: CliConfigFile, env: NodeJS.ProcessEnv = process.env): CliOptions {
  const clean = (value: string | null | undefined) => value?.trim() || null;
  const pick = (explicit: string | null, envValue: string | undefined, fileValue: string | null | undefined) =>
    clean(explicit) ?? clean(envValue) ?? clean(fileValue);
  const sandbox = pick(options.sandboxExplicit ? options.sandbox : null, env.JUGGLEWORK_SANDBOX, config.sandbox) ?? options.sandbox;
  const approval = pick(options.approvalExplicit ? options.approval : null, env.JUGGLEWORK_APPROVAL, config.approval) ?? options.approval;
  if (sandbox !== "workspace-write" && sandbox !== "danger-full-access") {
    throw new CliArgumentError("sandbox must be one of: workspace-write, danger-full-access");
  }
  if (approval !== "on-request" && approval !== "never") {
    throw new CliArgumentError("approval must be one of: on-request, never");
  }
  if (sandbox === "danger-full-access" && approval !== "never") {
    throw new CliArgumentError("sandbox danger-full-access requires approval never; the Server exposes this combination only as versioned Full access.");
  }
  return {
    ...options,
    serverUrl: pick(options.serverUrl, env.JUGGLEWORK_SERVER_URL, config.serverUrl),
    token: pick(options.token, env.JUGGLEWORK_TOKEN, config.token),
    hostToken: pick(options.hostToken, env.JUGGLEWORK_HOST_TOKEN, config.hostToken),
    cloudUrl: pick(options.cloudUrl, env.JUGGLEWORK_CLOUD_URL, config.cloudUrl) ?? "https://work.jugglechat.cn",
    cloudToken: clean(env.JUGGLEWORK_CLOUD_TOKEN),
    cloudOrg: pick(options.cloudOrg, env.JUGGLEWORK_CLOUD_ORG, config.cloudOrg),
    workspace: resolve(options.workspaceExplicit
      ? options.workspace
      : env.JUGGLEWORK_WORKSPACE?.trim() || config.workspace?.trim() || options.workspace),
    workspaceId: pick(options.workspaceId, env.JUGGLEWORK_WORKSPACE_ID, config.workspaceId),
    opencodeBin: pick(options.opencodeBin, env.JUGGLEWORK_OPENCODE_BIN, config.opencodeBin),
    pluginDir: pick(options.pluginDir, env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR, config.pluginDir),
    model: pick(options.model, env.JUGGLEWORK_MODEL, config.model),
    agent: pick(options.agent, env.JUGGLEWORK_AGENT, config.agent),
    reasoningEffort: pick(options.reasoningEffort, env.JUGGLEWORK_REASONING_EFFORT, config.reasoningEffort),
    sandbox,
    approval,
    fullAccess: sandbox === "danger-full-access" && approval === "never",
  };
}

export { HELP } from "./help.js";
