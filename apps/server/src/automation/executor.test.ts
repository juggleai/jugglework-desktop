import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTOMATION_DEFAULT_PERMISSION_PROFILE, AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition } from "@jugglework/types/automation";
import { openRuntimeSqliteDatabase } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { AutomationExecutor, writeBackMcpName } from "./executor.js";
import { AutomationRepository } from "./repository.js";
import { createUnconfiguredGithubEventRelayClient, type GithubEventRelayClient } from "./github-event-client.js";
import { automationSqliteAdapter } from "./sqlite.js";
import { createSessionMutationCoordinator } from "../session-mutation-coordinator.js";

test("executor creates an auditable full-access session and completes only after idle", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-1", 100);
  const createInputs: Array<Record<string, unknown>> = [];
  const updateInputs: Array<Record<string, unknown>> = [];
  const promptInputs: Array<Record<string, unknown>> = [];
  const sessionMutations = createSessionMutationCoordinator();
  let statusReads = 0;
  const opencode = {
    session: {
      create: async (input: Record<string, unknown>) => { createInputs.push(input); return { data: { id: "session-1" } }; },
      update: async (input: Record<string, unknown>) => { updateInputs.push(input); return { data: true, error: undefined }; },
      promptAsync: async (input: Record<string, unknown>) => {
        assert.equal(sessionMutations.getActive("workspace", "session-1")?.status, "starting");
        promptInputs.push(input);
        return { data: true, error: undefined };
      },
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
      sessionMutations,
      now: (() => { let now = 100; return () => ++now; })(),
      wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
    const completed = fixture.repository.getRun(run.id)!;
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.sessionId, "session-1");
    assert.equal(sessionMutations.getActive("workspace", "session-1"), null);
    assert.deepEqual(completed.concreteModel, { providerId: "provider", modelId: "model" });
    assert.equal((createInputs[0].metadata as Record<string, unknown>).automationRunId, run.id);
    assert.deepEqual(createInputs[0].permission, [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "deny" },
    ]);
    assert.match(String(promptInputs[0].system), /不得询问用户/);
    assert.match(String(promptInputs[0].system), /tool_error_retryable=false/);
    assert.match(String(promptInputs[0].system), /禁止再次调用同一工具/);
    assert.match(String(promptInputs[0].system), /本任务未授权以下连接器：github/);
    assert.match(String(promptInputs[0].system), /严禁调用以 github_ 开头/);
    assert.equal(promptInputs[0].tools, undefined);
    assert.deepEqual(updateInputs[0], {
      sessionID: "session-1",
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "question", pattern: "*", action: "deny" },
        { permission: "github_*", pattern: "*", action: "deny" },
      ],
    });
  } finally {
    await fixture.close();
  }
});

test("a retrying automation can be stopped through the shared session coordinator", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-stopped", 100);
  const sessionMutations = createSessionMutationCoordinator();
  let stopped = false;
  const opencode = {
    session: {
      create: async () => ({ data: { id: "retrying-session" } }),
      update: async () => ({ data: true, error: undefined }),
      promptAsync: async () => ({ data: true }),
      status: async () => {
        const active = sessionMutations.getActive("workspace", "retrying-session");
        assert.ok(active, "Stop must find the automation in the authoritative active-run list");
        if (!stopped) {
          sessionMutations.reserveAbort({ ...active, abortCommandCorrelationId: "user-stop" });
          sessionMutations.acceptAbort({ ...active, abortCommandCorrelationId: "user-stop" });
          stopped = true;
          return { data: { "retrying-session": { type: "retry", attempt: 1, message: "Provider unavailable", next: 300 } } };
        }
        return { data: {} };
      },
      messages: async () => ({ data: [{ info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } }] }),
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
      sessionMutations, now: () => 200, wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
    assert.equal(stopped, true);
    assert.equal(fixture.repository.getRun(run.id)?.state, "cancelled");
    assert.equal(sessionMutations.listActive().length, 0);
  } finally {
    await fixture.close();
  }
});

for (const outcome of ["succeeded", "failed", "cancelled"] as const) {
  test(`parallel sessions remain isolated when another automation is ${outcome}`, async () => {
    const fixture = await repositoryFixture();
    const sessionMutations = createSessionMutationCoordinator();
    const waits: Array<() => void> = [];
    const statuses: Record<string, { type: string }> = {
      "session-task-a": { type: "idle" },
      "session-task-b": { type: "busy" },
    };
    const opencode = {
      session: {
        create: async (input: { metadata: { automationId: string } }) => ({ data: { id: `session-${input.metadata.automationId}` } }),
        update: async () => ({ data: true }),
        promptAsync: async () => ({ data: true }),
        status: async () => ({ data: statuses }),
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: [{ info: {
            role: "assistant", providerID: "provider", modelID: "model", agent: "build",
            ...(sessionID === "session-task-a" && outcome !== "succeeded" ? {
              error: { name: outcome === "cancelled" ? "MessageAbortedError" : "APIError", data: { message: "Stopped" } },
            } : {}),
          }, parts: [] }],
        }),
      },
      provider: { list: async () => ({ data: { all: [] } }) },
      app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
    };
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      sessionMutations, now: () => 200,
      wait: () => new Promise<void>((resolve) => { waits.push(resolve); }),
    });
    const executions: Promise<void>[] = [];
    const tick = async () => {
      for (const resolve of waits.splice(0)) resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    try {
      for (const id of ["task-a", "task-b"]) {
        const definition = { ...automationDefinition(), id };
        fixture.repository.createDefinition(definition, definition);
        const run = fixture.repository.createManualRun(definition, `run-${id}`, 100);
        executions.push(executor.execute(fixture.repository.getRunSnapshot(run.id)!));
      }
      for (let attempt = 0; attempt < 50 && waits.length < 2; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(sessionMutations.listActive().length, 2);
      const second = sessionMutations.getActive("workspace", "session-task-b")!;
      if (outcome === "cancelled") {
        const first = sessionMutations.getActive("workspace", "session-task-a")!;
        sessionMutations.reserveAbort({ ...first, abortCommandCorrelationId: "stop-a" });
        sessionMutations.acceptAbort({ ...first, abortCommandCorrelationId: "stop-a" });
      }
      for (let attempt = 0; attempt < 50 && fixture.repository.getRun("run-task-a")?.state === "running"; attempt += 1) await tick();
      await executions[0];
      assert.equal(fixture.repository.getRun("run-task-a")?.state, outcome);
      assert.equal(sessionMutations.getActive("workspace", "session-task-a"), null);
      assert.equal(fixture.repository.getRun("run-task-b")?.state, "running");
      assert.equal(sessionMutations.getActive("workspace", "session-task-b")?.runId, second.runId);
      statuses["session-task-b"] = { type: "idle" };
      for (let attempt = 0; attempt < 50 && fixture.repository.getRun("run-task-b")?.state === "running"; attempt += 1) await tick();
      await executions[1];
      assert.equal(fixture.repository.getRun("run-task-b")?.state, "succeeded");
      assert.equal(sessionMutations.listActive().length, 0);
    } finally {
      executor.dispose();
      for (const resolve of waits.splice(0)) resolve();
      await Promise.all(executions);
      await fixture.close();
    }
  });
}

test("executor exposes tools only for selected connected MCP servers", async () => {
  const fixture = await repositoryFixture();
  const definition = {
    ...automationDefinition(),
    connectors: [{ id: "github", source: "local-mcp" as const, label: "GitHub" }],
  };
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-connectors", 100);
  const promptInputs: Array<Record<string, unknown>> = [];
  const updateInputs: Array<Record<string, unknown>> = [];
  const opencode = {
    session: {
      create: async () => ({ data: { id: "session-connectors" } }),
      update: async (input: Record<string, unknown>) => { updateInputs.push(input); return { data: true, error: undefined }; },
      promptAsync: async (input: Record<string, unknown>) => { promptInputs.push(input); return { data: true, error: undefined }; },
      status: async () => ({ data: { "session-connectors": { type: "idle" } } }),
      messages: async () => ({ data: [] }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: { github: { status: "connected" }, linear: { status: "connected" } } }) },
    tool: { ids: async () => ({ data: ["read", "bash", "webfetch"] }) },
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
    assert.equal(promptInputs[0].tools, undefined);
    assert.deepEqual(updateInputs[0], {
      sessionID: "session-connectors",
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "question", pattern: "*", action: "deny" },
        { permission: "linear_*", pattern: "*", action: "deny" },
      ],
    });
  } finally {
    await fixture.close();
  }
});

test("default-permission execution restores the selected agent policy before applying connector denies", async () => {
  const fixture = await repositoryFixture();
  const definition = {
    ...automationDefinition(),
    permission: { profile: AUTOMATION_DEFAULT_PERMISSION_PROFILE, acknowledgedAt: 1 },
    agentId: "reviewer",
  };
  fixture.repository.createDefinition(definition, definition);
  const run = fixture.repository.createManualRun(definition, "run-default-permissions", 100);
  const updates: Array<Record<string, unknown>> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const opencode = {
    session: {
      create: async () => ({ data: { id: "session-default" } }),
      update: async (input: Record<string, unknown>) => { updates.push(input); return { data: true, error: undefined }; },
      promptAsync: async (input: Record<string, unknown>) => { prompts.push(input); return { data: true, error: undefined }; },
      status: async () => ({ data: { "session-default": { type: "idle" } } }),
      messages: async () => ({ data: [] }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    app: {
      agents: async () => ({ data: [{
        name: "reviewer", mode: "primary", options: {},
        permission: [
          { permission: "*", pattern: "*", action: "ask" },
          { permission: "read", pattern: "*", action: "allow" },
        ],
      }] }),
      skills: async () => ({ data: [] }),
    },
    mcp: { status: async () => ({ data: { notion: { status: "connected" } } }) },
  };
  try {
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => opencode as never,
      now: () => 200, wait: async () => undefined,
    });
    await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
    assert.equal(fixture.repository.getRun(run.id)?.state, "succeeded");
    assert.deepEqual(updates[0], {
      sessionID: "session-default",
      permission: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "notion_*", pattern: "*", action: "deny" },
      ],
    });
    assert.equal(prompts[0]?.tools, undefined);
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
      update: async () => ({ data: true, error: undefined }),
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
      update: async () => ({ data: true, error: undefined }),
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
      update: async () => ({ data: true, error: undefined }),
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
      update: async () => ({ data: true, error: undefined }),
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
      update: async () => ({ data: true, error: undefined }),
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
      update: async () => ({ data: true, error: undefined }),
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
  let repository = AutomationRepository.fromDatabase(automationSqliteAdapter(runtime));
  return {
    get repository() { return repository; },
    reopen: async () => {
      repository.close();
      repository = AutomationRepository.fromDatabase(automationSqliteAdapter(await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"))));
    },
    close: async () => { repository.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function* events(values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}

for (const selected of [false, true]) {
  for (const newChatPerRun of [false, true]) {
    test(`scheduled execution: selected=${selected}, newChatPerRun=${newChatPerRun}, survives database restart`, async () => {
      const fixture = await repositoryFixture();
      const root = await mkdtemp(join(tmpdir(), "jw-scheduled-workspaces-"));
      const definition = { ...automationDefinition(), workspace: selected ? automationDefinition().workspace : undefined, newChatPerRun, directoryName: "daily_news" };
      const creates: string[] = [];
      const prompted: string[] = [];
      const workspaces: string[] = [];
      const opencode = {
        session: {
          create: async () => { const id = `session-${creates.length}`; creates.push(id); return { data: { id } }; },
          get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
          update: async () => ({ data: true, error: undefined }),
          promptAsync: async ({ sessionID }: { sessionID: string }) => { prompted.push(sessionID); return { data: true }; },
          status: async () => ({ data: Object.fromEntries(creates.map((id) => [id, { type: "idle" }])) }),
          messages: async () => ({ data: [] }),
        },
        provider: { list: async () => ({ data: { all: [] } }) },
        app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
        mcp: { status: async () => ({ data: {} }) },
        tool: { ids: async () => ({ data: [] }) },
      };
      try {
        fixture.repository.createDefinition(definition, definition);
        for (let index = 0; index < 3; index++) {
          const now = Date.parse(index === 2 ? "2026-10-22T08:00:00Z" : "2026-10-21T08:00:00Z");
          const run = fixture.repository.createManualRun(definition, `combination-${index}`, now);
          const executor = new AutomationExecutor({
            config: serverConfig(), repository: fixture.repository, workspaceRoot: root,
            resolveWorkspace: async () => serverConfig().workspaces[0], registerWorkspace: async (workspace) => workspace,
            createWorkspaceOpencodeClient: (_config, workspace) => { workspaces.push(workspace.path); return opencode as never; },
            now: () => now, wait: async () => undefined,
          });
          await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
          const result = fixture.repository.getRun(run.id)!;
          assert.equal(result.state, "succeeded", result.errorMessage);
          assert.ok(result.workspaceId);
          assert.equal(result.sessionId, prompted.at(-1));
          assert.equal(fixture.repository.getExecutionBinding(`run:${run.id}`)?.sessionId, result.sessionId);
          assert.equal(fixture.repository.getExecutionBinding(`run:${run.id}`)?.workspace.path, workspaces.at(-1));
          await fixture.reopen();
        }
        assert.equal(creates.length, newChatPerRun ? 3 : 1);
        assert.equal(new Set(workspaces).size, !selected && newChatPerRun ? 3 : 1);
        if (!selected && newChatPerRun) {
          assert.equal(workspaces[0], join(root, "2026-10-21", "daily_news"));
          assert.equal(workspaces[1], join(root, "2026-10-21", "daily_news_2"));
          assert.equal(workspaces[2], join(root, "2026-10-22", "daily_news"));
        }
      } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
}


for (const scenario of ["missing", "busy", "unavailable"] as const) {
  test(`reused scheduled session handles ${scenario} without duplicate dispatch`, async () => {
    const fixture = await repositoryFixture();
    const definition = { ...automationDefinition(), newChatPerRun: false };
    let created = 0;
    let dispatched = 0;
    const opencode = {
      session: {
        get: async () => scenario === "missing" ? { error: { name: "NotFoundError" } } : scenario === "unavailable" ? { error: { message: "service unavailable" } } : { data: { id: "old-session" } },
        status: async () => ({ data: { "old-session": { type: "busy" } } }),
        create: async () => { created++; return { data: { id: "new-session" } }; },
        update: async () => ({ data: true, error: undefined }),
        promptAsync: async () => { dispatched++; return { data: true }; },
        messages: async () => ({ data: [] }),
      },
      provider: { list: async () => ({ data: { all: [] } }) },
      app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) }, tool: { ids: async () => ({ data: [] }) },
    };
    try {
      fixture.repository.createDefinition(definition, definition);
      fixture.repository.setExecutionBinding(`task:${definition.id}`, { workspace: serverConfig().workspaces[0], sessionId: "old-session" });
      const run = fixture.repository.createManualRun(definition, `reuse-${scenario}`, 100);
      const executor = new AutomationExecutor({ config: serverConfig(), repository: fixture.repository,
        resolveWorkspace: async () => serverConfig().workspaces[0], createWorkspaceOpencodeClient: () => opencode as never,
        now: () => 101, wait: async () => undefined });
      await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
      const result = fixture.repository.getRun(run.id)!;
      assert.equal(created, scenario === "missing" ? 1 : 0);
      assert.equal(dispatched, scenario === "missing" ? 1 : 0);
      assert.equal(result.state, scenario === "missing" ? "succeeded" : "failed");
      if (scenario !== "missing") assert.equal(result.errorCode, scenario === "busy" ? "overlap_blocked" : "execution_failed");
    } finally { await fixture.close(); }
  });
}

for (const selected of [false, true]) {
  for (const newChatPerRun of [false, true]) {
    test(`prepare/reopen is side-effect free and execution respects binding: selected=${selected}, newChatPerRun=${newChatPerRun}`, async () => {
      const fixture = await repositoryFixture();
      const root = await mkdtemp(join(tmpdir(), "jw-prepare-workspaces-"));
      const definition = { ...automationDefinition(), workspace: selected ? automationDefinition().workspace : undefined, newChatPerRun, lifecycle: "paused" as const };
      const creates: Array<Record<string, unknown>> = [];
      const prompts: Array<{ sessionID: string }> = [];
      const registered: string[] = [];
      const config = serverConfig();
      let currentWorkspace = "";
      const client = {
        session: {
          create: async (input: Record<string, unknown>) => { creates.push(input); return { data: { id: `session-${creates.length}` } }; },
          get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
          update: async () => ({ data: true, error: undefined }),
          status: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
          promptAsync: async (input: { sessionID: string }) => { prompts.push(input); return { data: true }; },
        },
        mcp: { status: async () => ({ data: {} }) }, tool: { ids: async () => ({ data: [] }) },
      };
      const makeExecutor = () => new AutomationExecutor({
        config, repository: fixture.repository, workspaceRoot: root,
        resolveWorkspace: async () => config.workspaces[0],
        registerWorkspace: async (workspace) => { registered.push(workspace.path); return workspace; },
        createWorkspaceOpencodeClient: (_config, workspace) => { currentWorkspace = workspace.path; return client as never; },
        now: () => 200, wait: async () => undefined,
      });
      try {
        fixture.repository.createDefinition(definition, definition);
        const before = fixture.repository.getDefinition(definition.id);
        const outbox = fixture.repository.readOutbox();
        let executor = makeExecutor();
        const opened = await Promise.all(Array.from({ length: 8 }, () => executor.prepareSession(definition.id)));
        assert.ok(opened.every((item) => item.sessionId === "session-1"));
        assert.equal(creates.length, 1);
        assert.equal(prompts.length, 0);
        assert.deepEqual(creates[0].metadata, { automationId: definition.id, automationDefinitionRevision: 1 });
        assert.deepEqual(fixture.repository.getDefinition(definition.id), before);
        assert.deepEqual(fixture.repository.readOutbox(), outbox);
        assert.deepEqual(fixture.repository.listRuns().items, []);
        assert.equal(registered.length, selected ? 0 : 1);
        assert.deepEqual(config.workspaces, serverConfig().workspaces, "preparation must not switch the active workspace");
        await fixture.reopen();
        executor = makeExecutor();
        assert.deepEqual(await executor.prepareSession(definition.id), opened[0]);
        assert.equal(creates.length, 1);
        assert.deepEqual(fixture.repository.listRuns().items, []);
        assert.equal(prompts.length, 0);
        const preparedPath = currentWorkspace;
        const run = fixture.repository.createManualRun(definition, "prepared-run", 201);
        await executor.execute(fixture.repository.getRunSnapshot(run.id)!);
        assert.equal(fixture.repository.getRun(run.id)?.state, "succeeded");
        assert.equal(creates.length, newChatPerRun ? 2 : 1);
        assert.equal(prompts[0].sessionID, newChatPerRun ? "session-2" : "session-1");
        assert.equal(currentWorkspace === preparedPath, selected || !newChatPerRun);
        assert.equal((await executor.prepareSession(definition.id)).sessionId, prompts[0].sessionID, "open should prefer the latest real run");
        assert.equal(creates.length, newChatPerRun ? 2 : 1);
      } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
}

test("initializes a prepared task conversation with a model acknowledgement but no automation run", async () => {
  const fixture = await repositoryFixture();
  const definition = {
    ...automationDefinition(),
    name: "查询北京天气",
    prompt: { version: 1 as const, parts: [{ type: "text" as const, text: "查询下北京是否下雨" }] },
    trigger: { version: 1 as const, kind: "calendar" as const, frequency: "daily" as const, localTime: "09:00", timezone: "Asia/Shanghai" },
    newChatPerRun: false,
  };
  const prompts: Array<Record<string, unknown>> = [];
  const permissionUpdates: Array<Record<string, unknown>> = [];
  const sessionMutations = createSessionMutationCoordinator({
    randomUUID: () => "confirmation-run",
    now: () => 200,
  });
  const executor = new AutomationExecutor({
    config: serverConfig(),
    repository: fixture.repository,
    resolveWorkspace: async () => serverConfig().workspaces[0],
    createWorkspaceOpencodeClient: () => ({
      session: {
        create: async () => ({ data: { id: "scheduled-conversation" } }),
        update: async (input: Record<string, unknown>) => { permissionUpdates.push(input); return { data: true, error: undefined }; },
        promptAsync: async (input: Record<string, unknown>) => { prompts.push(input); return { data: true }; },
      },
      tool: { ids: async () => ({ data: ["web_search", "bash"] }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    }) as never,
    sessionMutations,
    now: () => 200,
    wait: async () => undefined,
  });
  try {
    fixture.repository.createDefinition(definition, definition);
    const prepared = await executor.prepareSession(definition.id, { initializeConversation: true, locale: "zh" });
    assert.deepEqual(prepared, { workspaceId: "workspace", sessionId: "scheduled-conversation" });
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0]?.tools, { "*": false });
    assert.deepEqual(permissionUpdates, [{
      sessionID: "scheduled-conversation",
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "question", pattern: "*", action: "deny" },
      ],
    }]);
    assert.deepEqual(prompts[0]?.parts, [{ type: "text", text: "查询下北京是否下雨\n\n日程安排：每天 09:00" }]);
    assert.match(String(prompts[0]?.system), /不要执行用户描述的任务/);
    assert.deepEqual(sessionMutations.getActive("workspace", "scheduled-conversation"), {
      workspaceId: "workspace",
      sessionId: "scheduled-conversation",
      runId: "confirmation-run",
      generation: 1,
      origin: "local-renderer",
      startCommandCorrelationId: null,
      abortCommandCorrelationId: null,
      status: "running",
      observedActive: false,
      startedAt: 200,
      updatedAt: 200,
      activeObservedAt: null,
      abortRequestedAt: null,
    });
    assert.deepEqual(fixture.repository.listRuns().items, []);
    assert.equal(fixture.repository.getExecutionBinding(`task:${definition.id}`)?.sessionId, "scheduled-conversation");
  } finally {
    await fixture.close();
  }
});

test("waits for a fresh workspace provider registry before dispatching its confirmation", async () => {
  const fixture = await repositoryFixture();
  const definition = {
    ...automationDefinition(),
    model: { mode: "explicit" as const, providerId: "provider", modelId: "model" },
  };
  let providersReady = false;
  let providerReads = 0;
  let prompts = 0;
  const executor = new AutomationExecutor({
    config: serverConfig(),
    repository: fixture.repository,
    resolveWorkspace: async () => serverConfig().workspaces[0],
    createWorkspaceOpencodeClient: () => ({
      session: {
        create: async () => ({ data: { id: "scheduled-conversation" } }),
        update: async () => ({ data: true, error: undefined }),
        promptAsync: async () => {
          assert.equal(providersReady, true, "prompt must wait for provider initialization");
          prompts += 1;
          return { data: true };
        },
      },
      provider: { list: async () => {
        providerReads += 1;
        if (providerReads === 1) return { data: { all: [], connected: [], default: {} } };
        providersReady = true;
        return { data: { all: [{ id: "provider", models: { model: { id: "model" } } }], connected: ["provider"], default: {} } };
      } },
    }) as never,
    now: () => 200,
  });
  try {
    fixture.repository.createDefinition(definition, definition);
    await executor.prepareSession(definition.id, { initializeConversation: true, locale: "zh" });
    assert.equal(providerReads, 2);
    assert.equal(prompts, 1);
  } finally {
    await fixture.close();
  }
});

for (const profile of [AUTOMATION_DEFAULT_PERMISSION_PROFILE, AUTOMATION_PERMISSION_PROFILE]) {
  test(`prepared sessions use the execution model/agent/permission mapping: ${profile}`, async () => {
    const fixture = await repositoryFixture();
    const definition = { ...automationDefinition(), model: { mode: "explicit" as const, providerId: "provider", modelId: "model", variant: "thinking" }, agentId: "build", permission: { profile, acknowledgedAt: 1 } };
    const inputs: Array<Record<string, unknown>> = [];
    let failCreate = true;
    const executor = new AutomationExecutor({
      config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => ({ session: {
        create: async (input: Record<string, unknown>) => {
          inputs.push(input);
          return failCreate ? { error: { message: "unavailable" }, data: { id: "must-not-cache" } } : { data: { id: "prepared" } };
        },
      } }) as never,
    });
    try {
      fixture.repository.createDefinition(definition, definition);
      await assert.rejects(executor.prepareSession(definition.id), (error: unknown) => (error as { status: number }).status === 503);
      assert.equal(fixture.repository.getExecutionBinding(`task:${definition.id}`), null);
      failCreate = false;
      assert.equal((await executor.prepareSession(definition.id)).sessionId, "prepared");
      assert.equal(inputs.length, 2, "failed preparation must not be cached");
      assert.deepEqual(inputs[1].model, { id: "model", providerID: "provider", variant: "thinking" });
      assert.equal(inputs[1].agent, "build");
      assert.deepEqual(inputs[1].permission, profile === AUTOMATION_PERMISSION_PROFILE ? [
        { permission: "*", pattern: "*", action: "allow" }, { permission: "question", pattern: "*", action: "deny" },
      ] : undefined);
      assert.equal(fixture.repository.listRuns().items.length, 0);
    } finally { await fixture.close(); }
  });
}

test("prepare rejects event tasks and missing/deleted tasks before resolving a workspace", async () => {
  const fixture = await repositoryFixture();
  const definition = eventAutomationDefinition();
  const executor = new AutomationExecutor({ config: serverConfig(), repository: fixture.repository,
    resolveWorkspace: async () => { throw new Error("must not resolve"); },
    createWorkspaceOpencodeClient: () => { throw new Error("must not create"); },
  });
  try {
    fixture.repository.createDefinition(definition, definition);
    await assert.rejects(executor.prepareSession(definition.id), (error: unknown) => (error as { status: number }).status === 400);
    fixture.repository.tombstoneDefinition(definition.id, 1, 200);
    await assert.rejects(executor.prepareSession(definition.id), (error: unknown) => (error as { status: number }).status === 404);
    assert.deepEqual(fixture.repository.listRuns().items, []);
    assert.equal(fixture.repository.getEntitySessionMapping(definition.id, "entity"), null);
  } finally { await fixture.close(); }
});

for (const change of ["revision", "delete"] as const) {
  test(`prepare does not overwrite a binding after concurrent ${change}`, async () => {
    const fixture = await repositoryFixture();
    const definition = { ...automationDefinition(), newChatPerRun: false };
    let started!: () => void;
    let release!: () => void;
    const creating = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executor = new AutomationExecutor({ config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => ({ session: { create: async () => { started(); await gate; return { data: { id: "stale" } }; } } }) as never,
    });
    try {
      fixture.repository.createDefinition(definition, definition);
      const pending = executor.prepareSession(definition.id);
      await creating;
      if (change === "delete") fixture.repository.tombstoneDefinition(definition.id, 1, 200);
      else {
        const updated = { ...definition, revision: 2, updatedAt: 200, name: "Changed" };
        fixture.repository.updateDefinition(updated, updated, 1);
      }
      const newerBinding = { workspace: serverConfig().workspaces[0], sessionId: "newer-binding" };
      fixture.repository.setExecutionBinding(`task:${definition.id}`, newerBinding);
      release();
      await assert.rejects(pending, (error: unknown) => (error as { status: number }).status === (change === "delete" ? 404 : 409));
      assert.deepEqual(fixture.repository.getExecutionBinding(`task:${definition.id}`), newerBinding);
      assert.deepEqual(fixture.repository.listRuns().items, []);
    } finally { release(); await fixture.close(); }
  });
}

for (const lookup of ["missing", "unavailable", "throw", "busy"] as const) {
  test(`prepare handles an existing ${lookup} session without dispatch or caching errors`, async () => {
    const fixture = await repositoryFixture();
    const definition = automationDefinition();
    let creates = 0;
    const executor = new AutomationExecutor({ config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0],
      createWorkspaceOpencodeClient: () => ({ session: {
        get: async () => {
          if (lookup === "throw") throw new Error("offline");
          return lookup === "missing" ? { error: { name: "NotFoundError" } }
            : lookup === "unavailable" ? { error: { message: "offline" } } : { data: { id: "existing" } };
        },
        create: async () => { creates++; return { data: { id: "replacement" } }; },
        status: async () => { throw new Error("opening a busy conversation must not check idle or dispatch"); },
      } }) as never,
    });
    try {
      fixture.repository.createDefinition(definition, definition);
      const binding = { workspace: serverConfig().workspaces[0], sessionId: "existing" };
      fixture.repository.setExecutionBinding(`task:${definition.id}`, binding);
      if (lookup === "unavailable" || lookup === "throw") {
        await assert.rejects(executor.prepareSession(definition.id));
        await assert.rejects(executor.prepareSession(definition.id));
        assert.deepEqual(fixture.repository.getExecutionBinding(`task:${definition.id}`), binding);
      } else {
        assert.equal((await executor.prepareSession(definition.id)).sessionId, lookup === "missing" ? "replacement" : "existing");
      }
      assert.equal(creates, lookup === "missing" ? 1 : 0);
      assert.deepEqual(fixture.repository.listRuns().items, []);
    } finally { await fixture.close(); }
  });
}

test("prepare falls back from a missing latest run session to the valid task binding", async () => {
  const fixture = await repositoryFixture();
  const definition = automationDefinition();
  const reads: string[] = [];
  const executor = new AutomationExecutor({ config: serverConfig(), repository: fixture.repository,
    resolveWorkspace: async () => serverConfig().workspaces[0],
    createWorkspaceOpencodeClient: () => ({ session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        reads.push(sessionID);
        return sessionID === "gone" ? { error: { name: "NotFoundError" } } : { data: { id: sessionID } };
      },
      create: async () => { assert.fail("valid task binding should be reused"); },
    } }) as never,
  });
  try {
    fixture.repository.createDefinition(definition, definition);
    const queued = fixture.repository.createManualRun(definition, "latest-session-run", 100);
    fixture.repository.updateRun(queued.id, queued.revision, { state: "failed", sessionId: "gone", endedAt: 101 }, 101);
    fixture.repository.setExecutionBinding(`task:${definition.id}`, { workspace: serverConfig().workspaces[0], sessionId: "valid" });
    assert.deepEqual(await executor.prepareSession(definition.id), { workspaceId: "workspace", sessionId: "valid" });
    assert.deepEqual(reads, ["gone", "valid"]);
    assert.equal(fixture.repository.listRuns().items.length, 1);
  } finally { await fixture.close(); }
});

for (const first of ["open", "execute"] as const) {
  test(`concurrent open and execute share one session when ${first} starts first`, async () => {
    const fixture = await repositoryFixture();
    const definition = { ...automationDefinition(), newChatPerRun: false };
    let creates = 0;
    let prompts = 0;
    let started!: () => void;
    let release!: () => void;
    const creating = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executor = new AutomationExecutor({ config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0], wait: async () => undefined,
      createWorkspaceOpencodeClient: () => ({ session: {
        create: async () => { creates++; started(); await gate; return { data: { id: "shared" } }; },
        get: async () => ({ data: { id: "shared" } }), status: async () => ({ data: {} }), messages: async () => ({ data: [] }),
        update: async () => ({ data: true, error: undefined }),
        promptAsync: async ({ sessionID }: { sessionID: string }) => { assert.equal(sessionID, "shared"); prompts++; return { data: true }; },
      }, mcp: { status: async () => ({ data: {} }) }, tool: { ids: async () => ({ data: [] }) } }) as never,
    });
    try {
      fixture.repository.createDefinition(definition, definition);
      const run = fixture.repository.createManualRun(definition, "racing-run", 100);
      const snapshot = fixture.repository.getRunSnapshot(run.id)!;
      const firstPending = first === "open" ? executor.prepareSession(definition.id) : executor.execute(snapshot);
      await creating;
      const secondPending = first === "open" ? executor.execute(snapshot) : executor.prepareSession(definition.id);
      release();
      const result = await Promise.all([firstPending, secondPending]);
      assert.deepEqual(result[first === "open" ? 0 : 1], { workspaceId: "workspace", sessionId: "shared" });
      assert.equal(creates, 1);
      assert.equal(prompts, 1);
      assert.equal(fixture.repository.getRun(run.id)?.state, "succeeded");
      assert.equal(fixture.repository.listRuns().items.length, 1);
    } finally { release(); await fixture.close(); }
  });
}

for (const change of ["revision", "delete"] as const) {
  test(`an executing old snapshot cannot overwrite the task binding after ${change}`, async () => {
    const fixture = await repositoryFixture();
    const definition = { ...automationDefinition(), newChatPerRun: false };
    let started!: () => void;
    let release!: () => void;
    const creating = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executor = new AutomationExecutor({ config: serverConfig(), repository: fixture.repository,
      resolveWorkspace: async () => serverConfig().workspaces[0], wait: async () => undefined,
      createWorkspaceOpencodeClient: () => ({ session: {
        create: async () => { started(); await gate; return { data: { id: "old-snapshot-session" } }; },
        status: async () => ({ data: {} }), messages: async () => ({ data: [] }), promptAsync: async () => ({ data: true }),
      }, mcp: { status: async () => ({ data: {} }) }, tool: { ids: async () => ({ data: [] }) } }) as never,
    });
    try {
      fixture.repository.createDefinition(definition, definition);
      const run = fixture.repository.createManualRun(definition, "old-snapshot", 100);
      const executing = executor.execute(fixture.repository.getRunSnapshot(run.id)!);
      await creating;
      if (change === "delete") fixture.repository.tombstoneDefinition(definition.id, 1, 200);
      else {
        const updated = { ...definition, revision: 2, updatedAt: 200 };
        fixture.repository.updateDefinition(updated, updated, 1);
      }
      const binding = { workspace: serverConfig().workspaces[0], sessionId: "current-binding" };
      fixture.repository.setExecutionBinding(`task:${definition.id}`, binding);
      release();
      await executing;
      assert.deepEqual(fixture.repository.getExecutionBinding(`task:${definition.id}`), binding);
      assert.equal(fixture.repository.getRun(run.id)?.sessionId, "old-snapshot-session");
    } finally { release(); await fixture.close(); }
  });
}
