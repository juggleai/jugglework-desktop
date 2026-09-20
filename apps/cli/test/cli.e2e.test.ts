import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

type Scenario = "complete" | "fast" | "abort" | "permission" | "question";
type MockState = {
  scenario: Scenario;
  started: boolean;
  aborted: boolean;
  observations: string[];
  prompts: string[];
  sessions: Array<{ id: string; title: string; time: { created: number; updated: number } }>;
};

type SpawnResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

const cwd = resolve(import.meta.dirname, "..");

function send(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function messages(state: MockState): unknown[] {
  const previous = [{
    info: { id: "msg_old", sessionID: "ses_existing", role: "assistant", time: { completed: 1 } },
    parts: [{ id: "part_old", type: "text", text: "previous answer" }],
  }];
  if (!state.started || state.scenario === "abort") return previous;
  return [...previous, {
    info: { id: "msg_new", sessionID: "ses_existing", role: "assistant", time: { completed: Date.now() } },
    parts: [{ id: "part_new", type: "text", text: state.scenario === "fast" ? "fast complete" : "mock complete" }],
  }];
}

async function startMockServer(scenario: Scenario = "complete") {
  const state: MockState = {
    scenario,
    started: false,
    aborted: false,
    observations: [],
    prompts: [],
    sessions: [{ id: "ses_existing", title: "Existing", time: { created: 1, updated: 2 } }],
  };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    const url = new URL(request.url ?? "/", "http://mock");
    if (request.method === "GET" && url.pathname === "/health") return send(response, { ok: true, version: "test" });
    if (request.method === "GET" && url.pathname === "/workspaces") {
      return send(response, { items: [{ id: "ws_1", path: process.cwd(), name: "test" }] });
    }
    if (request.method === "GET" && url.pathname === "/workspace/ws_1/sessions") {
      return send(response, { items: state.sessions });
    }
    if (request.method === "POST" && url.pathname === "/workspace/ws_1/sessions") {
      const item = { id: "ses_new", title: "New", time: { created: 3, updated: 3 } };
      state.sessions.unshift(item);
      return send(response, { item, started: false });
    }
    if (request.method === "POST" && url.pathname.endsWith("/runs/start")) {
      const body = await jsonBody(request);
      const prompt = body.prompt as { parts?: Array<{ text?: string }> } | undefined;
      state.prompts.push(prompt?.parts?.[0]?.text ?? "");
      state.started = true;
      return send(response, {
        disposition: "started",
        run: { workspaceId: "ws_1", sessionId: "ses_existing", runId: "run_1", generation: 1, status: "running" },
      }, 202);
    }
    if (request.method === "GET" && url.pathname.endsWith("/interactions/snapshot")) {
      const permissions = state.started && state.scenario === "permission" ? [{
        id: "perm_1",
        sessionID: "ses_existing",
        targetSessionId: "ses_existing",
        rootSessionId: "ses_existing",
        protocol: "v2",
        permission: "bash",
        patterns: ["rm protected"],
      }] : [];
      const questions = state.started && state.scenario === "question" ? [{
        id: "question_1",
        sessionID: "ses_existing",
        targetSessionId: "ses_existing",
        rootSessionId: "ses_existing",
        protocol: "v2",
        questions: [{ id: "q_1", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
      }] : [];
      return send(response, { item: { permissions, questions } });
    }
    if (request.method === "GET" && url.pathname.endsWith("/snapshot")) {
      const idle = state.scenario !== "abort" || state.aborted;
      return send(response, { item: {
        session: { id: "ses_existing" },
        todos: [],
        status: { type: idle ? "idle" : "busy" },
        messages: messages(state),
      } });
    }
    if (request.method === "POST" && url.pathname.endsWith("/observations")) {
      const body = await jsonBody(request);
      state.observations.push(String(body.status));
      return send(response, { cleared: body.status === "idle" });
    }
    if (request.method === "GET" && url.pathname === "/workspace/ws_1/session-runs") {
      return send(response, { items: state.started && !state.aborted ? [{
        workspaceId: "ws_1", sessionId: "ses_existing", runId: "run_1", generation: 1, status: "running",
      }] : [] });
    }
    if (request.method === "POST" && url.pathname.endsWith("/abort")) {
      state.aborted = true;
      return send(response, { accepted: true });
    }
    return send(response, { code: "not_found", message: `${request.method} ${request.url}` }, 404);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    state,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())),
  };
}

function spawnCli(serverUrl: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    "src/cli.ts",
    "--json",
    "--server", serverUrl,
    "--token", "test-token",
    "--workspace-id", "ws_1",
    ...args,
  ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

function collect(child: ChildProcessWithoutNullStreams): Promise<SpawnResult> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk) => out.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => err.push(Buffer.from(chunk)));
  return new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({
      code,
      signal,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

function records(result: SpawnResult): Array<Record<string, unknown>> {
  assert.equal(result.stderr, "");
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("one-shot command emits NDJSON and completes through the public API", async () => {
  const mock = await startMockServer();
  try {
    const resultPromise = collect(spawnCli(mock.url, ["say hello"]));
    const result = await resultPromise;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(records(result).find((record) => record.type === "final")?.text, "mock complete");
    assert.deepEqual(mock.state.prompts, ["say hello"]);
    assert.ok(mock.state.observations.includes("idle"));
  } finally {
    await mock.close();
  }
});

test("continue resumes the latest session and emits only follow-up text", async () => {
  const mock = await startMockServer();
  try {
    const result = await collect(spawnCli(mock.url, ["--continue", "follow up"]));
    assert.equal(result.code, 0, result.stderr);
    const output = records(result);
    assert.equal((output.find((record) => record.type === "session")?.session as { id: string }).id, "ses_existing");
    assert.equal(output.find((record) => record.type === "final")?.text, "mock complete");
    assert.ok(!result.stdout.includes("previous answer"));
    assert.deepEqual(mock.state.prompts, ["follow up"]);
  } finally {
    await mock.close();
  }
});

test("fast completion before a busy poll does not hang", async () => {
  const mock = await startMockServer("fast");
  try {
    const result = await collect(spawnCli(mock.url, ["finish immediately"]));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(records(result).find((record) => record.type === "final")?.text, "fast complete");
  } finally {
    await mock.close();
  }
});

test("SIGINT during an active run requests abort and returns 130", async () => {
  const mock = await startMockServer("abort");
  try {
    const child = spawnCli(mock.url, ["keep running"]);
    const resultPromise = collect(child);
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("run did not start")), 5_000);
      let signaled = false;
      child.stdout.on("data", (chunk) => {
        if (!signaled && String(chunk).includes('"type":"run_started"')) {
          signaled = true;
          clearTimeout(timeout);
          resolvePromise();
        }
      });
    });
    child.kill("SIGINT");
    const result = await resultPromise;
    assert.equal(result.code, 130, JSON.stringify({ result, state: mock.state }));
    assert.equal(mock.state.aborted, true);
    assert.ok(records(result).some((record) => record.type === "warning"));
  } finally {
    await mock.close();
  }
});

for (const scenario of ["permission", "question"] as const) {
  test(`non-interactive ${scenario} fails closed and aborts the run`, async () => {
    const mock = await startMockServer(scenario);
    try {
      const result = await collect(spawnCli(mock.url, ["needs input"]));
      assert.equal(result.code, 1, result.stderr);
      const error = records(result).find((record) => record.type === "error");
      assert.match(String(error?.message), scenario === "permission" ? /Permission required/ : /asked a question/);
      assert.equal(mock.state.aborted, true);
    } finally {
      await mock.close();
    }
  });
}

test("invalid health payload fails before workspace access", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    send(response, { ok: false, version: "test" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await collect(spawnCli(`http://127.0.0.1:${address.port}`, ["do work"]));
    assert.equal(result.code, 1);
    assert.match(String(records(result)[0]?.message), /health check/);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});

test("server failures redact reflected bearer and host token values", async () => {
  const server = createServer((_request, response) => {
    send(response, {
      code: "server_failure",
      message: "bearer test-token host host-secret rejected",
    }, 500);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const child = spawn(process.execPath, [
      "src/cli.ts", "--json", "--server", `http://127.0.0.1:${address.port}`,
      "--token", "test-token", "--host-token", "host-secret", "do work",
    ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const result = await collect(child);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /test-token|host-secret/);
    assert.match(String(records(result)[0]?.message), /\[REDACTED\]/);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});
