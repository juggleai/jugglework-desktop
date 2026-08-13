import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalAgentMessage, CanonicalAgentSession, CanonicalSessionSnapshot } from "@jugglework/types/agent-runtime";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition } from "@jugglework/types/automation";
import { openRuntimeSqliteDatabase } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { AutomationExecutor, type AutomationAgentRuntime } from "./executor.js";
import { AutomationRepository } from "./repository.js";
import { automationSqliteAdapter } from "./sqlite.js";

test("executor creates an auditable canonical session and completes only after idle", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-1", 100);
  const createInputs: Array<Record<string, unknown>> = [];
  const promptInputs: Array<Record<string, unknown>> = [];
  let activityReads = 0;
  const runtime = runtimeFixture({
    createSession: async (input) => {
      createInputs.push(input);
      return session("session-1");
    },
    startRun: async (input) => { promptInputs.push(input.prompt); },
    activity: async () => activityReads++ === 0 ? "busy" : "idle",
    snapshot: async () => snapshot("session-1", [assistantMessage("session-1")]),
  });
  try {
    const executor = executorFixture(fixture.repository, runtime);
    await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
    const completed = fixture.repository.getRun(run.id)!;
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.sessionId, "session-1");
    assert.deepEqual(completed.concreteModel, { providerId: "provider", modelId: "model" });
    assert.deepEqual(createInputs[0].configuration, {});
    assert.match(String(promptInputs[0].system), /不得询问用户/);
    assert.equal((promptInputs[0].metadata as Record<string, unknown>).automationRunId, run.id);
    assert.deepEqual(promptInputs[0].tools, { github_search: false, github_create_issue: false });
  } finally {
    await fixture.close();
  }
});

test("executor exposes tools only for selected connected MCP servers", async () => {
  const fixture = await repositoryFixture();
  const definition = {
    ...automationDefinition(),
    connectors: [{ id: "github", source: "local-mcp" as const, label: "GitHub" }],
  };
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-connectors", 100);
  const promptInputs: Array<Record<string, unknown>> = [];
  const runtime = runtimeFixture({
    startRun: async (input) => { promptInputs.push(input.prompt); },
    listTools: async () => [
      { id: "read", source: null, available: true },
      { id: "github_search", source: "github", available: true },
      { id: "linear_create_issue", source: "linear", available: true },
    ],
  });
  try {
    await executorFixture(fixture.repository, runtime).execute(fixture.repository.getRunSnapshot(run.id)!);
    assert.equal(fixture.repository.getRun(run.id)?.state, "succeeded");
    assert.deepEqual(promptInputs[0].tools, { github_search: true, linear_create_issue: false });
  } finally {
    await fixture.close();
  }
});

test("executor fails closed when a cloud connector has no task-scoped credential", async () => {
  const fixture = await repositoryFixture();
  const definition = {
    ...automationDefinition(),
    connectors: [{ id: "cloud-github", source: "cloud" as const, label: "Cloud GitHub" }],
  };
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-cloud", 100);
  let prompts = 0;
  const runtime = runtimeFixture({ startRun: async () => { prompts += 1; } });
  try {
    await executorFixture(fixture.repository, runtime).execute(fixture.repository.getRunSnapshot(run.id)!);
    assert.equal(fixture.repository.getRun(run.id)?.errorCode, "connector_scope_unavailable");
    assert.equal(prompts, 0);
  } finally {
    await fixture.close();
  }
});

test("preflight failure retains the created audit session and does not dispatch", async () => {
  const fixture = await repositoryFixture();
  const definition = { ...automationDefinition(), prompt: { version: 1 as const, parts: [{ type: "file" as const, relativePath: "missing.txt" }] } };
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-2", 100);
  let prompts = 0;
  const runtime = runtimeFixture({
    createSession: async () => session("session-audit"),
    startRun: async () => { prompts += 1; },
  });
  try {
    await executorFixture(fixture.repository, runtime).execute(fixture.repository.getRunSnapshot(run.id)!);
    const failed = fixture.repository.getRun(run.id)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "file_unavailable");
    assert.equal(failed.sessionId, "session-audit");
    assert.equal(prompts, 0);
  } finally {
    await fixture.close();
  }
});

test("executor consumes a canonical session error and sanitizes its failure", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-session-error", 100);
  const runtime = runtimeFixture({
    createSession: async () => session("session-error"),
    snapshot: async () => snapshot("session-error", [assistantMessage("session-error", {
      parts: [{
        id: "part-error",
        messageId: "message-assistant",
        sessionId: "session-error",
        ordinal: 0,
        createdAt: 1,
        updatedAt: 1,
        type: "error",
        code: "provider_failed",
        message: "token=private-value provider failed",
        retryable: false,
      }],
    })]),
  });
  try {
    await executorFixture(fixture.repository, runtime).execute(fixture.repository.getRunSnapshot(run.id)!);
    const failed = fixture.repository.getRun(run.id)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "execution_failed");
    assert.doesNotMatch(failed.errorMessage ?? "", /private-value/);
  } finally {
    await fixture.close();
  }
});

test("restart reconciliation completes an idle session without redispatch", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  fixture.repository.createDefinition(definition, definition);
  const queued = fixture.repository.createManualRun(definition, "run-reconcile", 100);
  const running = fixture.repository.updateRun(queued.id, queued.revision, {
    state: "running", sessionId: "session-existing", startedAt: 101,
  }, 101);
  let prompts = 0;
  const runtime = runtimeFixture({
    readSession: async () => session("session-existing"),
    snapshot: async () => snapshot("session-existing", [assistantMessage("session-existing")]),
    startRun: async () => { prompts += 1; },
  });
  try {
    const executor = executorFixture(fixture.repository, runtime);
    await executor.reconcile({ run: running, definition });
    const completed = fixture.repository.getRun(running.id)!;
    assert.equal(completed.state, "succeeded");
    await executor.reconcile({ run: running, definition });
    assert.equal(fixture.repository.getRun(running.id)?.revision, completed.revision);
    assert.equal(prompts, 0);
  } finally {
    await fixture.close();
  }
});

test("restart reconciliation fails a missing session with session_lost", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  fixture.repository.createDefinition(definition, definition);
  const queued = fixture.repository.createManualRun(definition, "run-missing-session", 100);
  const running = fixture.repository.updateRun(queued.id, queued.revision, {
    state: "running", sessionId: "session-missing", startedAt: 101,
  }, 101);
  const runtime = runtimeFixture({ readSession: async () => { throw new Error("not found"); } });
  try {
    await executorFixture(fixture.repository, runtime).reconcile({ run: running, definition });
    assert.equal(fixture.repository.getRun(running.id)?.errorCode, "session_lost");
  } finally {
    await fixture.close();
  }
});

test("executor reports stable model, agent, and skill dependency failures", async () => {
  const cases: Array<{
    id: string;
    patch: Partial<AutomationDefinition>;
    expected: "model_unavailable" | "agent_unavailable" | "skill_unavailable";
  }> = [
    { id: "model", patch: { model: { mode: "explicit", providerId: "missing", modelId: "missing" } }, expected: "model_unavailable" },
    { id: "agent", patch: { agentId: "missing-agent" }, expected: "agent_unavailable" },
    { id: "skill", patch: { skillIds: ["missing-skill"] }, expected: "skill_unavailable" },
  ];
  for (const item of cases) {
    const fixture = await repositoryFixture();
    const definition = { ...automationDefinition(), id: `task-${item.id}`, ...item.patch };
    fixture.repository.createDefinition(definition, definition);
    const run = fixture.repository.createManualRun(definition, `run-${item.id}`, 100);
    let prompts = 0;
    const runtime = runtimeFixture({ startRun: async () => { prompts += 1; } });
    try {
      await executorFixture(fixture.repository, runtime).execute(fixture.repository.getRunSnapshot(run.id)!);
      assert.equal(fixture.repository.getRun(run.id)?.errorCode, item.expected);
      assert.equal(prompts, 0);
    } finally {
      await fixture.close();
    }
  }
});

function runtimeFixture(overrides: Partial<AutomationAgentRuntime> = {}): AutomationAgentRuntime {
  return {
    createSession: async () => session("session-default"),
    startRun: async () => undefined,
    readSession: async (_workspaceId, sessionId) => session(sessionId),
    snapshot: async (_workspaceId, sessionId) => snapshot(sessionId, []),
    activity: async () => "idle",
    listModels: async () => [],
    listAgentProfiles: async () => [],
    listSkills: async () => [],
    listTools: async () => [
      { id: "read", source: null, available: true },
      { id: "github_search", source: "github", available: true },
      { id: "github_create_issue", source: "github", available: true },
    ],
    ...overrides,
  };
}

function executorFixture(repository: AutomationRepository, runtime: AutomationAgentRuntime): AutomationExecutor {
  return new AutomationExecutor({
    config: serverConfig(),
    repository,
    resolveWorkspace: async () => serverConfig().workspaces[0],
    runtime,
    now: (() => { let now = 100; return () => ++now; })(),
    wait: async () => undefined,
  });
}

function session(id: string): CanonicalAgentSession {
  return {
    id,
    workspaceId: "workspace",
    runtimeId: "jugglework",
    backendSessionId: id,
    title: "Automation",
    canonicalCwd: "/tmp/workspace",
    status: { type: "idle" },
    configuration: {},
    createdAt: 1,
    updatedAt: 1,
    lastError: null,
  };
}

function assistantMessage(sessionId: string, patch: Partial<CanonicalAgentMessage> = {}): CanonicalAgentMessage {
  return {
    id: "message-assistant",
    sessionId,
    role: "assistant",
    parentId: null,
    createdAt: 1,
    completedAt: 2,
    parts: [],
    metadata: { providerId: "provider", modelId: "model", agent: "build" },
    ...patch,
  };
}

function snapshot(sessionId: string, messages: CanonicalAgentMessage[]): CanonicalSessionSnapshot {
  return { schemaVersion: 1, session: session(sessionId), messages, todos: [], interactions: [], latestSequence: 0 };
}

function automationDefinition(): AutomationDefinition {
  return {
    schema: "automation-definition/v1",
    id: "task",
    name: "Task",
    workspace: { id: "workspace", name: "Workspace", path: "/tmp/workspace", workspaceType: "local" },
    prompt: { version: 1, parts: [{ type: "text", text: "run" }] },
    schedule: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "UTC" },
    model: { mode: "auto" },
    skillIds: [],
    connectors: [],
    permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: 1 },
    lifecycle: "enabled",
    executorDeviceId: "device",
    revision: 1,
    nextRunAt: 1_000,
    createdAt: 1,
    updatedAt: 1,
  };
}

function serverConfig(): ServerConfig {
  return {
    host: "127.0.0.1", port: 0, token: "token", hostToken: "host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "workspace", name: "Workspace", path: "/tmp/workspace", preset: "default", workspaceType: "local" }], authorizedRoots: ["/tmp/workspace"],
    readOnly: false, startedAt: 1, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-executor-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const repository = AutomationRepository.fromDatabase(automationSqliteAdapter(runtime));
  return { repository, close: async () => { repository.close(); await rm(root, { recursive: true, force: true }); } };
}
