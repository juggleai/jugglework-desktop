import assert from "node:assert/strict";
import test from "node:test";
import { applyConfig, CliArgumentError, createSignalController, isInteractiveCli, parseCliArgs, validateCliConfig } from "../src/args.js";

test("parses one-shot and continue prompts", () => {
  assert.equal(parseCliArgs(["review", "this"]).prompt, "review this");
  const resumed = parseCliArgs(["--continue", "finish", "the", "review"]);
  assert.equal(resumed.command, "resume");
  assert.equal(resumed.continueLatest, true);
  assert.equal(resumed.prompt, "finish the review");
});

test("parses explicit resume and rejects unknown flags", () => {
  const options = parseCliArgs(["resume", "ses_123"]);
  assert.equal(options.command, "resume");
  assert.equal(options.sessionId, "ses_123");
  assert.throws(() => parseCliArgs(["--mystery"]), CliArgumentError);
});

test("explicit values override environment and config", () => {
  const parsed = parseCliArgs(["--server", "http://explicit", "--token", "explicit-token"]);
  const applied = applyConfig(
    parsed,
    { serverUrl: "http://file", token: "file-token", model: "file/model" },
    { JUGGLEWORK_SERVER_URL: "http://env", JUGGLEWORK_TOKEN: "env-token", JUGGLEWORK_MODEL: "env/model" },
  );
  assert.equal(applied.serverUrl, "http://explicit");
  assert.equal(applied.token, "explicit-token");
  assert.equal(applied.model, "env/model");
});

test("config accepts only documented string fields", () => {
  assert.deepEqual(validateCliConfig({ serverUrl: "http://server", token: "secret" }), {
    serverUrl: "http://server",
    token: "secret",
  });
  assert.throws(
    () => validateCliConfig({ token: 123 }),
    /CLI config fields must be strings: token/,
  );
  assert.throws(
    () => validateCliConfig({ unexpected: "secret-value" }),
    (error: unknown) => {
      assert.ok(error instanceof CliArgumentError);
      assert.doesNotMatch(error.message, /secret-value/);
      assert.match(error.message, /unsupported fields/);
      return true;
    },
  );
});

test("json disables terminal color regardless of option order", () => {
  assert.equal(parseCliArgs(["--json"]).color, false);
  assert.equal(parseCliArgs(["--no-color", "--json"]).json, true);
});

test("json disables readline interaction even when both streams are TTYs", () => {
  assert.equal(isInteractiveCli({ json: false }, true, true), true);
  assert.equal(isInteractiveCli({ json: true }, true, true), false);
  assert.equal(isInteractiveCli({ json: false }, true, false), false);
});

test("signal controller aborts an active run, starts shutdown, and forces a second signal", async () => {
  const events: string[] = [];
  let resolveAbort!: () => void;
  const abort = new Promise<void>((resolvePromise) => { resolveAbort = resolvePromise; });
  const controller = createSignalController({
    hasActiveRun: () => true,
    abortActiveRun: async () => { events.push("abort"); await abort; },
    beginShutdown: (signal, exitCode) => events.push(`shutdown:${signal}:${exitCode}`),
    forceExit: (exitCode) => events.push(`force:${exitCode}`),
  });

  controller.handle("SIGINT");
  await Promise.resolve();
  assert.deepEqual(events, ["abort"]);
  controller.handle("SIGINT");
  assert.deepEqual(events, ["abort", "force:130"]);
  resolveAbort();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["abort", "force:130", "shutdown:SIGINT:130"]);
});

test("idle termination signals start shutdown and the next signal forces exit", () => {
  const events: string[] = [];
  const controller = createSignalController({
    hasActiveRun: () => false,
    abortActiveRun: async () => {},
    beginShutdown: (signal, exitCode) => events.push(`shutdown:${signal}:${exitCode}`),
    forceExit: (exitCode) => events.push(`force:${exitCode}`),
  });
  controller.handle("SIGTERM");
  controller.handle("SIGTERM");
  assert.deepEqual(events, ["shutdown:SIGTERM:143", "force:143"]);
});
