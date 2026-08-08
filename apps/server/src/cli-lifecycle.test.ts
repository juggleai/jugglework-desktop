import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

async function waitForLine(path: string, expected: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.split("\n").includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

async function waitForOutput(
  stream: NodeJS.ReadableStream | null,
  expected: string,
  timeoutMs = 5000,
): Promise<void> {
  if (!stream) throw new Error("Expected child process output");
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}\n${output}`)), timeoutMs);
    stream.on("data", (chunk) => {
      output += chunk.toString();
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("standalone server lifecycle", () => {
  test.serial("SIGTERM waits for managed OpenCode cleanup before exiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-cli-lifecycle-"));
    const workspace = join(root, "workspace");
    const logPath = join(root, "managed.log");
    const binPath = join(root, "fake-opencode.mjs");
    await mkdir(workspace, { recursive: true });
    await writeFile(binPath, [
      "#!/usr/bin/env bun",
      "import { appendFileSync } from 'node:fs';",
      "const portIndex = process.argv.indexOf('--port');",
      "const port = Number(process.argv[portIndex + 1]);",
      "const logPath = process.env.JUGGLEWORK_CLI_TEST_LOG;",
      "const append = (line) => appendFileSync(logPath, `${line}\\n`);",
      "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({}) });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "append('READY');",
      "process.on('SIGTERM', () => {",
      "  setTimeout(() => { append('CLEANED'); server.stop(true); process.exit(0); }, 250);",
      "});",
    ].join("\n"));
    await chmod(binPath, 0o755);

    const child = spawn(process.execPath, [
      join(import.meta.dir, "cli.ts"),
      "--host", "127.0.0.1",
      "--port", "0",
      "--token", "server-token",
      "--host-token", "host-token",
      "--workspace", workspace,
      "--no-log-requests",
    ], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        HOME: join(root, "home"),
        JUGGLEWORK_MANAGE_OPENCODE: "1",
        JUGGLEWORK_OPENCODE_BIN: binPath,
        JUGGLEWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
        JUGGLEWORK_CLI_TEST_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForLine(logPath, "READY");
      await waitForOutput(child.stdout, "JuggleWork server listening");
      child.kill("SIGTERM");
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const result = await exit;

      expect(result).toEqual({ code: 0, signal: null });
      expect((await readFile(logPath, "utf8")).split("\n")).toContain("CLEANED");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test.serial("managed OpenCode readiness failure rolls back the bound HTTP server before the CLI exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-cli-startup-failure-"));
    const workspace = join(root, "workspace");
    const logPath = join(root, "managed.log");
    const binPath = join(root, "fake-opencode.mjs");
    await mkdir(workspace, { recursive: true });
    await writeFile(binPath, [
      "#!/usr/bin/env bun",
      "import { appendFileSync } from 'node:fs';",
      "const logPath = process.env.JUGGLEWORK_CLI_TEST_LOG;",
      "console.log('opencode server listening without a URL');",
      "process.on('SIGTERM', () => { appendFileSync(logPath, 'CLEANED\\n'); process.exit(0); });",
      "setInterval(() => undefined, 1000);",
    ].join("\n"));
    await chmod(binPath, 0o755);

    const child = spawn(process.execPath, [
      join(import.meta.dir, "cli.ts"),
      "--host", "127.0.0.1",
      "--port", "0",
      "--token", "server-token",
      "--host-token", "host-token",
      "--workspace", workspace,
      "--no-log-requests",
    ], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        HOME: join(root, "home"),
        JUGGLEWORK_MANAGE_OPENCODE: "1",
        JUGGLEWORK_OPENCODE_BIN: binPath,
        JUGGLEWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
        JUGGLEWORK_CLI_TEST_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect((await readFile(logPath, "utf8")).split("\n")).toContain("CLEANED");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
