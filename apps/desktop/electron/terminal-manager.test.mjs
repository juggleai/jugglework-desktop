import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalManager, assertTerminalSender, terminalEnvironment } from "./terminal-manager.mjs";

const binding = { workspaceId: "w", sessionId: "s", executionKind: "local", initialCwd: "/tmp", bindingRevision: "1" };
function fixture(resolveTarget = async () => binding) {
  const children = [];
  const manager = new TerminalManager({ resolveTarget, shell: "/bin/sh", env: {}, maxChars: 32, spawn: () => {
    const child = { kills: 0, data: null, exit: null, onData(cb) { this.data = cb; cb("early"); return { dispose() {} }; }, onExit(cb) { this.exit = cb; return { dispose() {} }; }, kill() { this.kills++; }, write() {}, resize() {} };
    children.push(child); return child;
  } });
  return { manager, children };
}
test("concurrent open is idempotent and pre-response output replays; owner protected", async () => {
  const { manager: m, children } = fixture();
  const [a, b] = await Promise.all([m.open(1, binding), m.open(1, binding)]);
  assert.equal(a.terminalId, b.terminalId); assert.equal(children.length, 1);
  assert.equal(m.read(1, a.terminalId).data, "early");
  assert.throws(() => m.read(2, a.terminalId), /NOT_FOUND/);
  assert.equal((await m.open(1, binding)).terminalId, a.terminalId);
  assert.equal(children[0].kills, 0);
  children[0].data("x".repeat(100));
  const read = m.read(1, a.terminalId);
  assert.equal(read.data.length, 32); assert.equal(read.gap, true);
  assert.throws(() => m.write(1, a.terminalId, "x".repeat(16385)), /INVALID_INPUT/);
  assert.throws(() => m.resize(1, a.terminalId, 999, 24), /INVALID_SIZE/);
  m.disposeOwner(1); assert.equal(children[0].kills, 1); assert.equal(m.entries.size, 0);
});
test("terminate waits for exit; restart explicitly creates a new process", async () => {
  const { manager: m, children } = fixture(); const a = await m.open(1, binding);
  assert.equal(m.terminate(1, a.terminalId).state, "terminating");
  await assert.rejects(m.restart(1, a.terminalId), /STILL_RUNNING/);
  children[0].exit({ exitCode: 0 });
  assert.equal(m.read(1, a.terminalId).state, "exited");
  m.lastCreate.clear();
  assert.notEqual((await m.restart(1, a.terminalId)).terminalId, a.terminalId);
  m.dispose(); assert.equal(m.entries.size, 0);
});
test("closed owner cancels pending resolution; host also rejects remote", async () => {
  let release = (_value) => {};
  const { manager: m, children } = fixture(() => new Promise((r) => { release = r; }));
  const pending = m.open(1, binding); m.disposeOwner(1); release(binding);
  await assert.rejects(pending, /TARGET_CLOSED/); assert.equal(children.length, 0);
  const remote = fixture(async () => ({ ...binding, executionKind: "remote" }));
  await assert.rejects(remote.manager.open(1, binding), /REMOTE/);
});
test("trusted main frame only and environment excludes tokens/injection", () => {
  const contents = { mainFrame: {} }; const window = { isDestroyed: () => false, webContents: contents };
  assertTerminalSender({ sender: contents, senderFrame: contents.mainFrame }, window);
  assert.throws(() => assertTerminalSender({ sender: contents, senderFrame: {} }, window), /UNTRUSTED/);
  assert.throws(() => assertTerminalSender({ sender: {}, senderFrame: contents.mainFrame }, window), /UNTRUSTED/);
  assert.deepEqual(terminalEnvironment({ PATH: "/bin", JUGGLEWORK_TOKEN: "secret", OPENAI_API_KEY: "secret", NODE_OPTIONS: "inject" }), { PATH: "/bin", TERM: "xterm-256color", COLORTERM: "truecolor" });
});
