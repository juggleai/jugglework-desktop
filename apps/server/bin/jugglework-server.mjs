#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveClaudeAgentRollout } from "@jugglework/types/agent-runtime";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);

const binaryName = process.platform === "win32" ? "jugglework-server.exe" : "jugglework-server";
const compiledBinary = fileURLToPath(new URL(`../dist/bin/${binaryName}`, import.meta.url));
const builtCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sourceCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const packagedClaudeRoot = fileURLToPath(new URL("../claude-agent-worker/", import.meta.url));

function provisionPackagedClaudeRuntime() {
  if (!existsSync(packagedClaudeRoot)) return;
  const workerPath = join(packagedClaudeRoot, "dist", "cli.js");
  if (!existsSync(workerPath)) throw new Error(`Missing packaged Claude worker: ${workerPath}`);
  process.env.JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH ??= workerPath;
  if (resolveClaudeAgentRollout(process.env).enabled) {
    if (!process.env.JUGGLEWORK_CLAUDE_AGENT_NODE_PATH?.trim()) {
      throw new Error("Enabled headless Claude Agent requires JUGGLEWORK_CLAUDE_AGENT_NODE_PATH");
    }
    if (!process.env.JUGGLEWORK_CLAUDE_EXECUTABLE_PATH?.trim()) {
      throw new Error("Enabled headless Claude Agent requires JUGGLEWORK_CLAUDE_EXECUTABLE_PATH");
    }
  }
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error(`Missing runtime dependency: ${command}`);
      process.exit(1);
    }
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

provisionPackagedClaudeRuntime();

if (existsSync(compiledBinary)) {
  run(compiledBinary, args);
}

if (existsSync(builtCli)) {
  run("bun", [builtCli, ...args]);
}

if (existsSync(sourceCli)) {
  run("bun", [sourceCli, ...args]);
}

console.error(
  `Unable to find a JuggleWork server entrypoint in ${basename(packageRoot)}. Build the package or run it from a source checkout with Bun available.`,
);
process.exit(1);
