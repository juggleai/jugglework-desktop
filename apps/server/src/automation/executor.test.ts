import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition } from "@jugglework/types/automation";
import { openRuntimeSqliteDatabase } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { AutomationExecutor } from "./executor.js";
import { AutomationRepository } from "./repository.js";
import { automationSqliteAdapter } from "./sqlite.js";

test("executor creates an auditable full-access session and completes only after idle", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-1", 100);
  const createInputs: Array<Record<string, unknown>> = [];
  const promptInputs: Array<Record<string, unknown>> = [];
  let statusReads = 0;
  const opencode = {
    session: {
      create: async (input: Record<string, unknown>) => { createInputs.push(input); return { data: { id: "session-1" } }; },
      promptAsync: async (input: Record<string, unknown>) => { promptInputs.push(input); return { data: true, error: undefined }; },
      status: async () => ({ data: { "session-1": statusReads++ === 0 ? { type: "busy" } : { type: "idle" } } }),
      messages: async () => ({ data: [{ info: { role: "assistant", providerID: "provider", modelID: "model", agent: "build" }, parts: [] }] }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: { github: { status: "connected" } } }) },
    tool: { ids: async () => ({ data: ["read", "github_search", "github_create_issue"] }) },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(),
      repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: (() => { let now = 100; return () => ++now; })(),
      wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
    const completed = fixture.repository.getRun(run.id)!;
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.sessionId, "session-1");
    assert.deepEqual(completed.concreteModel, { providerId: "provider", modelId: "model" });
    assert.equal((createInputs[0].metadata as Record<string, unknown>).automationRunId, run.id);
    assert.deepEqual(createInputs[0].permission, [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "deny" },
    ]);
    assert.match(String(promptInputs[0].system), /不得询问用户/);
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
  const opencode = {
    session: {
      create: async () => ({ data: { id: "session-connectors" } }),
      promptAsync: async (input: Record<string, unknown>) => { promptInputs.push(input); return { data: true, error: undefined }; },
      status: async () => ({ data: { "session-connectors": { type: "idle" } } }),
      messages: async () => ({ data: [] }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: { github: { status: "connected" }, linear: { status: "connected" } } }) },
    tool: { ids: async () => ({ data: ["read", "github_search", "linear_create_issue"] }) },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: (() => { let now = 100; return () => ++now; })(), wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
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
  const opencode = {
    session: {
      create: async () => ({ data: { id: "session-cloud" } }),
      promptAsync: async () => { prompts += 1; return { data: true, error: undefined }; },
    },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: () => 200, wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
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
  const opencode = {
    session: {
      create: async () => ({ data: { id: "session-audit" } }),
      promptAsync: async () => { prompts += 1; return { data: true, error: undefined }; },
    },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(),
      repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: () => 200,
      wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
    const failed = fixture.repository.getRun(run.id)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "file_unavailable");
    assert.equal(failed.sessionId, "session-audit");
    assert.equal(prompts, 0);
  } finally {
    await fixture.close();
  }
});

test("executor consumes a target session error event and sanitizes its failure", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-event-error", 100);
  const opencode = {
    session: {
      create: async () => ({ data: { id: "session-event-error" } }),
      promptAsync: async () => ({ data: true, error: undefined }),
      status: async () => ({ data: { "session-event-error": { type: "busy" } } }),
      messages: async () => ({ data: [] }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: {} }) },
    tool: { ids: async () => ({ data: [] }) },
    event: { subscribe: async () => ({ stream: events([
      { type: "session.error", properties: { sessionID: "session-event-error", error: { message: "token=private-value provider failed" } } },
    ]) }) },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: () => 200,
      wait: async () => new Promise<void>(() => undefined),
    });
    await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
    const failed = fixture.repository.getRun(run.id)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "execution_failed");
    assert.match(failed.errorMessage ?? "", /token=\[redacted\]/);
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
  // TIPS:`eventMetadata.dispatched: true` 模拟"崩溃发生在 promptAsync 成功之后"——这是
  // reconcile() 判定"idle = 正常结束"的前提条件，见 executor.ts reconcile() 的注释。
  const running = fixture.repository.updateRun(queued.id, queued.revision, {
    state: "running", sessionId: "session-existing", startedAt: 101, eventMetadata: { dispatched: true },
  }, 101);
  let prompts = 0;
  const opencode = {
    session: {
      get: async () => ({ data: { id: "session-existing" } }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [{ info: { role: "assistant", providerID: "provider", modelID: "model", agent: "build" } }] }),
      promptAsync: async () => { prompts += 1; return { data: true }; },
    },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: () => 200, wait: async () => undefined,
    });
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

test("restart reconciliation does not mark a run succeeded when the crash happened before dispatch was confirmed", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  fixture.repository.createDefinition(definition, definition);
  const queued = fixture.repository.createManualRun(definition, "run-undispatched", 100);
  // TIPS:没有 `eventMetadata.dispatched` ——模拟"claim 了 run、写了 sessionId，但还没来得及
  // 确认 promptAsync 成功就崩了"这个真实存在的窗口期。会话本身可能是 idle 的（比如这个
  // session 是复用的、上一轮早就跑完了），不能因为 idle 就误判这一轮也跑完了。
  const running = fixture.repository.updateRun(queued.id, queued.revision, {
    state: "running", sessionId: "session-reused", startedAt: 101,
  }, 101);
  const opencode = {
    session: {
      get: async () => ({ data: { id: "session-reused" } }),
      status: async () => ({ data: { "session-reused": { type: "idle" } } }),
      messages: async () => ({ data: [{ info: { role: "assistant", providerID: "provider", modelID: "model", agent: "build" } }] }),
    },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: () => 200, wait: async () => undefined,
    });
    await executor.reconcile({ run: running, definition });
    const reconciled = fixture.repository.getRun(running.id)!;
    assert.equal(reconciled.state, "failed");
    assert.equal(reconciled.errorCode, "session_lost");
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
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => ({ session: { get: async () => ({ data: undefined }) } }) as never,
      now: () => 200, wait: async () => undefined,
    });
    await executor.reconcile({ run: running, definition });
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
    const opencode = {
      session: {
        create: async () => ({ data: { id: `session-${item.id}` } }),
        promptAsync: async () => { prompts += 1; return { data: true }; },
      },
      provider: { list: async () => ({ data: { all: [] } }) },
      app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    };
    try {
      const executor = new AutomationExecutor({
        config: serverConfig(), repository: fixture.repository,
        resolveWorkspace: async () => serverConfig().workspaces[0],
        createWorkspaceOpencodeClient: () => opencode as never,
        now: () => 200, wait: async () => undefined,
      });
      await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
      assert.equal(fixture.repository.getRun(run.id)?.errorCode, item.expected);
      assert.equal(prompts, 0);
    } finally {
      await fixture.close();
    }
  }
});

test("event-triggered execution reuses the mapped session instead of creating a new one", async () => {
  const fixture = await repositoryFixture();
  const definition = eventAutomationDefinition();
  fixture.repository.createDefinition(definition, definition);
  fixture.repository.upsertEntitySessionMapping(definition.id, "github:pull_request:482", "workspace", "session-prior", 50);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-reuse",
    entityRef: "github:pull_request:482", sourceDeliveryId: "delivery-1", now: 100,
  });
  const createInputs: unknown[] = [];
  const promptInputs: Array<Record<string, unknown>> = [];
  const opencode = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessionID === "session-prior" ? { data: { id: "session-prior" } } : { data: undefined },
      create: async (input: unknown) => { createInputs.push(input); return { data: { id: "session-new" } }; },
      promptAsync: async (input: Record<string, unknown>) => { promptInputs.push(input); return { data: true, error: undefined }; },
      status: async () => ({ data: { "session-prior": { type: "idle" } } }),
      messages: async () => ({ data: [{ info: { role: "assistant", providerID: "provider", modelID: "model", agent: "build" } }] }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: {} }) },
    tool: { ids: async () => ({ data: [] }) },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: (() => { let now = 100; return () => ++now; })(), wait: async () => undefined,
    });
    await executor.execute(
      fixture.repository.getRunSnapshot(claim.run.id)!,
      { entityRef: "github:pull_request:482", extraPromptParts: [{ type: "text", text: "自上次以来新增了 1 次提交" }] },
    );
    const completed = fixture.repository.getRun(claim.run.id)!;
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.sessionId, "session-prior");
    assert.equal(createInputs.length, 0);
    assert.match(String((promptInputs[0]!.parts as Array<{ text?: string }>).at(-1)?.text), /自上次以来新增了 1 次提交/);
  } finally {
    await fixture.close();
  }
});

test("event-triggered execution falls back to a new session when the mapped one is unresolvable", async () => {
  const fixture = await repositoryFixture();
  const definition = eventAutomationDefinition();
  fixture.repository.createDefinition(definition, definition);
  fixture.repository.upsertEntitySessionMapping(definition.id, "github:pull_request:482", "workspace", "session-gone", 50);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-fallback",
    entityRef: "github:pull_request:482", sourceDeliveryId: "delivery-1", now: 100,
  });
  const opencode = {
    session: {
      get: async () => ({ data: undefined }),
      create: async () => ({ data: { id: "session-new" } }),
      promptAsync: async () => ({ data: true, error: undefined }),
      status: async () => ({ data: { "session-new": { type: "idle" } } }),
      messages: async () => ({ data: [{ info: { role: "assistant", providerID: "provider", modelID: "model", agent: "build" } }] }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: {} }) },
    tool: { ids: async () => ({ data: [] }) },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: (() => { let now = 100; return () => ++now; })(), wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(claim.run.id)!, { entityRef: "github:pull_request:482", extraPromptParts: [] });
    const completed = fixture.repository.getRun(claim.run.id)!;
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.sessionId, "session-new");
    // TIPS:回退新建会话必须显式标注"上一轮会话不可用"，不能悄悄换了会话却不作说明。
    assert.equal(completed.eventMetadata?.previousSessionUnavailable, true);
    assert.equal(fixture.repository.getEntitySessionMapping(definition.id, "github:pull_request:482")?.sessionId, "session-new");
  } finally {
    await fixture.close();
  }
});

function eventAutomationDefinition(): AutomationDefinition {
  return {
    ...automationDefinition(),
    trigger: {
      version: 1, kind: "event", provider: "github", connectorId: "connector-1",
      repository: { owner: "juggleai", name: "jugglework-desktop" },
      matches: [{ event: "pull_request" }], concurrencyKey: "entity", deliveryMode: "auto", permissionTier: "auto",
    },
  };
}

function automationDefinition(): AutomationDefinition {
  return {
    schema: "automation-definition/v1",
    id: "task",
    name: "Task",
    workspace: { id: "workspace", name: "Workspace", path: "/tmp/workspace", workspaceType: "local" },
    prompt: { version: 1, parts: [{ type: "text", text: "run" }] },
    trigger: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "UTC" },
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

async function* events(values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}
