import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const pty = createRequire(import.meta.url)(["node", "pty"].join("-"));
import { TerminalManager } from "./terminal-manager.mjs";

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("PTY timeout");
}

test("native PTY: cwd, input, resize, retained process, terminate", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const cwd = process.cwd();
  const manager = new TerminalManager({
    resolveTarget: async () => ({ workspaceId: "w", sessionId: "s", executionKind: "local", initialCwd: cwd, bindingRevision: cwd }),
    spawn: pty.spawn, shell: "/bin/sh", env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
  });
  try {
    const a = await manager.open(1, { workspaceId: "w", sessionId: "s" });
    manager.resize(1, a.terminalId, 100, 30);
    manager.write(1, a.terminalId, "printf 'CWD=%s\\n' \"$PWD\"\r");
    await until(() => manager.read(1, a.terminalId).data.includes(`CWD=${cwd}`));
    const b = await manager.open(1, { workspaceId: "w", sessionId: "s" });
    assert.equal(a.terminalId, b.terminalId);
    manager.terminate(1, a.terminalId);
    await until(() => manager.read(1, a.terminalId).state === "exited");
  } finally { manager.dispose(); }
});

test("macOS PTY renders bracketed Chinese paste before pressing Enter", {
  skip: process.platform !== "darwin",
  timeout: 10000,
}, async () => {
  const cwd = process.cwd();
  const manager = new TerminalManager({
    resolveTarget: async () => ({ workspaceId: "w", sessionId: "s", executionKind: "local", initialCwd: cwd, bindingRevision: cwd }),
    spawn: (shell, args, options) => pty.spawn(shell, [...args, "-f"], options),
    shell: "/bin/zsh",
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
  });
  try {
    const { terminalId } = await manager.open(1, { workspaceId: "w", sessionId: "s" });
    const read = (cursor = 0) => manager.read(1, terminalId, cursor);
    await until(() => read().data.includes("\x1b[?2004h"));
    const cursor = read().cursor;
    const chinese = "粘贴中文";
    manager.write(1, terminalId, `\x1b[200~echo ${chinese}\x1b[201~`);
    await until(() => read(cursor).data.includes(`echo ${chinese}`));
    manager.write(1, terminalId, "\r");
    await until(() => read(cursor).data.includes(`\r\n${chinese}\r\n`));
  } finally { manager.dispose(); }
});
