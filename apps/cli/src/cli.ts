#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import {
  applyConfig,
  CliArgumentError,
  createSignalController,
  isInteractiveCli,
  parseCliArgs,
  validateCliConfig,
  validateHealthPayload,
  type CliConfigFile,
  type CliOptions,
} from "./args.js";
import { JuggleWorkApiClient, JuggleWorkApiError } from "./api.js";
import { chooseWorkspace, SessionController, type Ask } from "./controller.js";
import { CliRenderer } from "./render.js";
import { createRuntime, type RuntimeConnection } from "./runtime.js";
import { executeCloudCommand, isCloudOnlyCommand } from "./cloud-command.js";
import { CloudHttpError } from "./cloud-client.js";
import { CLI_VERSION } from "./version.js";
import { commandHelp, completionScript } from "./help.js";
import { executeDoctor } from "./doctor.js";
import { executeProviderCommand } from "./provider-command.js";
import { cloudWelcomeLabel, hasCloudLogin } from "./welcome.js";
import { chooseCloudOnboarding, isOnboardingEntry } from "./onboarding.js";

const CLEANUP_TIMEOUT_MS = 5_000;
const ABORT_TIMEOUT_MS = 1_500;

async function settleWithin(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(false), timeoutMs);
  });
  try {
    return await Promise.race([task.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readConfig(path: string): Promise<CliConfigFile> {
  try {
    const text = await readFile(path, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new CliArgumentError("CLI config contains invalid JSON.");
    }
    return validateCliConfig(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    const message = error instanceof CliArgumentError
      ? error.message
      : "CLI config could not be read.";
    throw new CliArgumentError(`Unable to read CLI config ${path}: ${message}`);
  }
}

async function readStdinPrompt(): Promise<string | null> {
  if (stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim() || null;
}

async function readOutputSchema(path: string | null): Promise<Record<string, unknown> | null> {
  if (!path) return null;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new CliArgumentError(`Output schema ${path} contains invalid JSON.`);
    throw new CliArgumentError(`Unable to read output schema ${path}.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliArgumentError(`Output schema ${path} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

const SLASH_COMMANDS = [
  ["model", "Show the configured model and selection guidance"],
  ["org", "List Cloud organizations (read-only)"],
  ["permissions", "Show or change Server-authoritative approval mode"],
  ["status", "Show runtime and task status"],
  ["plan", "Show the current runtime task plan"],
  ["new", "Start a new session"],
  ["sessions", "List recent sessions"],
  ["resume", "Resume a session"],
  ["fork", "Fork the selected or specified session"],
  ["workspace", "List Server workspaces and workspace command guidance"],
  ["connect", "Show Connect status guidance"],
  ["mcp", "Show MCP configuration guidance"],
  ["skills", "Show skills guidance"],
  ["extensions", "Show extensions guidance"],
  ["compact", "Compact the selected session using --model"],
  ["copy", "Print the last response as copy-ready text"],
  ["doctor", "Show the diagnostic command to run"],
  ["logout", "Sign out from JuggleWork Cloud"],
  ["exit", "Exit JuggleWork"],
] as const;

export function searchSlashCommands(query = ""): Array<{ name: string; summary: string }> {
  const needle = query.trim().toLowerCase();
  return SLASH_COMMANDS
    .filter(([name, summary]) => !needle || name.includes(needle) || summary.toLowerCase().includes(needle))
    .map(([name, summary]) => ({ name, summary }));
}

function printInteractiveHelp(query = ""): void {
  const needle = query.trim().toLowerCase();
  const matches = searchSlashCommands(query);
  stdout.write(`Commands${needle ? ` matching '${needle}'` : ""}:\n${matches.map(({ name, summary }) => `  /${name.padEnd(13)} ${summary}`).join("\n")}\n  /help [search] Search this compact command palette\n  /stop          Stop the active task\n`);
}

async function repl(controller: SessionController, renderer: CliRenderer, rl: Interface, options: CliOptions): Promise<void> {
  renderer.info("Type a task or /help for commands.");
  while (true) {
    let input: string;
    try {
      input = (await rl.question(renderer.promptLabel())).trim();
    } catch {
      break;
    }
    if (!input) continue;
    if (!input.startsWith("/")) {
      try { await controller.runPrompt(input); } catch (error) { renderer.error(error instanceof Error ? error.message : String(error)); }
      continue;
    }
    const [command, ...rest] = input.slice(1).split(/\s+/);
    try {
      switch (command?.toLowerCase()) {
        case "help": printInteractiveHelp(rest.join(" ")); break;
        case "model":
          renderer.info(`Model: ${options.model ?? "runtime default"}. Use --model provider/model when starting the CLI to change it.`);
          break;
        case "org":
          await executeCloudCommand({ ...options, command: { group: "org", action: "list", target: null } }, renderer);
          break;
        case "permissions": {
          const requested = rest[0]?.toLowerCase();
          if (requested && requested !== "request-approval" && requested !== "full-access") {
            throw new Error("Usage: /permissions [request-approval|full-access]");
          }
          await controller.permissions(requested as "request-approval" | "full-access" | undefined);
          break;
        }
        case "new": await controller.createSession(rest.join(" ").trim() || "JuggleWork CLI"); break;
        case "sessions": renderer.sessions(await controller.listSessions()); break;
        case "resume": await controller.selectSession(rest[0] ?? null, false); break;
        case "status": await controller.status(); break;
        case "plan": await controller.plan(); break;
        case "workspace": {
          const { items } = await controller.api.listWorkspaces();
          items.forEach((item) => renderer.info(`${item.id}${item.id === controller.workspace.id ? " *" : ""}  ${item.displayName || item.name || item.path || "Workspace"}`));
          renderer.info("Read-only in this REPL. Use 'jugglework workspace add <path>' or 'jugglework workspace open <id>' before entering a session.");
          break;
        }
        case "fork": await controller.forkSession(rest[0] ?? controller.currentSession?.id ?? null); break;
        case "connect":
          renderer.info("Read-only guidance: use /status for runtime state and 'jugglework doctor' for Cloud/Connect diagnostics. Connect mutation is not exposed by the CLI Server API.");
          break;
        case "mcp":
          renderer.info("Read-only guidance: MCP configuration is managed by the runtime workspace config; this CLI does not expose safe MCP mutation commands yet.");
          break;
        case "skills":
          renderer.info("Read-only guidance: skills are loaded from the workspace/runtime. This CLI does not expose a truthful skills inventory route yet.");
          break;
        case "extensions":
          renderer.info("Read-only guidance: extensions are runtime-managed. This CLI does not expose enable/disable APIs.");
          break;
        case "compact": await controller.compact(); break;
        case "copy":
          if (!controller.lastResponse) throw new Error("No assistant response is available to copy.");
          renderer.info("Copy-ready response (clipboard access is not available to this CLI):");
          stdout.write(`${controller.lastResponse}\n`);
          break;
        case "doctor":
          renderer.info("Read-only guidance: run 'jugglework doctor' outside this REPL for a fresh redacted diagnostic report.");
          break;
        case "logout":
          await executeCloudCommand({ ...options, command: { group: "account", action: "logout" } }, renderer);
          break;
        case "stop":
          if (!await controller.abortCurrentRun()) renderer.info("No active task to stop.");
          break;
        case "exit":
        case "quit": return;
        default: renderer.warn(`Unknown command /${command || ""}. Type /help.`);
      }
    } catch (error) {
      renderer.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function execute(options: CliOptions, renderer: CliRenderer): Promise<number> {
  let runtime: RuntimeConnection | null = null;
  let rl: Interface | null = null;
  let controller: SessionController | null = null;
  let resolveShutdown!: (exitCode: number) => void;
  const shutdown = new Promise<number>((resolvePromise) => { resolveShutdown = resolvePromise; });
  const signalController = createSignalController({
    hasActiveRun: () => controller?.currentRun != null,
    abortActiveRun: async () => { await controller?.abortCurrentRun(); },
    beginShutdown: (signal, exitCode) => {
      renderer.ensureLine();
      rl?.close();
      void (async () => {
        if (signal !== "SIGINT" && controller?.currentRun) {
          try {
            await settleWithin(controller.abortCurrentRun(), ABORT_TIMEOUT_MS);
          } catch (error) {
            renderer.error(error instanceof Error ? error.message : String(error));
          }
        }
        resolveShutdown(exitCode);
      })();
    },
    forceExit: (exitCode) => process.exit(exitCode),
    reportError: (error) => renderer.error(error instanceof Error ? error.message : String(error)),
  });
  const signalHandlers = {
    SIGINT: () => signalController.handle("SIGINT"),
    SIGTERM: () => signalController.handle("SIGTERM"),
    SIGHUP: () => signalController.handle("SIGHUP"),
  };
  process.on("SIGINT", signalHandlers.SIGINT);
  process.on("SIGTERM", signalHandlers.SIGTERM);
  process.on("SIGHUP", signalHandlers.SIGHUP);

  try {
    const execMode = options.command.group === "runtime" && options.command.action === "exec";
    const interactive = !execMode && isInteractiveCli(options, stdin.isTTY === true, stdout.isTTY === true);
    if (interactive) rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const ask: Ask | null = rl ? (question) => rl!.question(question) : null;

    runtime = await createRuntime(options);
    const api = new JuggleWorkApiClient(runtime.url, runtime.token, runtime.hostToken);
    validateHealthPayload(await api.health());
    if (options.command.group === "workspace") {
      if (options.command.action === "list") {
        const result = await api.listWorkspaces();
        if (options.json) renderer.event("workspaces", result);
        else result.items.forEach((item) => renderer.info(`${item.id}${item.id === result.activeId ? " *" : ""}  ${item.displayName || item.name || item.path || "Workspace"}`));
        return 0;
      }
      if (!options.command.target) throw new Error(`workspace ${options.command.action} requires a target.`);
      const workspaceTarget = options.command.target;
      if (options.command.action === "add") {
        const result = await api.addLocalWorkspace(resolve(workspaceTarget));
        renderer.info(`Workspace added: ${result.activeId}${result.persisted ? "" : " (Server did not persist the registry change)"}.`);
        return 0;
      }
      const available = await api.listWorkspaces();
      const exact = available.items.find((item) => item.id === workspaceTarget);
      const prefixes = available.items.filter((item) => item.id.startsWith(workspaceTarget));
      const selected = exact ?? (prefixes.length === 1 ? prefixes[0] : null);
      if (!selected) throw new Error(prefixes.length > 1 ? `Workspace prefix ${options.command.target} is ambiguous.` : `Workspace ${options.command.target} was not found.`);
      const result = await api.activateWorkspace(selected.id);
      renderer.info(`Workspace opened: ${result.workspace.displayName || result.workspace.name || result.workspace.path || result.workspace.id}.`);
      return 0;
    }
    const workspace = await chooseWorkspace(api, options, ask);
    if (interactive && !options.prompt && options.command.group === "runtime" && options.command.action !== "status" && options.command.action !== "sessions") {
      renderer.welcome({
        workspace,
        model: options.model,
        sandbox: options.sandbox,
        approval: options.approval,
        cloud: await cloudWelcomeLabel(options),
        owned: runtime.owned,
      });
    } else {
      renderer.banner(workspace, runtime.url, runtime.owned);
    }
    controller = new SessionController(api, workspace, options, renderer, ask);
    const activeController = controller;

    rl?.on("SIGINT", signalHandlers.SIGINT);
    const command = async (): Promise<number> => {
      const groupedResume = options.command.group === "session" && options.command.action === "resume";
      if (options.command.group === "session" && !groupedResume) {
        const sessionCommand = options.command;
        if (sessionCommand.action === "list") renderer.sessions(await activeController.listSessions());
        else if (sessionCommand.action === "show") await activeController.showSession(sessionCommand.target!);
        else if (sessionCommand.action === "fork") await activeController.forkSession(sessionCommand.target);
        else if (sessionCommand.action === "queue") await activeController.queueSession(sessionCommand.target!, sessionCommand.value!);
        else if (sessionCommand.action === "rename") await activeController.renameSession(sessionCommand.target!, sessionCommand.value!);
        else if (sessionCommand.action === "archive") await activeController.archiveSession(sessionCommand.target!, true);
        else if (sessionCommand.action === "unarchive") await activeController.archiveSession(sessionCommand.target!, false);
        else if (sessionCommand.action === "delete") await activeController.deleteSession(sessionCommand.target!, options.force);
        return 0;
      }
      if (options.command.group !== "runtime" && !groupedResume) throw new Error("Cloud command reached runtime dispatch.");
      if (options.command.group === "runtime" && options.command.action === "sessions") {
        renderer.sessions(await activeController.listSessions());
        return 0;
      }
      if (options.command.group === "runtime" && options.command.action === "status") {
        await activeController.status();
        return 0;
      }
      if (options.command.group === "session" && options.command.action === "resume") {
        await activeController.selectSession(options.command.target, false);
      } else if (options.command.group === "runtime" && (options.command.action === "resume" || (execMode && options.continueLatest))) {
        await activeController.selectSession(options.sessionId, options.continueLatest);
      }

      let prompt = options.prompt;
      let context: string | null = null;
      let outputSchema: Record<string, unknown> | null = null;
      if (execMode) {
        const input = await readStdinPrompt();
        if (prompt) context = input;
        else prompt = input;
        outputSchema = await readOutputSchema(options.outputSchema);
      } else if (!prompt && !interactive && options.command.group === "runtime" && options.command.action === "run") {
        prompt = await readStdinPrompt();
      }
      if (prompt) {
        const result = await activeController.runPrompt(prompt, { context, outputSchema });
        if (execMode && options.outputLastMessage) await writeFile(options.outputLastMessage, result.text, "utf8");
        return result.aborted ? 130 : 0;
      }
      if (!interactive) {
        throw new Error("No prompt was provided. Pass a prompt argument, pipe text on stdin, or run in an interactive terminal.");
      }
      await repl(activeController, renderer, rl!, options);
      return signalController.isShuttingDown() ? 130 : 0;
    };
    return await Promise.race([command(), shutdown]);
  } finally {
    process.off("SIGINT", signalHandlers.SIGINT);
    process.off("SIGTERM", signalHandlers.SIGTERM);
    process.off("SIGHUP", signalHandlers.SIGHUP);
    rl?.off("SIGINT", signalHandlers.SIGINT);
    rl?.close();
    if (runtime && !await settleWithin(runtime.stop(), CLEANUP_TIMEOUT_MS)) {
      renderer.warn(`Runtime cleanup exceeded ${CLEANUP_TIMEOUT_MS / 1000} seconds; exiting.`);
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let base: CliOptions;
  try {
    base = parseCliArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const literalIndex = argv.indexOf("--");
    const optionArgs = literalIndex < 0 ? argv : argv.slice(0, literalIndex);
    if (optionArgs.includes("--json")) new CliRenderer({ json: true, color: false }).error(message);
    else process.stderr.write(`${message}\n\n${commandHelp()}`);
    return error instanceof CliArgumentError ? 2 : 1;
  }
  const renderer = new CliRenderer({
    json: base.json,
    color: base.color,
    exec: base.command.group === "runtime" && base.command.action === "exec",
  });
  if (base.help) {
    const text = commandHelp(base.helpTopic);
    if (base.json) renderer.event("help", { topic: base.helpTopic, text });
    else stdout.write(text);
    return 0;
  }
  if (base.version) {
    if (base.json) renderer.event("version", { version: CLI_VERSION });
    else stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  try {
    const config = await readConfig(base.configPath);
    const options = applyConfig(base, config);
    renderer.registerSecretValues([options.token, options.hostToken, options.cloudToken]);
    if (options.command.group === "meta") {
      stdout.write(completionScript(options.command.shell));
      return 0;
    }
    if (options.command.group === "diagnostics") return await executeDoctor(options, renderer);
    if (isCloudOnlyCommand(options.command)) return await executeCloudCommand(options, renderer);
    if (options.command.group === "provider") return await executeProviderCommand(options, renderer);
    if (isOnboardingEntry(options, isInteractiveCli(options, stdin.isTTY === true, stdout.isTTY === true)) && !await hasCloudLogin(options)) {
      const choice = await chooseCloudOnboarding(options.color);
      if (choice === "cancel") return 130;
      if (choice !== "continue") {
        await executeCloudCommand({ ...options, command: { group: "account", action: "login" } }, renderer, choice);
      }
    }
    return await execute(options, renderer);
  } catch (error) {
    if (error instanceof CloudHttpError) {
      renderer.error(`${error.message} [${error.code}]`);
    } else if (error instanceof JuggleWorkApiError && error.code) {
      renderer.error(`${error.message} [${error.code}]`);
    } else {
      renderer.error(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
