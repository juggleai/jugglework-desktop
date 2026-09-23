import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

type Scenario = "complete" | "fast" | "abort" | "permission" | "question";
type MockState = {
  scenario: Scenario;
  started: boolean;
  aborted: boolean;
  observations: string[];
  prompts: string[];
  promptBodies: Array<Record<string, unknown>>;
  workspaceMutations: string[];
  sessions: Array<{ id: string; title: string; time: { created: number; updated: number } }>;
  queued: string[];
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
    promptBodies: [],
    workspaceMutations: [],
    sessions: [{ id: "ses_existing", title: "Existing", time: { created: 1, updated: 2 } }],
    queued: [],
  };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    const url = new URL(request.url ?? "/", "http://mock");
    if (request.method === "GET" && url.pathname === "/health") return send(response, { ok: true, version: "test" });
    if (request.method === "GET" && url.pathname === "/workspaces") {
      return send(response, { activeId: "ws_1", items: [{ id: "ws_1", path: process.cwd(), name: "test" }] });
    }
    if (request.method === "POST" && url.pathname === "/workspaces/local") {
      const body = await jsonBody(request);
      state.workspaceMutations.push(`add:${String(body.folderPath)}`);
      return send(response, { activeId: "ws_added", workspaces: [], persisted: true }, 201);
    }
    if (request.method === "POST" && url.pathname === "/workspaces/ws_1/activate") {
      state.workspaceMutations.push(`open:${url.searchParams.get("persist")}`);
      return send(response, { activeId: "ws_1", workspace: { id: "ws_1", name: "test" }, persisted: true });
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
      state.promptBodies.push(prompt ?? {});
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
    if (request.method === "POST" && url.pathname === "/workspace/ws_1/sessions/ses_existing/fork") {
      const item = { id: "ses_forked", title: "Existing (fork)", time: { created: 3, updated: 3 } };
      state.sessions.unshift(item);
      return send(response, { item }, 201);
    }
    if (request.method === "POST" && url.pathname === "/workspace/ws_1/sessions/ses_existing/queue") {
      const body = await jsonBody(request);
      state.queued.push(String(body.prompt));
      return send(response, { disposition: "enqueued", admissionId: body.id }, 202);
    }
    if (request.method === "PATCH" && url.pathname === "/workspace/ws_1/sessions/ses_existing") {
      const body = await jsonBody(request);
      const session = state.sessions.find((item) => item.id === "ses_existing")!;
      if (typeof body.title === "string") session.title = body.title;
      if (body.archived === true) Object.assign(session.time, { archived: Date.now() });
      if (body.archived === false) delete (session.time as { archived?: number }).archived;
      return send(response, { item: session });
    }
    if (request.method === "DELETE" && url.pathname === "/workspace/ws_1/sessions/ses_existing") {
      state.sessions = state.sessions.filter((item) => item.id !== "ses_existing");
      return send(response, { ok: true });
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

function spawnExec(serverUrl: string, args: string[], input = ""): Promise<SpawnResult> {
  const child = spawn(process.execPath, [
    "src/cli.ts",
    "--server", serverUrl,
    "--token", "test-token",
    "--workspace-id", "ws_1",
    ...args,
  ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const result = collect(child);
  child.stdin.end(input);
  return result;
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

test("workspace list and open use the existing Server registry APIs", async () => {
  const mock = await startMockServer();
  try {
    const listed = await collect(spawnCli(mock.url, ["workspace", "list"]));
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual((records(listed)[0]?.items as Array<{ id: string }>).map((item) => item.id), ["ws_1"]);
    const opened = await collect(spawnCli(mock.url, ["workspace", "open", "ws_1"]));
    assert.equal(opened.code, 0, opened.stderr);
    assert.deepEqual(mock.state.workspaceMutations, ["open:true"]);
  } finally {
    await mock.close();
  }
});

test("plain exec keeps only the final response on stdout and sends progress to stderr", async () => {
  const mock = await startMockServer();
  try {
    const result = await spawnExec(mock.url, ["exec", "summarize"], "piped source\n");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "mock complete\n");
    assert.match(result.stderr, /JuggleWork/);
    assert.match(result.stderr, /session/);
    assert.doesNotMatch(result.stderr, /mock complete/);
    const parts = (mock.state.promptBodies[0]?.parts ?? []) as Array<{ type: string; text: string }>;
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[0], { type: "text", text: "summarize" });
    assert.match(parts[1]?.text ?? "", /BEGIN PIPED STDIN CONTEXT[\s\S]*piped source[\s\S]*END PIPED STDIN CONTEXT/);
  } finally {
    await mock.close();
  }
});

test("exec without a positional prompt reads stdin as the prompt", async () => {
  const mock = await startMockServer();
  try {
    const result = await spawnExec(mock.url, ["exec"], "stdin instruction\n");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "mock complete\n");
    const parts = (mock.state.promptBodies[0]?.parts ?? []) as Array<{ text: string }>;
    assert.deepEqual(parts, [{ type: "text", text: "stdin instruction" }]);
  } finally {
    await mock.close();
  }
});

test("JSON exec stays NDJSON-only and writes the final message while forwarding output schema", async () => {
  const mock = await startMockServer();
  const root = await mkdtemp(join(tmpdir(), "jugglework-exec-output-"));
  const schemaPath = join(root, "schema.json");
  const outputPath = join(root, "last.txt");
  try {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
    await writeFile(schemaPath, JSON.stringify(schema));
    const result = await spawnExec(mock.url, [
      "exec", "structured answer", "--json",
      "--output-schema", schemaPath,
      "--output-last-message", outputPath,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = records(result);
    assert.equal(output.find((record) => record.type === "final")?.text, "mock complete");
    assert.equal(await readFile(outputPath, "utf8"), "mock complete");
    assert.deepEqual(mock.state.promptBodies[0]?.format, { type: "json_schema", schema });
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("exec rejects invalid output schema before starting a run", async () => {
  const mock = await startMockServer();
  const root = await mkdtemp(join(tmpdir(), "jugglework-exec-schema-"));
  const schemaPath = join(root, "schema.json");
  try {
    await writeFile(schemaPath, "[]");
    const result = await spawnExec(mock.url, ["exec", "structured answer", "--output-schema", schemaPath]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /must contain a JSON object/);
    assert.equal(mock.state.promptBodies.length, 0);
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
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

test("grouped session commands complete the persisted lifecycle", async () => {
  const mock = await startMockServer();
  try {
    const list = await collect(spawnCli(mock.url, ["session", "list"]));
    assert.equal(list.code, 0, list.stderr);
    assert.equal((records(list).find((record) => record.type === "sessions")?.items as unknown[]).length, 1);

    const show = await collect(spawnCli(mock.url, ["session", "show", "ses_existing"]));
    assert.equal(show.code, 0, show.stderr);
    assert.equal((records(show).find((record) => record.type === "session_snapshot")?.snapshot as { session: { id: string } }).session.id, "ses_existing");

    const resume = await collect(spawnCli(mock.url, ["session", "resume", "ses_existing"]));
    assert.equal(resume.code, 1, resume.stderr);
    assert.equal((records(resume).find((record) => record.type === "session")?.session as { id: string }).id, "ses_existing");
    assert.match(String(records(resume).find((record) => record.type === "error")?.message), /No prompt was provided/);

    const fork = await collect(spawnCli(mock.url, ["fork", "ses_existing"]));
    assert.equal(fork.code, 0, fork.stderr);
    assert.equal((records(fork).find((record) => record.type === "session_mutation")?.session as { id: string }).id, "ses_forked");

    const queue = await collect(spawnCli(mock.url, ["session", "queue", "ses_existing", "next", "task"]));
    assert.equal(queue.code, 0, queue.stderr);
    assert.deepEqual(mock.state.queued, ["next task"]);

    const rename = await collect(spawnCli(mock.url, ["session", "rename", "ses_existing", "Renamed session"]));
    assert.equal(rename.code, 0, rename.stderr);
    assert.equal(mock.state.sessions.find((item) => item.id === "ses_existing")?.title, "Renamed session");

    for (const action of ["archive", "unarchive"] as const) {
      const result = await collect(spawnCli(mock.url, ["session", action, "ses_existing"]));
      assert.equal(result.code, 0, result.stderr);
    }

    const unconfirmed = await collect(spawnCli(mock.url, ["session", "delete", "ses_existing"]));
    assert.equal(unconfirmed.code, 1);
    assert.match((records(unconfirmed).find((record) => record.type === "error")?.message as string), /requires interactive confirmation/);
    assert.ok(mock.state.sessions.some((item) => item.id === "ses_existing"));

    const forced = await collect(spawnCli(mock.url, ["session", "delete", "ses_existing", "--force"]));
    assert.equal(forced.code, 0, forced.stderr);
    assert.ok(!mock.state.sessions.some((item) => item.id === "ses_existing"));
  } finally {
    await mock.close();
  }
});

test("forced session deletion refuses prefixes even when uniquely resolvable", async () => {
  const mock = await startMockServer();
  try {
    const result = await collect(spawnCli(mock.url, ["session", "delete", "ses_exist", "--force"]));
    assert.equal(result.code, 1);
    assert.match((records(result).find((record) => record.type === "error")?.message as string), /complete, exact session ID/);
    assert.ok(mock.state.sessions.some((item) => item.id === "ses_existing"));
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
