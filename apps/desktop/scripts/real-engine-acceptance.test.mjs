import assert from "node:assert/strict";
import { test } from "node:test";
import { isolatedEnv, parseOptions, sidecarTarget, childRun } from "./real-engine-acceptance.mjs";
import { consumeSse, streamHealth, roundSseEvidence, isTerminalEvent, reapProcessGroup } from "./real-engine-acceptance-helpers.mjs";

test("child allowlist excludes credentials, proxies and host HOME; every state path is disposable", () => {
  const root = "/private/tmp/synthetic-real-engine";
  const env = isolatedEnv(root);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "NODE_OPTIONS", "BUN_OPTIONS"])
    assert.equal(env[key], undefined);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_DB", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "JUGGLEWORK_RUNTIME_DB", "JUGGLEWORK_ENV_STORE"])
    assert.ok(env[key].startsWith(root + "/"), key);
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, "1");
  assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, "1");
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
});

test("strict absolute Bun override, duplicate/unknown arguments and architecture pairing", () => {
  assert.deepEqual(parseOptions(["--drop-terminal-events", "--bun", "/opt/test/bun"]), { bun: "/opt/test/bun", dropTerminalEvents: true });
  for (const args of [["--bun"], ["--bun", "bun"], ["--bun=/x"], ["--unknown"], ["--bun", "/x", "--bun", "/y"], ["--drop-terminal-events", "--drop-terminal-events"]])
    assert.throws(() => parseOptions(args));
  assert.deepEqual(sidecarTarget("darwin", "x64"), { binary: "opencode-x86_64-apple-darwin", manifest: "versions-x86_64-apple-darwin.json" });
  assert.throws(() => sidecarTarget("linux", "arm64"));
});

const info = (id, role, extra = {}) => ({ type: "message.updated", properties: { info: { id, role, sessionID: "s", ...extra } } });
const part = (id, text) => ({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: id, type: "text", text } } });
const busy = { type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } };
const idle = { type: "session.status", properties: { sessionID: "s", status: { type: "idle" } } };
const round = [info("u1", "user"), part("u1", "prompt"), busy, part("a1", "answer"), info("a1", "assistant", { parentID: "u1", finish: "stop", time: { completed: 1 } }), idle];
const options = { startIndex: 0, sessionId: "s", prompt: "prompt", answer: "answer" };

test("completion requires current-round parent-linked final AND subsequent idle; negative filter cannot pass", () => {
  assert.equal(roundSseEvidence(round, options).assistantMessageId, "a1");
  assert.equal(roundSseEvidence(round.filter(e => !isTerminalEvent(e)), options), undefined);
  assert.equal(roundSseEvidence(round.filter(e => e !== round[4]), options), undefined);
  assert.equal(roundSseEvidence(round.slice(0, -1), options), undefined);
  assert.equal(roundSseEvidence(round, { ...options, startIndex: round.length }), undefined);
  assert.equal(roundSseEvidence(round.map(e => e === round[4] ? info("a1", "assistant", { parentID: "old", finish: "stop", time: { completed: 1 } }) : e), options), undefined);
});

test("abort cannot borrow the completed turn's busy/idle or pre-abort idle", () => {
  const abortRound = [info("u2", "user"), part("u2", "stall"), busy];
  const events = [...round, ...abortRound];
  const opts = { startIndex: round.length, sessionId: "s", prompt: "stall", abortIndex: events.length };
  assert.equal(roundSseEvidence(events, opts), undefined);
  assert.equal(roundSseEvidence([...events, idle], opts).userMessageId, "u2");
  assert.equal(roundSseEvidence([...round, ...abortRound.slice(0, 2), idle], opts), undefined);
});

test("SSE EOF, reader failure and malformed data are explicit sticky failures; cleanup abort is expected", async () => {
  for (const body of [
    new ReadableStream({ start(c) { c.close(); } }),
    new ReadableStream({ start(c) { c.error(Error("reader failed")); } }),
    new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: invalid-json\n\n")); c.close(); } }),
  ]) {
    const health = streamHealth();
    await consumeSse(body, new AbortController().signal, () => {}, health);
    assert.throws(() => health.check()); // No rejected task/unhandled rejection.
    assert.throws(() => health.check()); // A later successful poll cannot clear it.
  }
  const controller = new AbortController(); controller.abort();
  const health = streamHealth();
  await consumeSse(new ReadableStream({ start(c) { c.close(); } }), controller.signal, () => {}, health);
  health.check();
});

test("group cleanup targets only the original detached group and propagates unexpected probe errors", () => {
  const calls = [];
  assert.equal(reapProcessGroup(1234, (...args) => calls.push(args)), true);
  assert.deepEqual(calls, [[-1234, 0], [-1234, "SIGKILL"]]);
  assert.equal(reapProcessGroup(1234, () => { throw Object.assign(Error(), { code: "ESRCH" }); }), false);
  assert.throws(() => reapProcessGroup(1234, () => { throw Object.assign(Error(), { code: "EPERM" }); }));
  assert.throws(() => reapProcessGroup(0));
});

test("a zero-exit worker with a live descendant fails and forcibly reaps its group", async () => {
  const script = `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'}).unref();`;
  await assert.rejects(childRun(process.execPath, ["-e", script], "/private/tmp", { PATH: "/usr/bin:/bin" }, 5000), /residual process group/);
});
