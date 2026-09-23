import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cwd = resolve(import.meta.dirname, "..");
type Result = { code: number | null; stdout: string; stderr: string };

function send(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json", "X-Request-Id": "req_test" }).end(JSON.stringify(body));
}

function run(args: string[], env: NodeJS.ProcessEnv = {}, input = ""): Promise<Result> {
  const child = spawn(process.execPath, ["src/cli.ts", "--json", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
  child.stdin.end(input);
  return new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => done({ code, stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") }));
  });
}

function record(result: Result): Record<string, unknown> {
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

async function mockCloud(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())),
  };
}

test("login status has stable signed-in and signed-out exit codes without starting runtime", async () => {
  const cloud = await mockCloud((request, response) => {
    assert.equal(request.url, "/jwork/api/v1/me");
    assert.equal(request.headers.authorization, "Bearer environment-cloud-token");
    send(response, { user: { id: "user_1", email: "person@example.test" } });
  });
  const root = await mkdtemp(join(tmpdir(), "jugglework-cloud-status-"));
  try {
    const common = ["--cloud-url", cloud.url, "--config", join(root, "cli.json"), "--opencode-bin", join(root, "does-not-exist"), "login", "status"];
    const signedIn = await run(common, { JUGGLEWORK_CLOUD_TOKEN: "environment-cloud-token" });
    assert.equal(signedIn.code, 0, signedIn.stdout);
    assert.equal(record(signedIn).status, "signed_in");
    const signedOut = await run(common);
    assert.equal(signedOut.code, 1, signedOut.stdout);
    assert.equal(record(signedOut).status, "signed_out");
  } finally {
    await cloud.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog is anonymous and organization inventory is scoped without runtime startup", async () => {
  const requests: Array<{ path: string; authorization?: string; currentOrg?: string; legacyOrg?: string }> = [];
  const cloud = await mockCloud((request, response) => {
    requests.push({
      path: request.url ?? "",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(typeof request.headers["x-jugglework-org-id"] === "string" ? { currentOrg: request.headers["x-jugglework-org-id"] } : {}),
      ...(typeof request.headers["x-jugglework-legacy-org-id"] === "string" ? { legacyOrg: request.headers["x-jugglework-legacy-org-id"] } : {}),
    });
    if (request.url === "/jwork/models/api.json") return send(response, { public_provider: { models: { public_model: { name: "Public model" } } } });
    if (request.url === "/jwork/api/v1/me/orgs") return send(response, { orgs: [{ id: "org_1", slug: "engineering", name: "Engineering" }] });
    if (request.url === "/jwork/api/v1/llm-providers") return send(response, { llmProviders: [
      { id: "publication_1", providerId: "provider_1", name: "Provider One", models: [] },
      { id: "publication_disabled", providerId: "provider_2", name: "Disabled", enabled: false, models: [] },
      { id: "publication_hosted", providerId: "jugglework", name: "Hosted", models: [] },
    ] });
    send(response, { error: "not_found" }, 404);
  });
  const root = await mkdtemp(join(tmpdir(), "jugglework-cloud-inventory-"));
  try {
    const runtimePoison = ["--server", "http://127.0.0.1:1", "--opencode-bin", join(root, "missing-opencode")];
    const catalog = await run(["--cloud-url", cloud.url, ...runtimePoison, "catalog", "list"], { JUGGLEWORK_CLOUD_TOKEN: "must-not-be-sent" });
    assert.equal(catalog.code, 0, catalog.stdout);
    assert.equal(record(catalog).label, "Public catalog metadata");
    const providers = await run(["--cloud-url", cloud.url, ...runtimePoison, "provider", "list"], {
      JUGGLEWORK_CLOUD_TOKEN: "cloud-session",
      JUGGLEWORK_CLOUD_ORG: "org_1",
    });
    assert.equal(providers.code, 0, providers.stdout);
    assert.equal(record(providers).label, "Organization providers");
    assert.equal((record(providers).items as unknown[]).length, 1);
    assert.deepEqual(requests[0], { path: "/jwork/models/api.json" });
    assert.deepEqual(requests.at(-1), {
      path: "/jwork/api/v1/llm-providers",
      authorization: "Bearer cloud-session",
      currentOrg: "org_1",
      legacyOrg: "org_1",
    });
  } finally {
    await cloud.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["grant_expired", "grant_replayed"] as const) {
  test(`login reports ${failure} without leaking the one-time grant`, async () => {
    const cloud = await mockCloud((_request, response) => send(response, {
      error: failure,
      message: `sensitive_grant_12345 ${failure}`,
      referenceId: "ref_login",
    }, 401));
    const root = await mkdtemp(join(tmpdir(), "jugglework-cloud-login-"));
    try {
      const result = await run([
        "--cloud-url", cloud.url,
        "--config", join(root, "cli.json"),
        "--grant-stdin",
        "login",
      ], {}, "sensitive_grant_12345\n");
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stdout, /sensitive_grant_12345/);
      assert.match(String(record(result).message), /HTTP 401.*req_test.*\[grant_(?:expired|replayed)\]/);
    } finally {
      await cloud.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("successful grant login persists atomically while environment tokens remain non-persistent", async () => {
  const cloud = await mockCloud((request, response) => {
    if (request.url?.endsWith("/desktop-handoff/exchange")) return send(response, { token: "persisted-session", user: { id: "user_1" } });
    if (request.url?.endsWith("/v1/me")) return send(response, { user: { id: "user_1", email: "person@example.test" } });
    send(response, { error: "not_found" }, 404);
  });
  const root = await mkdtemp(join(tmpdir(), "jugglework-cloud-login-success-"));
  const config = join(root, "cli.json");
  try {
    const result = await run(["--cloud-url", cloud.url, "--config", config, "--grant-stdin", "login"], {}, "valid_grant_12345\n");
    assert.equal(result.code, 0, result.stdout);
    const profileText = await readFile(join(root, "cloud-profiles.json"), "utf8");
    assert.match(profileText, /persisted-session/);
    assert.doesNotMatch(result.stdout, /persisted-session|valid_grant_12345/);
    const status = await run(["--cloud-url", cloud.url, "--config", config, "login", "status"], { JUGGLEWORK_CLOUD_TOKEN: "environment-only-token" });
    assert.equal(status.code, 0);
    assert.doesNotMatch(await readFile(join(root, "cloud-profiles.json"), "utf8"), /environment-only-token/);
  } finally {
    await cloud.close();
    await rm(root, { recursive: true, force: true });
  }
});
