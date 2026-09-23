import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/args.js";
import {
  JuggleWorkApiError,
  type JuggleWorkApiClient,
  type OwnedInteraction,
  type SessionMessage,
  type SessionRun,
  type SessionSnapshot,
} from "../src/api.js";
import { chooseWorkspace, SessionController, STDIN_CONTEXT_END, STDIN_CONTEXT_START } from "../src/controller.js";
import type { CliRenderer } from "../src/render.js";

const run: SessionRun = {
  workspaceId: "ws_1",
  sessionId: "ses_1",
  runId: "run_1",
  generation: 1,
  status: "running",
};

function message(text: string, parts: SessionMessage["parts"] = []): SessionMessage {
  return {
    info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
    parts: [{ id: "part_1", type: "text", text }, ...parts],
  };
}

function snapshot(
  messages: SessionSnapshot["messages"],
  status: SessionSnapshot["status"] = { type: "idle" },
): { item: SessionSnapshot } {
  return { item: { session: { id: "ses_1" }, messages, todos: [], status } };
}

function createRenderer() {
  const output = { deltas: [] as string[], info: [] as string[], warnings: [] as string[], finals: [] as string[], tools: [] as string[] };
  const renderer = {
    event() {},
    info(value: string) { output.info.push(value); },
    warn(value: string) { output.warnings.push(value); },
    error() {},
    banner() {},
    session() {},
    sessions() {},
    sessionSnapshot() {},
    sessionMutation() {},
    sessionQueued() {},
    assistantStart() {},
    tool(name: string, status: string) { output.tools.push(`${name}:${status}`); },
    delta(value: string) { output.deltas.push(value); },
    final(value: string) { output.finals.push(value); },
    ensureLine() {},
    promptLabel() { return ""; },
  } as unknown as CliRenderer;
  return { renderer, output };
}

function baseApi(overrides: Record<string, unknown> = {}): JuggleWorkApiClient {
  return {
    createSession: async () => ({ item: { id: "ses_1", title: "test" }, started: false }),
    startRun: async () => ({ disposition: "started", run }),
    getInteractions: async () => ({ item: { permissions: [], questions: [] } }),
    listActiveRuns: async () => ({ items: [] }),
    observeRun: async () => ({ cleared: false, run, terminalStatus: null }),
    ...overrides,
  } as unknown as JuggleWorkApiClient;
}

test("workspace selection matches the requested path and refuses ambiguous connected Servers", async () => {
  const api = baseApi({ listWorkspaces: async () => ({ activeId: "ws_first", items: [
    { id: "ws_first", path: "/tmp/other" }, { id: "ws_requested", path: "/tmp/requested" },
  ] }) });
  const selected = await chooseWorkspace(api, parseCliArgs(["--workspace", "/tmp/requested"]), null);
  assert.equal(selected.id, "ws_requested");
  await assert.rejects(chooseWorkspace(api, parseCliArgs(["--workspace", "/tmp/unknown"]), null), /Pass --workspace-id/);
});

test("step-finish is progress metadata, not terminal evidence", async () => {
  const observations: string[] = [];
  let snapshots = 0;
  const api = baseApi({
    getSnapshot: async () => {
      snapshots += 1;
      if (snapshots === 1) return snapshot([]);
      if (snapshots === 2) return snapshot([message("working", [{ id: "step_1", type: "step-finish" }])], { type: "busy" });
      return snapshot([message("done", [{ id: "step_1", type: "step-finish" }])]);
    },
    observeRun: async (_workspaceId: string, _sessionId: string, _runId: string, status: string) => {
      observations.push(status);
      return { cleared: status === "idle", run: status === "idle" ? null : run, terminalStatus: status === "idle" ? "completed" : null };
    },
  });
  const { renderer, output } = createRenderer();
  const result = await new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null).runPrompt("do it");
  assert.equal(result.text, "done");
  assert.deepEqual(output.deltas, ["working", "\ndone"]);
  assert.deepEqual(observations, ["running", "idle"]);
});

test("streaming assistant growth emits only appended deltas", async () => {
  let snapshots = 0;
  const api = baseApi({
    getSnapshot: async () => {
      snapshots += 1;
      if (snapshots === 1) return snapshot([]);
      if (snapshots === 2) return snapshot([message("hel")], { type: "busy" });
      if (snapshots === 3) return snapshot([message("hello")], { type: "busy" });
      return snapshot([message("hello")]);
    },
    observeRun: async (_workspaceId: string, _sessionId: string, _runId: string, status: string) => ({
      cleared: status === "idle",
      run: status === "idle" ? null : run,
      terminalStatus: status === "idle" ? "completed" : null,
    }),
  });
  const { renderer, output } = createRenderer();
  const result = await new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null).runPrompt("do it");
  assert.equal(result.text, "hello");
  assert.deepEqual(output.deltas, ["hel", "lo"]);
});

test("tool progress is concise and emitted only when its status changes", async () => {
  let snapshots = 0;
  const toolMessage = (status: string): SessionMessage => ({
    info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" },
    parts: [{ id: "part_tool", type: "tool", tool: "read", state: { status, input: { filePath: "/private/path" } } }],
  });
  const api = baseApi({
    getSnapshot: async () => {
      snapshots += 1;
      if (snapshots === 1) return snapshot([]);
      if (snapshots <= 3) return snapshot([toolMessage("running")], { type: "busy" });
      return snapshot([toolMessage("completed")]);
    },
    observeRun: async (_workspaceId: string, _sessionId: string, _runId: string, status: string) => ({
      cleared: status === "idle", run: status === "idle" ? null : run, terminalStatus: status === "idle" ? "completed" : null,
    }),
  });
  const { renderer, output } = createRenderer();
  await new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null).runPrompt("read a file");
  assert.deepEqual(output.tools, ["read:running", "read:completed"]);
  assert.deepEqual(output.deltas, []);
});

test("fast completion uses idle reconciliation when active state was never observed", async () => {
  const observations: string[] = [];
  let snapshots = 0;
  let activeReads = 0;
  const api = baseApi({
    getSnapshot: async () => snapshots++ === 0
      ? snapshot([])
      : snapshot([message("done", [{ id: "finish_1", type: "finish" }])]),
    observeRun: async (_workspaceId: string, _sessionId: string, _runId: string, status: string) => {
      observations.push(status);
      return { cleared: false, run, terminalStatus: null };
    },
    listActiveRuns: async () => ({ items: activeReads++ === 0 ? [] : [run] }),
  });
  const { renderer } = createRenderer();
  const result = await new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null).runPrompt("do it");
  assert.equal(result.text, "done");
  assert.deepEqual(observations, ["idle"]);
  assert.equal(activeReads, 1);
});

test("waiting state is observed and reported once while unchanged", async () => {
  const observations: string[] = [];
  let snapshots = 0;
  const api = baseApi({
    getSnapshot: async () => {
      snapshots += 1;
      if (snapshots === 1) return snapshot([]);
      if (snapshots <= 3) return snapshot([message("need input")], { type: "waiting" });
      return snapshot([message("done")]);
    },
    observeRun: async (_workspaceId: string, _sessionId: string, _runId: string, status: string) => {
      observations.push(status);
      return { cleared: status === "idle", run: status === "idle" ? null : run, terminalStatus: status === "idle" ? "completed" : null };
    },
  });
  const { renderer, output } = createRenderer();
  await new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null).runPrompt("do it");
  assert.deepEqual(observations, ["waiting", "waiting", "idle"]);
  assert.equal(output.info.filter((value) => value === "Waiting for input.").length, 1);
});

test("steering preserves growth from assistant parts present in the baseline", async () => {
  let snapshots = 0;
  let activeReads = 0;
  const api = baseApi({
    getSnapshot: async () => {
      snapshots += 1;
      if (snapshots === 1) return snapshot([message("existing")]);
      if (snapshots === 2) return snapshot([message("existing plus")], { type: "busy" });
      return snapshot([message("existing plus more")]);
    },
    startRun: async () => ({ disposition: "steered", admissionId: "admission_1" }),
    listActiveRuns: async () => {
      activeReads += 1;
      return { items: [run] };
    },
    observeRun: async (_workspaceId: string, _sessionId: string, _runId: string, status: string) => ({
      cleared: status === "idle",
      run: status === "idle" ? null : run,
      terminalStatus: status === "idle" ? "completed" : null,
    }),
  });
  const { renderer, output } = createRenderer();
  const controller = new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null);
  await controller.useSession({ id: "ses_1" });
  const result = await controller.runPrompt("steer it");
  assert.equal(result.text, " plus more");
  assert.deepEqual(output.deltas, [" plus", " more"]);
  assert.equal(activeReads, 1);
});

test("steered tool updates from an existing assistant message remain visible", async () => {
  let snapshots = 0;
  const toolMessage = (status: string): SessionMessage => ({
    info: { id: "msg_existing", sessionID: "ses_1", role: "assistant" },
    parts: [{ id: "tool_existing", type: "tool", tool: "bash", state: { status } }],
  });
  const api = baseApi({
    getSnapshot: async () => snapshot([toolMessage(++snapshots === 1 ? "running" : "completed")], snapshots === 1 ? { type: "busy" } : { type: "idle" }),
    observeRun: async () => ({ cleared: true, run: null, terminalStatus: "completed" }),
  });
  const { renderer, output } = createRenderer();
  const controller = new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null);
  await controller.useSession({ id: "ses_1" });
  await controller.runPrompt("follow up");
  assert.deepEqual(output.tools, ["bash:completed"]);
});

test("start admission is bounded by the configured run timeout", async () => {
  let admissionTimeout = 0;
  let snapshots = 0;
  const api = baseApi({
    getSnapshot: async () => snapshots++ === 0 ? snapshot([]) : snapshot([]),
    startRun: async (_workspaceId: string, _sessionId: string, _input: unknown, timeoutMs: number) => {
      admissionTimeout = timeoutMs;
      return { disposition: "started", run };
    },
    observeRun: async () => ({ cleared: true, run: null, terminalStatus: "completed" }),
  });
  const { renderer } = createRenderer();
  await new SessionController(api, { id: "ws_1" }, parseCliArgs(["--timeout", "1"]), renderer, null).runPrompt("do it");
  assert.ok(admissionTimeout > 0 && admissionTimeout <= 1_000);
});

test("piped exec context is a separately delimited part and output schema reaches the run request", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  let snapshots = 0;
  const api = baseApi({
    getSnapshot: async () => snapshots++ === 0 ? snapshot([]) : snapshot([message('{"answer":"done"}')]),
    startRun: async (_workspaceId: string, _sessionId: string, input: Record<string, unknown>) => {
      submitted.push(input);
      return { disposition: "started", run };
    },
    observeRun: async () => ({ cleared: true, run: null, terminalStatus: "completed" }),
  });
  const { renderer } = createRenderer();
  await new SessionController(api, { id: "ws_1" }, parseCliArgs(["exec", "summarize"]), renderer, null).runPrompt("summarize", {
    context: "raw piped input",
    outputSchema: { type: "object", required: ["answer"] },
  });
  const prompt = submitted[0]?.prompt as { parts: Array<{ text: string }>; format: unknown };
  assert.equal(prompt.parts[0]?.text, "summarize");
  assert.equal(prompt.parts[1]?.text, `\n${STDIN_CONTEXT_START}\nraw piped input\n${STDIN_CONTEXT_END}`);
  assert.deepEqual(prompt.format, {
    type: "json_schema",
    schema: { type: "object", required: ["answer"] },
  });
});

test("session deletion requires the exact interactive confirmation and force rejects prefixes", async () => {
  const deleted: string[] = [];
  const api = baseApi({
    listSessions: async () => ({ items: [{ id: "ses_exact", title: "Exact" }] }),
    deleteSession: async (_workspaceId: string, sessionId: string) => { deleted.push(sessionId); return { ok: true }; },
  });
  const { renderer } = createRenderer();
  const rejected = new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, async () => "no");
  await assert.rejects(() => rejected.deleteSession("ses_exact", false), /was not confirmed/);
  assert.deepEqual(deleted, []);

  const confirmed = new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, async () => "ses_exact");
  await confirmed.deleteSession("ses_exact", false);
  assert.deepEqual(deleted, ["ses_exact"]);
  await assert.rejects(() => confirmed.deleteSession("ses_", true), /complete, exact session ID/);
  assert.deepEqual(deleted, ["ses_exact"]);
});

test("abort run_mismatch race remains a natural completion", async () => {
  let releaseInteractions!: () => void;
  let pollingStarted!: () => void;
  const waiting = new Promise<void>((resolve) => { pollingStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseInteractions = resolve; });
  let snapshots = 0;
  const api = baseApi({
    getSnapshot: async () => snapshots++ === 0 ? snapshot([]) : snapshot([message("completed")]),
    getInteractions: async () => {
      pollingStarted();
      await gate;
      return { item: { permissions: [], questions: [] } };
    },
    abortRun: async () => { throw new JuggleWorkApiError("mismatch", 409, "run_mismatch"); },
    observeRun: async () => { throw new JuggleWorkApiError("mismatch", 409, "run_mismatch"); },
  });
  const { renderer, output } = createRenderer();
  const controller = new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null);
  const prompt = controller.runPrompt("do it");
  await waiting;
  assert.equal(await controller.abortCurrentRun(), false);
  releaseInteractions();
  const result = await prompt;
  assert.equal(result.aborted, false);
  assert.deepEqual(output.warnings, []);
});

test("V2 flat and nested save scopes offer reusable session grants with useful summaries", async () => {
  const interactions: OwnedInteraction[] = [
    {
      id: "perm_flat",
      sessionID: "ses_1",
      protocol: "v2",
      targetSessionId: "ses_1",
      rootSessionId: "ses_1",
      action: "file.edit",
      resources: ["/repo/a.ts"],
      save: ["/repo/**"],
    },
    {
      id: "perm_nested",
      sessionID: "ses_1",
      protocol: "v2",
      targetSessionId: "ses_1",
      rootSessionId: "ses_1",
      v2: { action: "shell.run", resources: ["pnpm test"], save: ["pnpm *"] },
    },
  ];
  const grants: string[] = [];
  let interactionReads = 0;
  let snapshots = 0;
  const api = baseApi({
    getSnapshot: async () => snapshots++ === 0 ? snapshot([]) : snapshot([message("done")]),
    getInteractions: async () => ({ item: { permissions: interactionReads++ === 0 ? interactions : [], questions: [] } }),
    grantPermission: async (_workspaceId: string, interaction: OwnedInteraction) => { grants.push(interaction.id); return {}; },
    observeRun: async () => ({ cleared: true, run: null, terminalStatus: "completed" }),
  });
  const { renderer, output } = createRenderer();
  await new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, async () => "s").runPrompt("do it");
  assert.deepEqual(grants, ["perm_flat", "perm_nested"]);
  assert.ok(output.info.some((value) => value.includes("file.edit: /repo/a.ts (session scope: /repo/**)")));
  assert.ok(output.info.some((value) => value.includes("shell.run: pnpm test (session scope: pnpm *)")));
});

test("non-interactive permission request aborts instead of auto-approving", async () => {
  let aborted = false;
  const interaction = {
    id: "perm_1",
    sessionID: "ses_1",
    protocol: "v2",
    targetSessionId: "ses_1",
    rootSessionId: "ses_1",
    action: "external_directory",
    resources: ["/Applications/*"],
  } as OwnedInteraction;
  const api = baseApi({
    getSnapshot: async () => snapshot([]),
    getInteractions: async () => ({ item: { permissions: [interaction], questions: [] } }),
    abortRun: async () => { aborted = true; return { run: { ...run, status: "aborting" }, abortRequested: true }; },
  });
  const { renderer } = createRenderer();
  await assert.rejects(
    new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null).runPrompt("do it"),
    /Permission required \(external_directory: \/Applications\/\*\)/,
  );
  assert.equal(aborted, true);
});

test("approval never fails closed even when an interactive prompt function exists", async () => {
  let asked = false;
  let aborted = false;
  const interaction = {
    id: "perm_never",
    sessionID: "ses_1",
    protocol: "v2",
    targetSessionId: "ses_1",
    rootSessionId: "ses_1",
    action: "shell.run",
    resources: ["rm protected"],
  } as OwnedInteraction;
  const api = baseApi({
    getSnapshot: async () => snapshot([]),
    getInteractions: async () => ({ item: { permissions: [interaction], questions: [] } }),
    abortRun: async () => { aborted = true; return { accepted: true }; },
  });
  const { renderer } = createRenderer();
  await assert.rejects(
    new SessionController(api, { id: "ws_1" }, parseCliArgs(["--approval", "never"]), renderer, async () => {
      asked = true;
      return "o";
    }).runPrompt("do it"),
    /configured approval policy is fail-closed/,
  );
  assert.equal(asked, false);
  assert.equal(aborted, true);
});

test("non-interactive question fails closed and aborts without replying", async () => {
  let aborted = false;
  let replied = false;
  const interaction = {
    id: "question_1",
    sessionID: "ses_1",
    protocol: "v2",
    targetSessionId: "ses_1",
    rootSessionId: "ses_1",
    questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
  } as OwnedInteraction;
  const api = baseApi({
    getSnapshot: async () => snapshot([]),
    getInteractions: async () => ({ item: { permissions: [], questions: [interaction] } }),
    abortRun: async () => { aborted = true; return { run: { ...run, status: "aborting" }, abortRequested: true }; },
    replyQuestion: async () => { replied = true; return {}; },
  });
  const { renderer } = createRenderer();
  await assert.rejects(
    new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null).runPrompt("do it"),
    /task asked a question/,
  );
  assert.equal(aborted, true);
  assert.equal(replied, false);
});

test("interactive question uses renderer presentation and replies with the selected option", async () => {
  let reply: unknown = null;
  let interactionReads = 0;
  let snapshots = 0;
  const interaction = {
    id: "question_1",
    sessionID: "ses_1",
    protocol: "v2",
    targetSessionId: "ses_1",
    rootSessionId: "ses_1",
    questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
  } as OwnedInteraction;
  const api = baseApi({
    getSnapshot: async () => snapshots++ === 0 ? snapshot([]) : snapshot([message("continued")]),
    getInteractions: async () => ({ item: { permissions: [], questions: interactionReads++ === 0 ? [interaction] : [] } }),
    replyQuestion: async (_workspaceId: string, _interaction: OwnedInteraction, answers: unknown) => { reply = answers; return {}; },
    observeRun: async () => ({ cleared: true, run: null, terminalStatus: "completed" }),
  });
  const { renderer, output } = createRenderer();
  const result = await new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, async () => "1").runPrompt("do it");
  assert.equal(result.text, "continued");
  assert.deepEqual(reply, [{ questionId: "q1", values: ["Yes"] }]);
  assert.deepEqual(output.info.slice(0, 3), ["Continue?", "  1. Yes", "  2. No"]);
});

test("resumes an exact recent session", async () => {
  const api = baseApi({
    listSessions: async () => ({ items: [
      { id: "ses_old", title: "old", time: { updated: 1 } },
      { id: "ses_new", title: "new", time: { updated: 2 } },
    ] }),
  });
  const { renderer } = createRenderer();
  const controller = new SessionController(api, { id: "ws_1" }, parseCliArgs([]), renderer, null);
  const session = await controller.selectSession("ses_old", false);
  assert.equal(session.id, "ses_old");
  assert.equal(controller.currentSession?.id, "ses_old");
});
