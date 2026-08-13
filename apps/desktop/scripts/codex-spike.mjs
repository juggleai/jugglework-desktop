#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCodexAppServerClient } from "../electron/codex-app-server-client.mjs";
import { serializeCodexProviderConfig } from "../electron/codex-provider-config.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const workspaceDir = resolve(desktopDir, "../..");
const manifestPath = join(desktopDir, "resources", "sidecars", "codex-versions.json");

function parseArgs(argv) {
  const result = {
    command: process.env.JUGGLEWORK_CODEX_BIN?.trim() || "codex",
    iterations: 20,
    cwd: workspaceDir,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") result.json = true;
    else if (value === "--codex-bin") result.command = String(argv[++index] ?? "").trim();
    else if (value === "--iterations") result.iterations = Number(argv[++index]);
    else if (value === "--cwd") result.cwd = resolve(String(argv[++index] ?? ""));
    else if (value === "--help" || value === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!result.command) throw new Error("--codex-bin requires a value.");
  if (!Number.isInteger(result.iterations) || result.iterations < 1 || result.iterations > 100) {
    throw new Error("--iterations must be an integer between 1 and 100.");
  }
  return result;
}

function usage() {
  return `Usage: pnpm --filter @jugglework/desktop spike:codex -- [options]

Protocol-only Codex App Server spike. It never reads the user's global
CODEX_HOME and does not make model requests.

Options:
  --codex-bin <path>   Codex executable (default: JUGGLEWORK_CODEX_BIN or codex)
  --iterations <n>     initialize + thread/start cycles (default: 20, max: 100)
  --cwd <path>         local workspace used for ephemeral threads
  --json               print a machine-readable report
  -h, --help           show this help
`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim().slice(-2_000);
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${stderr}`);
  }
  return String(result.stdout ?? "").trim();
}

function normalizedVersion(output) {
  const match = String(output).match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/);
  if (!match) throw new Error(`Unable to parse Codex version: ${output}`);
  return match[1];
}

export async function runCodexSpike(input = {}) {
  const options = { ...parseArgs([]), ...input };
  const provider = options.provider ?? {
    providerId: "jugglework",
    providerName: "JuggleWork Spike Gateway",
    baseUrl: "http://127.0.0.1:9/v1",
    tokenEnv: "JUGGLEWORK_CODEX_GATEWAY_TOKEN",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  };
  const providerConfig = serializeCodexProviderConfig(provider);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const root = await mkdtemp(join(tmpdir(), "jugglework-codex-spike-"));
  const schemaDir = join(root, "schema");
  const startedAt = Date.now();
  const iterations = [];

  try {
    const versionOutput = run(options.command, ["--version"]);
    const version = normalizedVersion(versionOutput);
    if (version !== manifest.codexVersion) {
      throw new Error(`Codex version mismatch: expected ${manifest.codexVersion}, received ${version}.`);
    }

    run(options.command, ["app-server", "generate-json-schema", "--out", schemaDir, "--experimental"], {
      env: { ...process.env, CODEX_HOME: join(root, "schema-home") },
    });
    const schema = await readFile(join(schemaDir, manifest.appServerProtocol.schemaFile));
    const schemaSha256 = sha256(schema);
    if (schemaSha256 !== manifest.appServerProtocol.sha256) {
      throw new Error(`App Server schema mismatch: expected ${manifest.appServerProtocol.sha256}, received ${schemaSha256}.`);
    }

    for (let index = 0; index < options.iterations; index += 1) {
      const codexHome = join(root, `home-${String(index + 1).padStart(3, "0")}`);
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), providerConfig, { mode: 0o600 });
      const client = createCodexAppServerClient({
        command: options.command,
        cwd: options.cwd,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          [provider.tokenEnv]: "codex-spike-placeholder",
        },
        requestTimeoutMs: 15_000,
      });
      const iterationStartedAt = Date.now();
      try {
        const initialized = await client.initialize({
          clientInfo: { name: "jugglework-codex-spike", title: "JuggleWork Codex Spike", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        if (await realpath(String(initialized?.codexHome ?? "")) !== await realpath(codexHome)) {
          throw new Error("Codex App Server did not use the isolated CODEX_HOME.");
        }
        const thread = await client.request("thread/start", {
          cwd: options.cwd,
          model: provider.model,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
        });
        if (!thread?.thread?.id) throw new Error("thread/start did not return a thread id.");
        if (thread.thread.modelProvider !== provider.providerId) {
          throw new Error(`thread/start did not select provider ${provider.providerId}.`);
        }
        iterations.push({
          number: index + 1,
          durationMs: Date.now() - iterationStartedAt,
          threadIdPresent: true,
          isolatedCodexHome: true,
          modelProvider: thread.thread.modelProvider,
          appServerVersion: thread.thread.cliVersion ?? version,
        });
      } finally {
        await client.close();
      }
    }

    return {
      ok: true,
      scope: "protocol-only",
      codexVersion: version,
      schemaSha256,
      providerConfigValidated: true,
      modelProvider: provider.providerId,
      iterations,
      completed: iterations.length,
      durationMs: Date.now() - startedAt,
      cwd: options.cwd,
      limitations: [
        "The custom Responses provider was parsed and selected, but no network model request was sent.",
        "Real JuggleWork gateway, token refresh, tools, images, and Windows x64 require external validation.",
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      const report = await runCodexSpike(options);
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        process.stdout.write(`Codex protocol spike passed: ${report.completed}/${options.iterations} cycles\n`);
        process.stdout.write(`Version ${report.codexVersion}; schema ${report.schemaSha256}; ${report.durationMs} ms\n`);
        process.stdout.write(`Limitations: ${report.limitations.join(" ")}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`Codex protocol spike failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
