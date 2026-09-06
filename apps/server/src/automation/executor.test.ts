import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition } from "@jugglework/types/automation";
import { openRuntimeSqliteDatabase } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { AutomationExecutor, writeBackMcpName } from "./executor.js";
import { AutomationRepository } from "./repository.js";
import { createUnconfiguredGithubEventRelayClient, type GithubEventRelayClient } from "./github-event-client.js";
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

// TIPS（3b.4）：复用既有的 provider 上报 token 用量（不是渲染进程那种文本长度估算）作为
// "该不该毕业到新会话"的判断依据，见 design.md 的 staleness/graduation 决策。
test("event-triggered execution graduates to a new session when context usage crosses the threshold", async () => {
  const fixture = await repositoryFixture();
  const definition = eventAutomationDefinition();
  fixture.repository.createDefinition(definition, definition);
  fixture.repository.upsertEntitySessionMapping(definition.id, "github:pull_request:482", "workspace", "session-prior", 50);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-graduate",
    entityRef: "github:pull_request:482", sourceDeliveryId: "delivery-1", now: 100,
  });
  const createInputs: unknown[] = [];
  const promptInputs: Array<Record<string, unknown>> = [];
  const opencode = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessionID === "session-prior" ? { data: { id: "session-prior" } } : { data: undefined },
      create: async (input: unknown) => { createInputs.push(input); return { data: { id: "session-graduated" } }; },
      promptAsync: async (input: Record<string, unknown>) => { promptInputs.push(input); return { data: true, error: undefined }; },
      status: async () => ({ data: { "session-graduated": { type: "idle" } } }),
      messages: async () => ({
        data: [{
          info: {
            role: "assistant", providerID: "provider", modelID: "model", agent: "build",
            tokens: { input: 90_000, output: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: "text", text: "并发问题已经修复，另有 1 处建议。" }],
        }],
      }),
    },
    provider: { list: async () => ({ data: { all: [{ id: "provider", models: { model: { limit: { context: 100_000 } } } }] } }) },
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
    assert.equal(completed.sessionId, "session-graduated");
    assert.equal(createInputs.length, 1, "usage over threshold must create a new session, not reuse the old one");
    assert.equal(completed.eventMetadata?.graduatedFromSessionId, "session-prior");
    // previousSessionUnavailable 不能跟着一起打上——旧会话查得到，只是主动决定不再复用。
    assert.equal(completed.eventMetadata?.previousSessionUnavailable, undefined);
    const parts = promptInputs[0]!.parts as Array<{ text?: string }>;
    assert.equal(parts.length, 3, "automation prompt + graduation note + this turn's extraPromptParts");
    assert.match(String(parts[1]?.text), /session-prior/);
    assert.match(String(parts[1]?.text), /并发问题已经修复，另有 1 处建议/);
    assert.match(String(parts[2]?.text), /自上次以来新增了 1 次提交/);
    assert.equal(fixture.repository.getEntitySessionMapping(definition.id, "github:pull_request:482")?.sessionId, "session-graduated");
  } finally {
    await fixture.close();
  }
});

test("event-triggered execution does not graduate when usage is comfortably under the threshold", async () => {
  const fixture = await repositoryFixture();
  const definition = eventAutomationDefinition();
  fixture.repository.createDefinition(definition, definition);
  fixture.repository.upsertEntitySessionMapping(definition.id, "github:pull_request:482", "workspace", "session-prior", 50);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-no-graduate",
    entityRef: "github:pull_request:482", sourceDeliveryId: "delivery-1", now: 100,
  });
  const createInputs: unknown[] = [];
  const opencode = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessionID === "session-prior" ? { data: { id: "session-prior" } } : { data: undefined },
      create: async (input: unknown) => { createInputs.push(input); return { data: { id: "session-new" } }; },
      promptAsync: async () => ({ data: true, error: undefined }),
      status: async () => ({ data: { "session-prior": { type: "idle" } } }),
      messages: async () => ({
        data: [{
          info: {
            role: "assistant", providerID: "provider", modelID: "model", agent: "build",
            tokens: { input: 10_000, output: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: "text", text: "看起来没问题。" }],
        }],
      }),
    },
    provider: { list: async () => ({ data: { all: [{ id: "provider", models: { model: { limit: { context: 100_000 } } } }] } }) },
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
    assert.equal(completed.sessionId, "session-prior");
    assert.equal(createInputs.length, 0);
    assert.equal(completed.eventMetadata?.graduatedFromSessionId, undefined);
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

test("event-triggered execution with a github-app connector fetches a fresh write-back grant per run", async () => {
  const fixture = await repositoryFixture();
  const definition = { ...eventAutomationDefinition(), connectors: [{ id: "github-app", source: "github-app" as const, label: "GitHub App" }] };
  fixture.repository.createDefinition(definition, definition);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-grant",
    entityRef: "github:pull_request:482", sourceDeliveryId: "delivery-1", now: 100,
  });
  const grantCalls: Array<{ automationId: string; repo: unknown }> = [];
  const relay: GithubEventRelayClient = {
    ...createUnconfiguredGithubEventRelayClient(),
    fetchWriteBackGrant: async (automationId, repo) => { grantCalls.push({ automationId, repo }); return { token: "tok", expiresAt: 999 }; },
  };
  const mcpUpsertCalls: Array<{ workspaceId: string; name: string; grant: { token: string; expiresAt: number } }> = [];
  let dispatchedPrompt: unknown;
  const opencode = {
    session: {
      create: async () => ({ data: { id: "session-1" } }),
      promptAsync: async (prompt: unknown) => { dispatchedPrompt = prompt; return { data: true, error: undefined }; },
      status: async () => ({ data: { "session-1": { type: "idle" } } }),
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
      githubEventRelay: relay,
      writeBackMcp: {
        upsert: async (workspace, name, grant) => { mcpUpsertCalls.push({ workspaceId: workspace.id, name, grant }); },
      },
      now: (() => { let now = 100; return () => ++now; })(), wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(claim.run.id)!, { entityRef: "github:pull_request:482", extraPromptParts: [] });
    assert.equal(fixture.repository.getRun(claim.run.id)?.state, "succeeded");
    // TIPS: 换到的 token 必须真的被拿去挂载工具，不能只停在"换取成功"这一步——这正是
    // 之前一直卡住的那个缺口（见 executor.ts 的 fetchWriteBackGrant 注释）。
    assert.equal(mcpUpsertCalls.length, 1);
    assert.equal(mcpUpsertCalls[0]?.name, writeBackMcpName(definition.id));
    assert.deepEqual(mcpUpsertCalls[0]?.grant, { token: "tok", expiresAt: 999 });
    // prompt 里也要带上"这个工具现在可用"的提示，模型不会凭空知道。
    const parts = (dispatchedPrompt as { parts: Array<{ text?: string }> } | undefined)?.parts ?? [];
    assert.ok(parts.some((part) => part.text?.includes("GitHub 工具")));
    assert.equal(grantCalls.length, 1);
    assert.equal(grantCalls[0]?.automationId, definition.id);
    assert.deepEqual(grantCalls[0]?.repo, { owner: "juggleai", name: "jugglework-desktop" });
  } finally {
    await fixture.close();
  }
});

test("event-triggered execution fails preflight with connector_unavailable when no relay is configured", async () => {
  const fixture = await repositoryFixture();
  const definition = { ...eventAutomationDefinition(), connectors: [{ id: "github-app", source: "github-app" as const, label: "GitHub App" }] };
  fixture.repository.createDefinition(definition, definition);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-no-relay",
    entityRef: "github:pull_request:483", sourceDeliveryId: "delivery-2", now: 100,
  });
  const opencode = {
    session: { create: async () => ({ data: { id: "session-1" } }), promptAsync: async () => ({ data: true, error: undefined }), status: async () => ({ data: {} }), messages: async () => ({ data: [] }) },
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
      // TIPS:故意不传 githubEventRelay，模拟"relay 没有接线"这个已知缺口。
      now: (() => { let now = 100; return () => ++now; })(), wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(claim.run.id)!, { entityRef: "github:pull_request:483", extraPromptParts: [] });
    const failed = fixture.repository.getRun(claim.run.id)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "connector_unavailable");
  } finally {
    await fixture.close();
  }
});

// TIPS: 换到 token 只是前半段——没有地方把它接到 agent 能调用的工具上，这一轮不该假装成功。
test("event-triggered execution fails preflight with connector_unavailable when the grant is fetched but nothing can mount it as a tool", async () => {
  const fixture = await repositoryFixture();
  const definition = { ...eventAutomationDefinition(), connectors: [{ id: "github-app", source: "github-app" as const, label: "GitHub App" }] };
  fixture.repository.createDefinition(definition, definition);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-no-mcp",
    entityRef: "github:pull_request:484", sourceDeliveryId: "delivery-3", now: 100,
  });
  const relay: GithubEventRelayClient = {
    ...createUnconfiguredGithubEventRelayClient(),
    fetchWriteBackGrant: async () => ({ token: "tok", expiresAt: 999 }),
  };
  const opencode = {
    session: { create: async () => ({ data: { id: "session-1" } }), promptAsync: async () => ({ data: true, error: undefined }), status: async () => ({ data: {} }), messages: async () => ({ data: [] }) },
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
      githubEventRelay: relay,
      // TIPS:故意不传 writeBackMcp——换到 token 但没地方挂载，必须整轮失败，不能悄悄
      // 当成"这一轮不需要写回工具"继续跑。
      now: (() => { let now = 100; return () => ++now; })(), wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(claim.run.id)!, { entityRef: "github:pull_request:484", extraPromptParts: [] });
    const failed = fixture.repository.getRun(claim.run.id)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "connector_unavailable");
  } finally {
    await fixture.close();
  }
});

test("event-triggered execution fails preflight with connector_unavailable when mounting the tool itself fails", async () => {
  const fixture = await repositoryFixture();
  const definition = { ...eventAutomationDefinition(), connectors: [{ id: "github-app", source: "github-app" as const, label: "GitHub App" }] };
  fixture.repository.createDefinition(definition, definition);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-mcp-fails",
    entityRef: "github:pull_request:485", sourceDeliveryId: "delivery-4", now: 100,
  });
  const relay: GithubEventRelayClient = {
    ...createUnconfiguredGithubEventRelayClient(),
    fetchWriteBackGrant: async () => ({ token: "tok", expiresAt: 999 }),
  };
  const opencode = {
    session: { create: async () => ({ data: { id: "session-1" } }), promptAsync: async () => ({ data: true, error: undefined }), status: async () => ({ data: {} }), messages: async () => ({ data: [] }) },
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
      githubEventRelay: relay,
      writeBackMcp: { upsert: async () => { throw new Error("engine unreachable"); } },
      now: (() => { let now = 100; return () => ++now; })(), wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(claim.run.id)!, { entityRef: "github:pull_request:485", extraPromptParts: [] });
    const failed = fixture.repository.getRun(claim.run.id)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "connector_unavailable");
  } finally {
    await fixture.close();
  }
});

// TIPS（3b.8）：写回授权换取失败，且不是"服务暂时不可用"（github_event_relay_unavailable）
// 那种可重试的失败，大概率是仓库解绑/App 卸载/转移——同一个实体换个新会话也解决不了同一个
// 病根，所以这条实体的会话归属映射要显式标成 invalid，而不是留着 active 让下一轮触发
// 继续误以为复用这个会话还有意义。运行记录本身仍然用 connector_reauth_required 呈现，
// 跟"会话本身不可解析"走的是两条不同的提示路径，不能混用。
test("event-triggered execution invalidates the entity session mapping when the write-back grant fetch fails with a real (not transient) reauth error", async () => {
  const fixture = await repositoryFixture();
  const definition = { ...eventAutomationDefinition(), connectors: [{ id: "github-app", source: "github-app" as const, label: "GitHub App" }] };
  fixture.repository.createDefinition(definition, definition);
  // 先手动种一条 active 的会话归属映射，模拟"这个实体之前已经成功复用过会话"。
  fixture.repository.upsertEntitySessionMapping(definition.id, "github:pull_request:486", "workspace-1", "session-existing", 50);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-revoked",
    entityRef: "github:pull_request:486", sourceDeliveryId: "delivery-5", now: 100,
  });
  const relay: GithubEventRelayClient = {
    ...createUnconfiguredGithubEventRelayClient(),
    // TIPS：任何不是 `github_event_relay_unavailable` 的失败都被当成"真的换不到授权"，
    // 见 fetchWriteBackGrant 的 catch 分支——不需要伪造一个特定的错误码，普通 Error 就够。
    fetchWriteBackGrant: async () => { throw new Error("installation not found"); },
  };
  const opencode = {
    session: { create: async () => ({ data: { id: "session-1" } }), promptAsync: async () => ({ data: true, error: undefined }), status: async () => ({ data: {} }), messages: async () => ({ data: [] }) },
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
      githubEventRelay: relay,
      // TIPS：必须提供 writeBackMcp（哪怕是个空实现）——preflight 的前置守卫是
      // "githubEventRelay 和 writeBackMcp 任一缺失都直接判 connector_unavailable"，
      // 不给的话根本走不到真正调用 fetchWriteBackGrant 那一步，测不出这条用例要测的东西。
      writeBackMcp: { upsert: async () => undefined },
      now: (() => { let now = 100; return () => ++now; })(), wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(claim.run.id)!, { entityRef: "github:pull_request:486", extraPromptParts: [] });
    const failed = fixture.repository.getRun(claim.run.id)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "connector_reauth_required");
    const mapping = fixture.repository.getEntitySessionMapping(definition.id, "github:pull_request:486");
    assert.equal(mapping?.status, "invalid");
    assert.equal(mapping?.invalidReason, "connector_reauth_required");
  } finally {
    await fixture.close();
  }
});

test("shadow lifecycle runs preflight but never creates a session or dispatches a prompt", async () => {
  const fixture = await repositoryFixture();
  const definition = { ...eventAutomationDefinition(), lifecycle: "shadow" as const };
  fixture.repository.createDefinition(definition, definition);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-shadow",
    entityRef: "github:pull_request:482", sourceDeliveryId: "delivery-1", now: 100,
  });
  let createCalls = 0;
  let promptCalls = 0;
  const opencode = {
    session: {
      create: async () => { createCalls += 1; return { data: { id: "session-should-not-exist" } }; },
      promptAsync: async () => { promptCalls += 1; return { data: true, error: undefined }; },
      get: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
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
    await executor.execute(fixture.repository.getRunSnapshot(claim.run.id)!, { entityRef: "github:pull_request:482", extraPromptParts: [{ type: "text", text: "delta" }] });
    const completed = fixture.repository.getRun(claim.run.id)!;
    assert.equal(completed.state, "skipped");
    assert.equal(completed.sessionId, undefined);
    assert.equal(createCalls, 0);
    assert.equal(promptCalls, 0);
    assert.equal(completed.eventMetadata?.shadowPreview?.promptPartCount, 2);
  } finally {
    await fixture.close();
  }
});

test("shadow lifecycle still fails preflight normally when a dependency is unavailable", async () => {
  const fixture = await repositoryFixture();
  const definition = {
    ...eventAutomationDefinition(),
    lifecycle: "shadow" as const,
    agentId: "missing-agent",
  };
  fixture.repository.createDefinition(definition, definition);
  const claim = fixture.repository.claimEventRun({
    automationId: definition.id, definitionRevision: 1, runId: "run-shadow-fail",
    entityRef: "github:pull_request:1", sourceDeliveryId: "delivery-1", now: 100,
  });
  const opencode = {
    session: { create: async () => ({ data: { id: "unused" } }), promptAsync: async () => ({ data: true, error: undefined }), status: async () => ({ data: {} }), messages: async () => ({ data: [] }) },
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
    await executor.execute(fixture.repository.getRunSnapshot(claim.run.id)!, { entityRef: "github:pull_request:1", extraPromptParts: [] });
    const failed = fixture.repository.getRun(claim.run.id)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "agent_unavailable");
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
