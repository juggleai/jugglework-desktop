#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const extension = process.platform === "win32" ? ".exe" : "";
const target = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64",
  "win32-arm64": "bun-windows-arm64",
  "win32-x64": "bun-windows-x64",
}[`${process.platform}-${process.arch}`];
const compiled = [
  ...(target ? [fileURLToPath(new URL(`../dist/bin/jugglework-${target}${extension}`, import.meta.url))] : []),
  fileURLToPath(new URL(`../dist/bin/jugglework${extension}`, import.meta.url)),
].find(existsSync);
const source = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

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

if (compiled) run(compiled, args);
if (existsSync(source)) run("bun", [source, ...args]);

console.error("Unable to find the JuggleWork CLI entrypoint. Reinstall the CLI or build it from source.");
process.exit(1);
