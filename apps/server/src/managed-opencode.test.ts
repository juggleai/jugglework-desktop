import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { createManagedOpencodeServer } from "./managed-opencode.js";

async function writeFakeOpencode(root: string, behavior: "ready" | "unready" | "invalid"): Promise<string> {
  const path = join(root, `fake-opencode-${behavior}.mjs`);
  await writeFile(path, [
    "#!/usr/bin/env bun",
    "import { appendFileSync } from 'node:fs';",
    "const logPath = process.env.JUGGLEWORK_MANAGED_TEST_LOG;",
    "const append = (line) => { if (logPath) appendFileSync(logPath, `${line}\\n`); };",
    "process.on('SIGTERM', () => { append('SIGTERM'); process.exit(0); });",
    behavior === "ready"
      ? "console.log('opencode server listening on http://127.0.0.1:43210');"
      : behavior === "invalid"
        ? "console.log('opencode server listening without a URL');"
        : "append('STARTED');",
    "setInterval(() => undefined, 1000);",
  ].join("\n"));
  await chmod(path, 0o755);
  return path;
}

async function logLines(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean);
}

describe("managed OpenCode lifecycle", () => {
  test("starts, exposes a redacted execution snapshot, and closes idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-managed-opencode-"));
    const logPath = join(root, "managed.log");
    try {
      const bin = await writeFakeOpencode(root, "ready");
      const managed = await createManagedOpencodeServer({
        bin,
        cwd: root,
        env: {
          JUGGLEWORK_MANAGED_TEST_LOG: logPath,
          JUGGLEWORK_SERVER_TOKEN: "server-secret",
          JUGGLEWORK_VISIBLE_SETTING: "visible",
        },
      });

      expect(managed.url).toBe("http://127.0.0.1:43210");
      expect(managed.isAlive()).toBe(true);
      expect(managed.execution).toMatchObject({
        command: bin,
        cwd: root,
        args: ["serve", "--hostname", "127.0.0.1", "--port", expect.any(String), "--cors", "*"],
      });
      expect(managed.execution.env).toContainEqual({
        name: "JUGGLEWORK_VISIBLE_SETTING",
        value: "visible",
        redacted: false,
      });
      expect(managed.execution.env).toContainEqual({
        name: "JUGGLEWORK_SERVER_TOKEN",
        value: "<redacted>",
        redacted: true,
      });
      const serialized = JSON.stringify(managed.execution);
      expect(serialized).not.toContain("server-secret");
      expect(serialized).not.toContain(managed.username);
      expect(serialized).not.toContain(managed.password);

      const firstClose = managed.close();
      const secondClose = managed.close();
      expect(secondClose).toBe(firstClose);
      await Promise.all([firstClose, secondClose]);
      await expect(managed.close()).resolves.toBeUndefined();
      expect(managed.isAlive()).toBe(false);
      expect((await logLines(logPath)).filter((line) => line === "SIGTERM")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function expectReadinessFailureClosesChild(
    behavior: "unready" | "invalid",
    message: string,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "jugglework-managed-opencode-failure-"));
    const logPath = join(root, "managed.log");
    try {
      const bin = await writeFakeOpencode(root, behavior);
      await expect(createManagedOpencodeServer({
        bin,
        cwd: root,
        timeoutMs: 3000,
        env: { JUGGLEWORK_MANAGED_TEST_LOG: logPath },
      })).rejects.toThrow(message);
      expect((await logLines(logPath)).filter((line) => line === "SIGTERM")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test.serial("timeout readiness failure closes the child", async () => {
    await expectReadinessFailureClosesChild("unready", "Timeout waiting for OpenCode server");
  });

  test.serial("parse readiness failure closes the child", async () => {
    await expectReadinessFailureClosesChild("invalid", "Failed to parse OpenCode server URL");
  });
});
