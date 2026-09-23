import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { REQUIRED_PLUGIN_FILES } from "../src/runtime.js";

const cwd = resolve(import.meta.dirname, "..");
type Result = { code: number | null; stdout: string; stderr: string };

function send(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  const child = spawn(process.execPath, ["src/cli.ts", ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  return new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => done({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

test("doctor reports Cloud, workspace, assets, and skipped runtime without starting embedded runtime", async () => {
  const cloud = createServer((request, response) => {
    if (request.url === "/jwork/models/api.json") return send(response, { provider: { models: {} } });
    if (request.url === "/jwork/api/v1/me") return send(response, { user: { id: "user_1" } });
    if (request.url === "/jwork/api/v1/me/orgs") return send(response, { orgs: [{ id: "org_1", slug: "engineering", name: "Engineering" }] });
    if (request.url === "/jwork/api/v1/llm-providers") return send(response, { llmProviders: [{ id: "pub_1", providerId: "safe-provider", name: "Safe Provider", enabled: true, models: [{ id: "safe-model", name: "Safe Model" }] }] });
    return send(response, { error: "not_found" }, 404);
  });
  await new Promise<void>((done) => cloud.listen(0, "127.0.0.1", done));
  const address = cloud.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "jugglework-doctor-"));
  const workspace = join(root, "workspace");
  const plugins = join(root, "plugins");
  const opencode = join(root, process.platform === "win32" ? "opencode.exe" : "opencode");
  try {
    await mkdir(workspace);
    await mkdir(plugins);
    await writeFile(opencode, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    if (process.platform !== "win32") await chmod(opencode, 0o700);
    for (const file of REQUIRED_PLUGIN_FILES) await writeFile(join(plugins, file), "export default {}\n");
    const result = await run([
      "doctor", "--json", "--cloud-url", `http://127.0.0.1:${address.port}`, "--config", join(root, "cli.json"),
      "--workspace", workspace, "--opencode-bin", opencode, "--plugin-dir", plugins,
    ], { JUGGLEWORK_CLOUD_TOKEN: "doctor-cloud-secret", JUGGLEWORK_CLOUD_ORG: "org_1", JUGGLEWORK_SERVER_URL: "", JUGGLEWORK_TOKEN: "", JUGGLEWORK_RUNTIME_DB: join(root, "must-not-be-created.sqlite") });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /doctor-cloud-secret/);
    const event = JSON.parse(result.stdout.trim()) as { type: string; report: { ok: boolean; checks: Array<{ id: string; status: string; details?: Record<string, unknown> }> } };
    assert.equal(event.type, "doctor");
    assert.equal(event.report.ok, true);
    assert.equal(event.report.checks.find((check) => check.id === "providers_models")?.details?.models, 1);
    assert.deepEqual(event.report.checks.find((check) => check.id === "runtime")?.details, { connected: false, embeddedStarted: false });
  } finally {
    await new Promise<void>((done, reject) => cloud.close((error) => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor probes an explicitly connected runtime and keeps human output redacted", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/jwork/models/api.json") return send(response, {});
    assert.equal(request.headers.authorization, "Bearer runtime-secret");
    if (request.url === "/health") return send(response, { ok: true, version: "1.2.3", opencodeVersion: "1.18.15" });
    if (request.url === "/status") return send(response, { ok: true, readOnly: false });
    if (request.url === "/workspaces") return send(response, { items: [{ id: "ws_1" }] });
    if (request.url === "/workspace/ws_1/runtime-config") return send(response, { runtimeKeys: ["provider"], effectiveRuntime: { provider: { safe: { apiKey: "must-not-leak" } } } });
    return send(response, { code: "not_found", message: "runtime-secret" }, 404);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "jugglework-doctor-connected-"));
  try {
    const result = await run(["doctor", "--cloud-url", `http://127.0.0.1:${address.port}`, "--config", join(root, "cli.json"), "--server", `http://127.0.0.1:${address.port}`, "--token", "runtime-secret", "--opencode-bin", join(root, "missing")]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /PASS\s+runtime\s+Runtime is healthy/);
    assert.match(result.stdout, /FAIL\s+runtime_assets/);
    assert.doesNotMatch(result.stdout + result.stderr, /runtime-secret|must-not-leak/);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor compares published providers with authenticated runtime visibility", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/jwork/models/api.json") return send(response, {});
    if (request.url === "/jwork/api/v1/me") return send(response, { user: { id: "user_1" } });
    if (request.url === "/jwork/api/v1/me/orgs") return send(response, { orgs: [{ id: "org_1", slug: "engineering", name: "Engineering" }] });
    if (request.url === "/jwork/api/v1/llm-providers") return send(response, { llmProviders: [{ id: "lpr_1", providerId: "safe", name: "Safe", models: [{ id: "model_1", name: "Model" }] }] });
    if (request.url === "/health") return send(response, { ok: true, version: "1.2.22" });
    if (request.url === "/status") return send(response, { ok: true });
    if (request.url === "/workspaces") return send(response, { items: [{ id: "ws_1" }] });
    if (request.url === "/workspace/ws_1/runtime-config") return send(response, { effectiveRuntime: { provider: { lpr_1: {} } } });
    if (request.url === "/workspace/ws_1/provider-status/lpr_1") {
      assert.equal(request.headers["x-jugglework-host-token"], "host-secret");
      return send(response, { providerId: "lpr_1", imported: true, loaded: true, authenticated: true, enabled: true, models: [{ id: "model_1", verifiedExecutable: null }] });
    }
    return send(response, { error: "not_found" }, 404);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "jugglework-doctor-provider-"));
  try {
    const url = `http://127.0.0.1:${address.port}`;
    const result = await run(["doctor", "--json", "--cloud-url", url, "--server", url, "--token", "runtime-secret", "--host-token", "host-secret", "--workspace-id", "ws_1", "--opencode-bin", join(root, "missing")], { JUGGLEWORK_CLOUD_TOKEN: "cloud-secret", JUGGLEWORK_CLOUD_ORG: "org_1" });
    const report = (JSON.parse(result.stdout.trim()) as { report: { checks: Array<{ id: string; details?: Record<string, unknown> }> } }).report;
    const visibility = report.checks.find((check) => check.id === "provider_visibility");
    assert.deepEqual(visibility?.details?.states, [{ id: "lpr_1", published: true, imported: true, loaded: true, authenticated: true, enabled: true, models: 1, verifiedExecutable: null }]);
    assert.doesNotMatch(result.stdout + result.stderr, /host-secret|cloud-secret|runtime-secret/);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});
