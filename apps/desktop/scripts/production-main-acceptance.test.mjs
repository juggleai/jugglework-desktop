import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptanceEnv, sandboxProfile, redact, seed, nativePaths, ancestorPaths, assertStartupOutput } from "./production-main-acceptance.mjs";

test("launcher excludes inherited credentials, proxy, CA, Node hooks and Electron bypass", () => {
  const env = acceptanceEnv("/tmp/acceptance", 49123);
  for (const name of ["OPENAI_API_KEY", "AWS_PROFILE", "HTTP_PROXY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "NODE_USE_SYSTEM_CA", "VITE_DEN_TOKEN"])
    assert.equal(env[name], undefined);
  assert.equal(env.JUGGLEWORK_DEV_MODE, "0");
  assert.equal(env.MAC_CHROMIUM_TMPDIR, "/tmp/acceptance/tmp");
  for (const name of ["HOME", "CFFIXED_USER_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "JUGGLEWORK_DATA_DIR", "JUGGLEWORK_SERVER_CONFIG", "JUGGLEWORK_ENV_STORE", "JUGGLEWORK_DESKTOP_BOOTSTRAP_PATH", "JUGGLEWORK_RUNTIME_DB", "OPENCODE_DB", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"])
    assert.ok(env[name].startsWith("/tmp/acceptance/"), name);
  assert.ok(nativePaths.includes("downloads") && nativePaths.includes("desktop") && nativePaths.includes("sessionData"));
});

test("bundle traversal exceptions grant exact ancestor metadata, never ancestor contents", () => {
  assert.deepEqual(ancestorPaths("/Users/synthetic/projects/repo"), ["/Users/synthetic/projects", "/Users/synthetic", "/Users", "/"]);
  const profile = sandboxProfile("/private/tmp/smoke", "/Users/synthetic", "/Users/synthetic/projects/repo");
  const dataRule = profile.split("\n").find(line => line.startsWith("(deny file-read-data"));
  assert.ok(!dataRule.includes('(literal "/Users/synthetic")'));
  assert.match(profile, /deny file-read-metadata.*literal "\/Users\/synthetic\/projects"/);
  assert.match(dataRule, /subpath "\/Users"/);
});

test("OS policy confines outbound/bind, user files, writes and forbidden credential executables", () => {
  const profile = sandboxProfile("/private/tmp/smoke", "/Users/synthetic", "/Users/synthetic/repo");
  assert.match(profile, /deny network-outbound/); assert.match(profile, /deny network-bind/);
  // Seatbelt's IP filter accepts the special host localhost, not IP literals.
  assert.match(profile, /remote ip "localhost:\*"/);
  for (const value of ["local ip \"localhost:*\"", "deny file-write*", "require-not (subpath", "Keychains", "/usr/bin/security", "/usr/bin/codesign", "/Users/synthetic/repo"])
    assert.ok(profile.includes(value), value);
});

test("UNIX socket exceptions are path-only and confined to fixture descendants", () => {
  const profile = sandboxProfile("/private/tmp/smoke", "/Users/synthetic", "/Users/synthetic/repo");
  const networkAllows = profile.split("\n").filter(line => /^\(allow network-(?:bind|outbound)/.test(line));
  assert.deepEqual(networkAllows, [
    '(allow network-outbound (remote ip "localhost:*"))',
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-bind (prefix "/private/tmp/smoke/"))',
    '(allow network-outbound (prefix "/private/tmp/smoke/"))',
  ]);
  assert.ok(!"/private/tmp/smoke-outside/socket".startsWith("/private/tmp/smoke/"));
  assert.ok(!profile.includes("no-sandbox") && !profile.includes("disable-setuid-sandbox"));
});

test("temporary fixtures are anonymous and DB creation belongs to production", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "production-main-fixture-test-"));
  try {
    const env = await seed(root, 49123);
    assert.deepEqual(JSON.parse(await readFile(env.JUGGLEWORK_SERVER_CONFIG)), { workspaces: [], authorizedRoots: [] });
    assert.deepEqual(JSON.parse(await readFile(env.JUGGLEWORK_ENV_STORE)).variables, []);
    assert.deepEqual(JSON.parse(await readFile(env.OPENCODE_CONFIG)), {});
    for (const file of [env.JUGGLEWORK_RUNTIME_DB, env.OPENCODE_DB]) await assert.rejects(access(file), { code: "ENOENT" });
    assert.equal(await readFile(env.NODE_EXTRA_CA_CERTS, "utf8"), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("redacts credential-shaped log values while preserving actual error diagnostics", () => {
  const raw = 'Error missing artifact token=synthetic-secret clientToken: "fixture-token" Authorization: Bearer fixture-auth http://user:pass@127.0.0.1/a?token=fixture-query ' + "a".repeat(64);
  const safe = redact(raw);
  for (const secret of ["synthetic-secret", "fixture-token", "fixture-auth", "user:pass", "fixture-query", "a".repeat(64)]) assert.ok(!safe.includes(secret), secret);
  assert.match(safe, /Error missing artifact/);
});

test("native errors and production cleanup failures cannot be hidden by zero exit or PASS markers", () => {
  const success = "PASS normal app.quit cleanup\nPASS production-main acceptance complete\n";
  assertStartupOutput(success);
  for (const error of ["FAIL unexpected app quit", "RENDERER ERROR missing export", "sandbox initialization failed: Operation not permitted",
    "Failed to initialize sandbox.", "Failed to bind() /synthetic/tmp/SingletonSocket: Operation not permitted",
    "Unable to find helper app", "[quit] cleanup timed out", "[quit] one or more cleanup tasks failed"])
    assert.throws(() => assertStartupOutput(success + error), undefined, error);
  assert.throws(() => assertStartupOutput("OBSERVED actual production main module evaluated"));
});
