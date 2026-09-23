import assert from "node:assert/strict";
import test from "node:test";
import { applyConfig, CliArgumentError, createSignalController, isInteractiveCli, parseCliArgs, validateCliConfig } from "../src/args.js";

test("parses one-shot and continue prompts", () => {
  assert.equal(parseCliArgs(["review", "this"]).prompt, "review this");
  const resumed = parseCliArgs(["--continue", "finish", "the", "review"]);
  assert.deepEqual(resumed.command, { group: "runtime", action: "resume" });
  assert.equal(resumed.continueLatest, true);
  assert.equal(resumed.prompt, "finish the review");
});

test("parses explicit exec prompts and exec-only output options", () => {
  const options = parseCliArgs([
    "exec", "review", "this",
    "--output-last-message", "result.txt",
    "--output-schema", "schema.json",
  ]);
  assert.deepEqual(options.command, { group: "runtime", action: "exec" });
  assert.equal(options.prompt, "review this");
  assert.equal(options.outputLastMessage?.endsWith("result.txt"), true);
  assert.equal(options.outputSchema?.endsWith("schema.json"), true);
  assert.throws(
    () => parseCliArgs(["review", "this", "--output-last-message", "result.txt"]),
    /supported only with 'jugglework exec'/,
  );
});

test("parses explicit resume and rejects unknown flags", () => {
  const options = parseCliArgs(["resume", "ses_123"]);
  assert.deepEqual(options.command, { group: "runtime", action: "resume" });
  assert.equal(options.sessionId, "ses_123");
  assert.throws(() => parseCliArgs(["--mystery"]), CliArgumentError);
});

test("parses hierarchical Cloud commands without consuming positional prompts", () => {
  assert.deepEqual(parseCliArgs(["login", "status"]).command, { group: "account", action: "login-status" });
  assert.deepEqual(parseCliArgs(["org", "use", "engineering"]).command, { group: "org", action: "use", target: "engineering" });
  assert.deepEqual(parseCliArgs(["provider", "list"]).command, { group: "provider", action: "list", target: null });
  assert.deepEqual(parseCliArgs(["provider", "import", "pub_1"]).command, { group: "provider", action: "import", target: "pub_1" });
  assert.deepEqual(parseCliArgs(["provider", "remove", "pub_1"]).command, { group: "provider", action: "remove", target: "pub_1" });
  assert.equal(parseCliArgs(["review", "provider", "list"]).prompt, "review provider list");
});

test("parses grouped session commands and compatibility aliases", () => {
  assert.deepEqual(parseCliArgs(["session", "list"]).command, { group: "session", action: "list" });
  assert.deepEqual(parseCliArgs(["session", "show", "ses_1"]).command, { group: "session", action: "show", target: "ses_1" });
  assert.deepEqual(parseCliArgs(["session", "queue", "ses_1", "review", "this"]).command, {
    group: "session", action: "queue", target: "ses_1", value: "review this",
  });
  assert.deepEqual(parseCliArgs(["session", "rename", "ses_1", "New title"]).command, {
    group: "session", action: "rename", target: "ses_1", value: "New title",
  });
  assert.deepEqual(parseCliArgs(["fork", "ses_1"]).command, { group: "session", action: "fork", target: "ses_1" });
  assert.deepEqual(parseCliArgs(["sessions"]).command, { group: "runtime", action: "sessions" });
  assert.deepEqual(parseCliArgs(["resume", "ses_1"]).command, { group: "runtime", action: "resume" });
  assert.throws(() => parseCliArgs(["session", "show"]), /session requires/);
  assert.throws(() => parseCliArgs(["session", "delete", "ses_1", "extra"]), /session requires/);
  assert.throws(() => parseCliArgs(["session", "list", "--force"]), /--force is supported only/);
});

test("explicit values override environment and config", () => {
  const parsed = parseCliArgs(["--server", "http://explicit", "--token", "explicit-token", "--cloud-url", "https://explicit.example"]);
  const applied = applyConfig(
    parsed,
    { serverUrl: "http://file", token: "file-token", model: "file/model", cloudUrl: "https://file.example", cloudOrg: "file-org" },
    { JUGGLEWORK_SERVER_URL: "http://env", JUGGLEWORK_TOKEN: "env-token", JUGGLEWORK_MODEL: "env/model", JUGGLEWORK_CLOUD_URL: "https://env.example", JUGGLEWORK_CLOUD_TOKEN: "cloud-token", JUGGLEWORK_CLOUD_ORG: "env-org" },
  );
  assert.equal(applied.serverUrl, "http://explicit");
  assert.equal(applied.token, "explicit-token");
  assert.equal(applied.model, "env/model");
  assert.equal(applied.cloudUrl, "https://explicit.example");
  assert.equal(applied.cloudToken, "cloud-token");
  assert.equal(applied.cloudOrg, "env-org");
});

test("Cloud configuration defaults independently from runtime configuration", () => {
  const applied = applyConfig(parseCliArgs(["--server", "http://runtime.example"]), {}, {});
  assert.equal(applied.serverUrl, "http://runtime.example");
  assert.equal(applied.cloudUrl, "https://work.jugglechat.cn");
});

test("parses workspace commands through the Server command foundation", () => {
  assert.deepEqual(parseCliArgs(["workspace", "list"]).command, { group: "workspace", action: "list", target: null });
  assert.deepEqual(parseCliArgs(["workspace", "add", "/tmp/project"]).command, { group: "workspace", action: "add", target: "/tmp/project" });
  assert.deepEqual(parseCliArgs(["workspace", "open", "ws_123"]).command, { group: "workspace", action: "open", target: "ws_123" });
  assert.throws(() => parseCliArgs(["workspace", "remove", "ws_123"]), /workspace requires/);
});

test("keeps sandbox and approval explicit and validates the Server mapping", () => {
  const defaults = parseCliArgs([]);
  assert.equal(defaults.sandbox, "workspace-write");
  assert.equal(defaults.approval, "on-request");
  assert.equal(defaults.fullAccess, false);
  const bypass = parseCliArgs(["--dangerously-bypass-approvals-and-sandbox"]);
  assert.equal(bypass.sandbox, "danger-full-access");
  assert.equal(bypass.approval, "never");
  assert.equal(bypass.fullAccess, true);
  assert.throws(() => parseCliArgs(["--sandbox", "danger-full-access", "--approval", "on-request"]), /requires --approval never/);
  assert.throws(() => parseCliArgs(["--sandbox", "container"]), /requires one of/);
  assert.throws(() => parseCliArgs(["--approval", "always"]), /requires one of/);
});

test("safety configuration respects CLI, environment, and config precedence", () => {
  const fromEnvironment = applyConfig(parseCliArgs([]), { sandbox: "workspace-write", approval: "on-request" }, {
    JUGGLEWORK_SANDBOX: "danger-full-access", JUGGLEWORK_APPROVAL: "never",
  });
  assert.equal(fromEnvironment.fullAccess, true);
  const explicit = applyConfig(parseCliArgs(["--sandbox", "workspace-write", "--approval", "never"]), {
    sandbox: "danger-full-access", approval: "never",
  }, {});
  assert.equal(explicit.sandbox, "workspace-write");
  assert.equal(explicit.approval, "never");
  assert.equal(explicit.fullAccess, false);
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
