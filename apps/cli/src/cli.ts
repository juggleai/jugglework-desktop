#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  applyConfig,
  CliArgumentError,
  createSignalController,
  HELP,
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

const VERSION = "1.2.21";
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

function printInteractiveHelp(): void {
  stdout.write(`Commands:\n  /help                Show this help\n  /new [title]         Start a new session\n  /sessions            List recent sessions\n  /resume <id>         Resume a session\n  /status              Show runtime and task status\n  /stop                Stop the active task\n  /exit                 Exit JuggleWork\n`);
}

async function repl(controller: SessionController, renderer: CliRenderer, rl: Interface): Promise<void> {
  renderer.info("Type a task, or /help for commands.");
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
        case "help": printInteractiveHelp(); break;
        case "new": await controller.createSession(rest.join(" ").trim() || "JuggleWork CLI"); break;
        case "sessions": renderer.sessions(await controller.listSessions()); break;
        case "resume": await controller.selectSession(rest[0] ?? null, false); break;
        case "status": await controller.status(); break;
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
    const interactive = isInteractiveCli(options, stdin.isTTY === true, stdout.isTTY === true);
    if (interactive) rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const ask: Ask | null = rl ? (question) => rl!.question(question) : null;

    runtime = await createRuntime(options);
    const api = new JuggleWorkApiClient(runtime.url, runtime.token, runtime.hostToken);
    validateHealthPayload(await api.health());
    const workspace = await chooseWorkspace(api, options, ask);
    renderer.banner(workspace, runtime.url, runtime.owned);
    controller = new SessionController(api, workspace, options, renderer, ask);
    const activeController = controller;

    rl?.on("SIGINT", signalHandlers.SIGINT);
    const command = async (): Promise<number> => {
      if (options.command === "sessions") {
        renderer.sessions(await activeController.listSessions());
        return 0;
      }
      if (options.command === "status") {
        await activeController.status();
        return 0;
      }
      if (options.command === "resume") await activeController.selectSession(options.sessionId, options.continueLatest);

      let prompt = options.prompt;
      if (!prompt && !interactive && options.command === "run") prompt = await readStdinPrompt();
      if (prompt) {
        const result = await activeController.runPrompt(prompt);
        return result.aborted ? 130 : 0;
      }
      if (!interactive) {
        throw new Error("No prompt was provided. Pass a prompt argument, pipe text on stdin, or run in an interactive terminal.");
      }
      await repl(activeController, renderer, rl!);
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
    else process.stderr.write(`${message}\n\n${HELP}`);
    return error instanceof CliArgumentError ? 2 : 1;
  }
  const renderer = new CliRenderer({ json: base.json, color: base.color });
  if (base.help) {
    if (base.json) renderer.event("help", { text: HELP });
    else stdout.write(HELP);
    return 0;
  }
  if (base.version) {
    if (base.json) renderer.event("version", { version: VERSION });
    else stdout.write(`${VERSION}\n`);
    return 0;
  }
  try {
    const config = await readConfig(base.configPath);
    const options = applyConfig(base, config);
    renderer.registerSecretValues([options.token, options.hostToken]);
    return await execute(options, renderer);
  } catch (error) {
    if (error instanceof JuggleWorkApiError && error.code) {
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
