import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalAgentEventSchema,
  canonicalSessionSnapshotSchema,
  type CanonicalAgentEvent,
} from "@jugglework/types/agent-runtime";

import eventsFixture from "./fixtures/claude-worker-events.json" with { type: "json" };
import { ClaudeWorkerClientError } from "../claude-worker-client.js";
import { ClaudeAgentEngineAdapter, type ClaudeWorkerApi } from "./claude-adapter.js";
import { ClaudeAdvancedRollout } from "../claude-advanced-rollout.js";
import { verifyCommonAgentEngineContract } from "./contract-test-support.js";

type Call = { method: string; input?: unknown };

function recordedWorker(events: unknown[] = eventsFixture): { worker: ClaudeWorkerApi; calls: Call[] } {
  const calls: Call[] = [];
  const worker: ClaudeWorkerApi = {
    health: async () => ({
      status: "healthy",
      checkedAt: "2026-08-13T10:00:00.000Z",
      reasonCode: "worker_ready",
      message: "ready",
    }),
    capabilities: async () => ({
      protocolVersion: 1,
      sdkVersion: "0.3.226",
      cliVersion: "2.1.226 (Claude Code)",
      nodeVersion: "24.0.0",
      transport: "loopback-http",
      limits: {
        maxHeaderBytes: 16_384,
        maxRequestBytes: 262_144,
        maxEventBytes: 65_536,
        maxRetainedEvents: 1_000,
      },
      operations: {
        health: true,
        capabilities: true,
        events: true,
        shutdown: true,
        run: true,
        abort: true,
        interactions: true,
        configurationRefresh: true,
        currentTurnConfiguration: true,
        stopSubagent: true,
        nativeFork: true,
      },
      advanced: {
        subagentProjection: true,
        subagentProgress: true,
        subagentStop: true,
        planMode: true,
        fileCheckpointing: false,
        rewind: false,
        nativeFork: true,
        partialFallback: true,
        filesystemState: "shared-working-tree",
        prewarm: true,
        residentSession: true,
        protocolInterrupt: true,
        queuedInput: true,
        steer: true,
        dynamicModel: true,
        dynamicEffort: true,
        dynamicPermissionMode: true,
      },
      sandbox: {
        supported: true,
        enabled: true,
        failClosed: true,
        allowUnsandboxedCommands: false,
        backend: "seatbelt",
        reasonCode: "sandbox_supported",
      },
    }),
    run: async (input) => {
      calls.push({ method: "run", input });
      return { accepted: true, runId: input.runId, status: "starting", backendSessionId: "claude-backend-session" };
    },
    abort: async (sessionId, runId) => { calls.push({ method: "abort", input: { sessionId, runId } }); },
    stopSubagent: async (sessionId, runId, taskId) => { calls.push({ method: "stopSubagent", input: { sessionId, runId, taskId } }); },
    forkSession: async (input) => ({
      accepted: true,
      backendSessionId: "20000000-0000-4000-8000-000000000002",
      filesystemState: {
        sharedWorkingTree: true,
        checkpointHistoryCopied: false,
        filesRewound: false,
        warning: "fixture",
      },
    }),
    events: async function* () {
      for (const event of events) yield event as never;
    },
    resolveInteraction: async (interactionId, sessionId, runId, resolution) => {
      calls.push({ method: "resolveInteraction", input: { interactionId, sessionId, runId, resolution } });
    },
    refreshConfiguration: async (configuration) => {
      calls.push({ method: "refreshConfiguration", input: configuration });
    },
  };
  return { worker, calls };
}

async function collectEvents(
  adapter: ClaudeAgentEngineAdapter,
  context = { workspaceId: "workspace-a", directory: "/workspace" },
): Promise<CanonicalAgentEvent[]> {
  const events: CanonicalAgentEvent[] = [];
  for await (const event of adapter.subscribeEvents(context)) {
    events.push(event);
  }
  return events;
}

describe("ClaudeAgentEngineAdapter common contract", () => {
  test("falls back to baseline create, resume, stream, approve, and abort when every advanced feature is off", async () => {
    const { worker, calls } = recordedWorker(eventsFixture.map((event) => {
      if (event.type !== "agent.event") return event;
      const data = (event.payload as { data?: { interaction?: Record<string, unknown> } }).data;
      if (!data?.interaction) return event;
      return {
        ...event,
        payload: {
          ...event.payload,
          data: {
            ...data,
            interaction: { ...data.interaction, runId: "run-baseline" },
          },
        },
      };
    }));
    const adapter = new ClaudeAgentEngineAdapter({
      getClient: () => worker,
      models: [{ id: "claude-sonnet", providerId: "anthropic", label: "Sonnet", isDefault: true, capabilities: [] }],
      advancedRollout: new ClaudeAdvancedRollout({ env: {} }),
      now: () => 1_000,
    });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    const descriptor = await adapter.descriptor();
    expect(descriptor.capabilities).toMatchObject({
      resume: true,
      prewarm: false,
      "resident-session": false,
      steer: false,
      subagents: false,
      fork: false,
      "plan-mode": false,
      "dynamic-model": false,
    });
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Baseline", configuration: {} });
    await adapter.startRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: null,
      runId: "run-baseline",
      prompt: { parts: [{ type: "text", text: "baseline" }] },
    });
    const events = await collectEvents(adapter, context);
    expect(events.some(({ data }) => data.type === "message.updated")).toBe(true);
    await adapter.resolveInteraction({
      ...context,
      sessionId: "public-session",
      backendSessionId: "claude-backend-session",
      interactionId: "claude-interaction-one",
      resolution: { outcome: "allow" },
    });
    await adapter.abortRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: "claude-backend-session",
      runId: "run-baseline",
    });
    expect(calls.map(({ method }) => method)).toEqual(expect.arrayContaining(["run", "resolveInteraction", "abort"]));
  });

  test("advertises and forwards current-turn controls to Claude only", async () => {
    const { worker, calls } = recordedWorker([]);
    const adapter = new ClaudeAgentEngineAdapter({
      getClient: () => worker,
      models: [{ id: "claude-sonnet", providerId: "anthropic", label: "Sonnet", isDefault: true, capabilities: ["effort:high"] }],
      now: () => 1_000,
    });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    expect(await adapter.descriptor()).toMatchObject({ capabilities: {
      "dynamic-model": true,
      "dynamic-effort": true,
      "dynamic-permission-mode": true,
    } });
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Claude", configuration: {} });
    await adapter.startRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: null,
      runId: "run-dynamic",
      prompt: { parts: [{ type: "text", text: "hello" }] },
      currentTurn: {
        model: { providerId: "anthropic", modelId: "claude-sonnet" },
        effort: "high",
        permissionMode: "accept-edits",
      },
    });
    expect(calls.find(({ method }) => method === "run")?.input).toMatchObject({
      model: "claude-sonnet",
      effort: "high",
      permissionMode: "acceptEdits",
    });
  });

  test("passes the common engine contract against recorded worker behavior", async () => {
    const { worker, calls } = recordedWorker([]);
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, now: () => 1_000 });
    await verifyCommonAgentEngineContract({
      engine: adapter,
      context: { workspaceId: "workspace-a", directory: "/workspace" },
      expectedRuntimeId: "claude-agent",
      expectedBackendSessionId: "claude-backend-session",
    });
    expect(calls).toContainEqual({ method: "abort", input: { sessionId: "public-session", runId: "run-one" } });
  });

  test("maps worker fixture events into canonical state and events", async () => {
    const { worker, calls } = recordedWorker();
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, now: () => 1_000 });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    await adapter.createSession({
      ...context,
      sessionId: "public-session",
      title: "Claude fixture",
      configuration: { model: "claude-sonnet" },
    });
    await adapter.startRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: null,
      runId: "run-one",
      prompt: { parts: [{ type: "text", text: "hello" }] },
    });

    const events = await collectEvents(adapter);
    events.forEach((event) => canonicalAgentEventSchema.parse(event));
    expect(events.map(({ data }) => data.type)).toEqual([
      "session.status",
      "message.updated",
      "message.part.updated",
      "interaction.requested",
      "run.usage",
      "run.completed",
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(canonicalSessionSnapshotSchema.parse(await adapter.readSnapshot({
      ...context,
      sessionId: "public-session",
      backendSessionId: "claude-backend-session",
    }))).toMatchObject({
      session: { backendSessionId: "claude-backend-session", status: { type: "idle" } },
      messages: [{ id: "claude-message-one", parts: [{ text: "Hello from Claude" }, { toolCallId: "claude-tool-call", state: "waiting" }] }],
      interactions: [{ id: "claude-interaction-one", state: "pending" }],
      latestSequence: 6,
    });
    expect(calls.find(({ method }) => method === "run")?.input).toMatchObject({
      cwd: "/workspace",
      backendSessionId: null,
      delivery: "start",
    });
  });

  test("does not resurrect a run that completes before the start response", async () => {
    let releaseRun!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    let releaseEvents!: () => void;
    const eventsGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const { worker } = recordedWorker([]);
    worker.run = async (input) => {
      releaseEvents();
      await responseGate;
      return { accepted: true, runId: input.runId, status: "starting", backendSessionId: "claude-backend-session" };
    };
    worker.events = async function* () {
      await eventsGate;
      yield {
        protocolVersion: 1,
        sequence: 1,
        id: "early-complete",
        type: "run.completed",
        createdAt: "2026-08-13T10:00:00.000Z",
        payload: {
          workspaceId: "workspace-a",
          sessionId: "public-session",
          runId: "run-one",
          backendSessionId: "claude-backend-session",
        },
      };
    };
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, now: () => 1_000 });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Claude", configuration: {} });
    const events = collectEvents(adapter, context);
    const starting = adapter.startRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: null,
      runId: "run-one",
      prompt: { parts: [{ type: "text", text: "hello" }] },
    });
    await events;
    releaseRun();
    await starting;
    expect(await adapter.readSession({ ...context, sessionId: "public-session" })).toMatchObject({
      backendSessionId: "claude-backend-session",
      status: { type: "idle" },
    });
  });

  test("forwards a canonical interaction exactly once with its owning run", async () => {
    const { worker, calls } = recordedWorker();
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, now: () => 1_000 });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Claude", configuration: {} });
    await adapter.startRun({ ...context, sessionId: "public-session", backendSessionId: null, runId: "run-one", prompt: { parts: [{ type: "text", text: "hello" }] } });
    await collectEvents(adapter);
    await adapter.resolveInteraction({
      ...context,
      sessionId: "public-session",
      backendSessionId: "claude-backend-session",
      interactionId: "claude-interaction-one",
      resolution: { outcome: "allow" },
    });
    expect(calls).toContainEqual({
      method: "resolveInteraction",
      input: {
        interactionId: "claude-interaction-one",
        sessionId: "public-session",
        runId: "run-one",
        resolution: { outcome: "allow" },
      },
    });
  });

  test("reports unsupported steering and MCP with stable errors", async () => {
    const { worker } = recordedWorker([]);
    const capabilities = worker.capabilities;
    worker.capabilities = async () => {
      const value = await capabilities();
      return { ...value, advanced: { ...value.advanced, steer: false } };
    };
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Claude", configuration: {} });
    await expect(adapter.startRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: null,
      runId: "run-one",
      prompt: {},
      delivery: "steer",
    })).rejects.toMatchObject({ code: "runtime_capability_unsupported", details: { capability: "steer" } });
    await expect(adapter.registerMcp(context, "demo", {})).rejects.toMatchObject({
      code: "runtime_capability_unsupported",
      details: { capability: "mcp" },
    });
  });

  test("advertises detected advanced capabilities and explicit filesystem fallbacks", async () => {
    const { worker } = recordedWorker([]);
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker });
    const descriptor = await adapter.descriptor();
    expect(descriptor.capabilities).toMatchObject({ subagents: true, fork: true, "plan-mode": true, "file-checkpointing": false, rewind: false });
    expect(descriptor.limitations).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "file-checkpointing", code: "run_per_query_no_checkpoint_handle" }),
      expect.objectContaining({ capability: "rewind", code: "filesystem_rewind_unavailable" }),
      expect.objectContaining({ capability: "fork", code: "shared_working_tree" }),
    ]));
  });

  test("classifies transport loss before tools as safe and after a mutating tool as ambiguous", async () => {
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    for (const [marker, expected] of [[false, false], [true, true]] as const) {
      const { worker } = recordedWorker([]);
      worker.events = async function* () {
        if (marker) {
          yield {
            protocolVersion: 1,
            sequence: 1,
            id: "mutation-marker",
            type: "run.mutation.possible",
            createdAt: "2026-08-13T10:00:00.000Z",
            payload: { workspaceId: "workspace-a", sessionId: "public-session", runId: "run-one", toolName: "Write" },
          };
        }
        throw new Error("transport lost");
      };
      const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, now: () => 1_000 });
      await adapter.createSession({ ...context, sessionId: "public-session", title: "Claude", configuration: {} });
      await adapter.startRun({
        ...context,
        sessionId: "public-session",
        backendSessionId: null,
        runId: "run-one",
        prompt: { parts: [{ type: "text", text: "hello" }] },
      });
      const events: CanonicalAgentEvent[] = [];
      await expect(async () => {
        for await (const event of adapter.subscribeEvents(context)) events.push(event);
      }).toThrow("Claude Agent event subscription failed");
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toMatchObject({
        type: "run.failed",
        code: expected ? "worker_transport_lost_ambiguous" : "worker_transport_lost_safe",
        retryable: !expected,
      });
      expect((await adapter.readSession({ ...context, sessionId: "public-session" })).status).toMatchObject({
        type: "interrupted",
        ambiguous: expected,
      });
    }
  });

  test("preserves completed output and never retries a turn during a network outage", async () => {
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    const completedMessage = eventsFixture.find((event) =>
      (event.payload as { data?: { type?: string } }).data?.type === "message.updated");
    const { worker, calls } = recordedWorker([]);
    worker.events = async function* () {
      yield completedMessage as never;
      throw new ClaudeWorkerClientError("request_failed", "fixture network outage");
    };
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, now: () => 1_000 });
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Claude", configuration: {} });
    await adapter.startRun({
      ...context,
      sessionId: "public-session",
      backendSessionId: null,
      runId: "run-one",
      prompt: { parts: [{ type: "text", text: "hello" }] },
    });
    const events: CanonicalAgentEvent[] = [];
    await expect(async () => {
      for await (const event of adapter.subscribeEvents(context)) events.push(event);
    }).toThrow("Claude Agent event subscription failed");

    expect(events.map(({ data }) => data.type)).toEqual(["message.updated", "run.failed"]);
    expect((await adapter.readMessages({ ...context, sessionId: "public-session" }))[0]?.parts[0])
      .toMatchObject({ type: "text", text: "Hello from Claude" });
    expect(calls.filter(({ method }) => method === "run")).toHaveLength(1);
    expect((await adapter.readSession({ ...context, sessionId: "public-session" })).status)
      .toMatchObject({ type: "interrupted", ambiguous: false });
  });

  test("treats a lost run-start response as ambiguous but pre-dispatch ownership loss as safe", async () => {
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    for (const [code, ambiguous] of [["request_failed", true], ["ownership_lost", false]] as const) {
      const { worker } = recordedWorker([]);
      worker.run = async () => {
        throw new ClaudeWorkerClientError(code, code);
      };
      const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, now: () => 1_000 });
      await adapter.createSession({ ...context, sessionId: "public-session", title: "Claude", configuration: {} });
      await expect(adapter.startRun({
        ...context,
        sessionId: "public-session",
        backendSessionId: null,
        runId: "run-one",
        prompt: { parts: [{ type: "text", text: "hello" }] },
      })).rejects.toMatchObject(ambiguous
        ? { code: "runtime_request_failed", details: { interruptedAmbiguous: true } }
        : { code: "runtime_unavailable" });
      expect((await adapter.readSession({ ...context, sessionId: "public-session" })).status).toMatchObject(
        ambiguous ? { type: "interrupted", ambiguous: true } : { type: "idle" },
      );
    }
  });

  test("replaces the approved MCP snapshot and releases superseded credentials", async () => {
    const { worker, calls } = recordedWorker([]);
    let revision = 0;
    const released: number[] = [];
    const adapter = new ClaudeAgentEngineAdapter({
      getClient: () => worker,
      resolveMcpConfiguration: async (context) => {
        revision += 1;
        const current = revision;
        const servers: Record<string, { type: "http" | "sse"; url: string }> = current === 1
          ? { allowed: { type: "http", url: "https://allowed.example/mcp" } }
          : {};
        return {
          configuration: {
            workspaceId: context.workspaceId,
            revision: current,
            generatedAt: 1_000 + current,
            servers,
          },
          release: () => { released.push(current); },
        };
      },
    });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    await adapter.registerMcp(context, "allowed", {});
    await adapter.disconnectMcp(context, "allowed");
    expect(calls.filter(({ method }) => method === "refreshConfiguration").map(({ input }) => input)).toEqual([
      expect.objectContaining({ workspaceId: "workspace-a", revision: 1, servers: { allowed: expect.anything() } }),
      expect.objectContaining({ workspaceId: "workspace-a", revision: 2, servers: {} }),
    ]);
    expect(released).toEqual([1]);
    await adapter.dispose();
    expect(released).toEqual([1, 2]);
  });

  test("answers worker PreToolUse policy requests with canonicalized, narrowed input", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-adapter-policy-"));
    try {
      await writeFile(join(root, "README.md"), "safe");
      const canonicalRoot = await realpath(root);
      const event = {
        protocolVersion: 1,
        sequence: 1,
        id: "policy-event",
        type: "tool.policy.requested",
        createdAt: "2026-08-13T10:00:00.000Z",
        payload: {
          workspaceId: "workspace-a",
          sessionId: "public-session",
          runId: "run-one",
          requestId: "policy-request",
          toolName: "Read",
          toolUseId: "tool-read",
          enforcementPoint: "pre_tool_hook",
          input: { file_path: "README.md", ignored: true },
        },
      };
      const { worker, calls } = recordedWorker([event]);
      const adapter = new ClaudeAgentEngineAdapter({
        getClient: () => worker,
        authorizedRoots: [root],
      });
      const context = { workspaceId: "workspace-a", directory: root };
      await adapter.createSession({ ...context, sessionId: "public-session", title: "Claude", configuration: {} });
      await collectEvents(adapter, context);
      expect(calls).toContainEqual({
        method: "resolveInteraction",
        input: {
          interactionId: "policy-request",
          sessionId: "public-session",
          runId: "run-one",
          resolution: { outcome: "allow", updatedInput: { file_path: join(canonicalRoot, "README.md") } },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isolates and deduplicates worker policy events across workspace subscriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-adapter-policy-"));
    try {
      await writeFile(join(root, "README.md"), "safe");
      const event = {
        protocolVersion: 1,
        sequence: 1,
        id: "policy-event-once",
        type: "tool.policy.requested",
        createdAt: "2026-08-13T10:00:00.000Z",
        payload: {
          workspaceId: "workspace-a",
          sessionId: "public-session",
          runId: "run-one",
          requestId: "policy-request-once",
          toolName: "Read",
          toolUseId: "tool-read",
          enforcementPoint: "pre_tool_hook",
          input: { file_path: "README.md" },
        },
      };
      const { worker, calls } = recordedWorker([event]);
      const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, authorizedRoots: [root] });
      await adapter.createSession({ workspaceId: "workspace-a", directory: root, sessionId: "public-session", title: "Claude", configuration: {} });

      await collectEvents(adapter, { workspaceId: "workspace-b", directory: root });
      expect(calls.filter(({ method }) => method === "resolveInteraction")).toHaveLength(0);
      await collectEvents(adapter, { workspaceId: "workspace-a", directory: root });
      await collectEvents(adapter, { workspaceId: "workspace-a", directory: root });
      expect(calls.filter(({ method }) => method === "resolveInteraction")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for unknown tools and unsupported sandbox hosts", async () => {
    const { worker, calls } = recordedWorker([{
      protocolVersion: 1,
      sequence: 1,
      id: "unknown-policy-event",
      type: "tool.policy.requested",
      createdAt: "2026-08-13T10:00:00.000Z",
      payload: {
        workspaceId: "workspace-a",
        sessionId: "public-session",
        runId: "run-one",
        requestId: "unknown-policy-request",
        toolName: "UnregisteredTool",
        toolUseId: "tool-unknown",
        input: {},
      },
    }]);
    const originalCapabilities = worker.capabilities;
    worker.capabilities = async () => ({
      ...await originalCapabilities(),
      sandbox: {
        supported: false,
        enabled: false,
        failClosed: true,
        allowUnsandboxedCommands: false,
        backend: "unsupported",
        reasonCode: "sandbox_unsupported_host",
      },
    });
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, authorizedRoots: ["/workspace"] });
    const context = { workspaceId: "workspace-a", directory: "/workspace" };
    await adapter.createSession({ ...context, sessionId: "public-session", title: "Claude", configuration: {} });
    await collectEvents(adapter);
    expect(calls.find(({ method }) => method === "resolveInteraction")?.input).toMatchObject({
      resolution: { outcome: "deny", reason: "Claude tool is not registered with mandatory policy" },
    });
    expect(await adapter.health()).toMatchObject({ status: "unavailable", reasonCode: "sandbox_unsupported_host" });
  });

  test("fails closed for Bash because shell capability is not advertised", async () => {
    const { worker, calls } = recordedWorker([{
      protocolVersion: 1,
      sequence: 1,
      id: "bash-policy-event",
      type: "tool.policy.requested",
      createdAt: "2026-08-13T10:00:00.000Z",
      payload: {
        workspaceId: "workspace-a",
        sessionId: "public-session",
        runId: "run-one",
        requestId: "bash-policy-request",
        toolName: "Bash",
        toolUseId: "tool-bash",
        input: { command: "python -c 'print(open(\"/private/file\").read())'" },
      },
    }]);
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => worker, authorizedRoots: ["/workspace"] });
    await adapter.createSession({ workspaceId: "workspace-a", directory: "/workspace", sessionId: "public-session", title: "Claude", configuration: {} });
    await collectEvents(adapter);
    expect(calls.find(({ method }) => method === "resolveInteraction")?.input).toMatchObject({
      resolution: { outcome: "deny", reason: "Claude tool is not registered with mandatory policy" },
    });
  });
});
