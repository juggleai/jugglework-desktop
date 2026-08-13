import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor,
  CanonicalAgentMessage,
  CanonicalAgentSession,
  CanonicalSessionSnapshot,
} from "@jugglework/types/agent-runtime";

import type { AgentEnginePort, CreateAgentSessionInput, StartAgentRunInput } from "./agent-engine/port.js";
import { AgentRuntimeRegistry } from "./agent-engine/registry.js";
import { AgentRuntimeControlPlane } from "./agent-runtime-control-plane.js";
import { AgentRuntimeRepository } from "./agent-runtime-persistence/repository.js";
import { createInteractionResolutionCoordinator } from "./interaction-resolution-coordinator.js";
import { openRuntimeSqliteDatabase, runtimeSqliteAdapter } from "./runtime-db.js";
import { createSessionMutationCoordinator } from "./session-mutation-coordinator.js";

const NOW = Date.parse("2026-08-13T00:00:00Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentRuntimeControlPlane continuation", () => {
  test("validates policy and model capabilities before persisting a current-turn audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-current-turn-control-"));
    roots.push(root);
    const repository = AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(
      await openRuntimeSqliteDatabase(join(root, "runtime.sqlite")),
    ));
    const claudeSession = session("claude-session", "claude-agent", null, "Claude");
    repository.createSession(claudeSession);
    const target = fakeEngine("claude-agent", claudeSession);
    target.descriptor.capabilities["dynamic-model"] = true;
    target.descriptor.capabilities["dynamic-effort"] = true;
    target.descriptor.capabilities["dynamic-permission-mode"] = true;
    target.descriptor.capabilities.models = true;
    target.descriptor.models.push({
      id: "claude-sonnet",
      providerId: "anthropic",
      label: "Sonnet",
      isDefault: true,
      capabilities: ["effort:high"],
    });
    let nextId = 0;
    const controlPlane = new AgentRuntimeControlPlane({
      registry: new AgentRuntimeRegistry({ engines: [fakeEngine("jugglework").engine, target.engine] }),
      repository,
      sessionMutations: createSessionMutationCoordinator({ randomUUID: () => `run-${++nextId}`, now: () => NOW }),
      interactionResolutions: createInteractionResolutionCoordinator({ now: () => NOW }),
      resolveWorkspaceContext: async () => ({ workspaceId: "workspace", directory: root }),
      isCurrentTurnControlAllowed: (_workspaceId, _runtimeId, control, value) => control !== "permissionMode" || value !== "accept-edits",
      now: () => NOW,
      randomUUID: () => `event-${++nextId}`,
    });

    await expect(controlPlane.startRun({
      workspaceId: "workspace",
      sessionId: "claude-session",
      origin: "local-renderer",
      startCommandCorrelationId: null,
      prompt: { parts: [{ type: "text", text: "private prompt" }] },
      currentTurn: { permissionMode: "accept-edits" },
    })).rejects.toMatchObject({ code: "runtime_unavailable", details: { reasonCode: "policy_denied" } });
    expect(target.runs).toHaveLength(0);

    const run = await controlPlane.startRun({
      workspaceId: "workspace",
      sessionId: "claude-session",
      origin: "local-renderer",
      startCommandCorrelationId: null,
      prompt: { parts: [{ type: "text", text: "private prompt" }] },
      currentTurn: {
        model: { providerId: "anthropic", modelId: "claude-sonnet" },
        effort: "high",
        permissionMode: "dont-ask",
      },
    });
    expect(target.runs[0]?.currentTurn).toEqual({
      model: { providerId: "anthropic", modelId: "claude-sonnet" },
      effort: "high",
      permissionMode: "dont-ask",
    });
    const audit = repository.listEvents("claude-session").find((event) => event.data.type === "run.configuration");
    expect(audit?.data).toEqual({
      type: "run.configuration",
      runId: run.runId,
      semantics: "current-turn",
      actor: "local-renderer",
      configuration: {
        model: { providerId: "anthropic", modelId: "claude-sonnet" },
        effort: "high",
        permissionMode: "dont-ask",
      },
    });
    expect(JSON.stringify(audit)).not.toContain("private prompt");
    controlPlane.close();
    repository.close();
  });

  test("rejects current-turn controls before the OpenCode adapter boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-opencode-current-turn-"));
    roots.push(root);
    const repository = AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(
      await openRuntimeSqliteDatabase(join(root, "runtime.sqlite")),
    ));
    const openCodeSession = session("open-session", "jugglework", "open-backend", "OpenCode");
    repository.createSession(openCodeSession);
    const openCode = fakeEngine("jugglework", openCodeSession);
    const controlPlane = new AgentRuntimeControlPlane({
      registry: new AgentRuntimeRegistry({ engines: [openCode.engine] }),
      repository,
      sessionMutations: createSessionMutationCoordinator({ randomUUID: () => "run-open", now: () => NOW }),
      interactionResolutions: createInteractionResolutionCoordinator({ now: () => NOW }),
      resolveWorkspaceContext: async () => ({ workspaceId: "workspace", directory: root }),
    });
    await expect(controlPlane.startRun({
      workspaceId: "workspace",
      sessionId: "open-session",
      origin: "local-renderer",
      startCommandCorrelationId: null,
      prompt: { parts: [{ type: "text", text: "hello" }] },
      currentTurn: { effort: "high" },
    })).rejects.toMatchObject({ code: "runtime_capability_unsupported" });
    expect(openCode.runs).toHaveLength(0);
    controlPlane.close();
    repository.close();
  });

  test("creates a linked target, preserves source history, and injects reviewed context only on the first target run", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-continuation-control-plane-"));
    roots.push(root);
    const database = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
    const repository = AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(database));
    const sourceSession = session("source", "jugglework", "source-backend", "Source");
    const sourceMessage = textMessage("source", "source-message", "user", "Build the continuation API");
    repository.createSession(sourceSession);
    repository.putMessage(sourceMessage);
    const source = fakeEngine("jugglework", sourceSession, [sourceMessage]);
    const target = fakeEngine("claude-agent");
    let nextId = 0;
    const mutations = createSessionMutationCoordinator({ randomUUID: () => `run-${++nextId}`, now: () => NOW + nextId });
    const controlPlane = new AgentRuntimeControlPlane({
      registry: new AgentRuntimeRegistry({ engines: [source.engine, target.engine] }),
      repository,
      sessionMutations: mutations,
      interactionResolutions: createInteractionResolutionCoordinator({ now: () => NOW }),
      resolveWorkspaceContext: async () => ({ workspaceId: "workspace", directory: root }),
      now: () => NOW + 100,
      randomUUID: () => `target-${++nextId}`,
    });

    const preview = await controlPlane.previewContinuation({
      workspaceId: "workspace",
      sourceSessionId: "source",
      targetRuntimeId: "claude-agent",
    });
    const result = await controlPlane.continueSession({
      workspaceId: "workspace",
      sourceSessionId: "source",
      targetRuntimeId: "claude-agent",
      context: { ...preview.context, summary: "Reviewed summary" },
    });

    expect(repository.buildSnapshot("source").messages).toEqual([sourceMessage]);
    expect(controlPlane.sessionLinks("workspace", "source")).toEqual([result.link]);
    expect(controlPlane.sessionLinks("workspace", result.session.id)).toEqual([result.link]);
    expect(result.link).toMatchObject({ sourceSessionId: "source", targetSessionId: result.session.id, type: "migration" });
    expect(result.link.contextDigest).toMatch(/^[a-f0-9]{64}$/);

    const first = await controlPlane.startRun({
      workspaceId: "workspace",
      sessionId: result.session.id,
      origin: "local-renderer",
      startCommandCorrelationId: null,
      prompt: { parts: [{ type: "text", text: "Continue now" }] },
    });
    expect(target.runs[0]?.prompt).toEqual({ parts: [
      expect.objectContaining({ type: "text", text: expect.stringContaining("Reviewed summary") }),
      { type: "text", text: "Continue now" },
    ] });
    controlPlane.observeRun({ workspaceId: "workspace", sessionId: result.session.id, runId: first.runId, status: "completed" });

    await controlPlane.startRun({
      workspaceId: "workspace",
      sessionId: result.session.id,
      origin: "local-renderer",
      startCommandCorrelationId: null,
      prompt: { parts: [{ type: "text", text: "Second turn" }] },
    });
    expect(target.runs[1]?.prompt).toEqual({ parts: [{ type: "text", text: "Second turn" }] });
    controlPlane.close();
    repository.close();
  });

  test("requires explicit retry confirmation for a durable ambiguous interruption after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-ambiguous-restart-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    const database = await openRuntimeSqliteDatabase(path);
    const repository = AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(database));
    repository.createSession({
      ...session("claude-session", "claude-agent", "10000000-0000-4000-8000-000000000001", "Interrupted"),
      status: { type: "interrupted", ambiguous: true, message: "A tool may have changed external state." },
    });
    repository.close();

    const reopenedDatabase = await openRuntimeSqliteDatabase(path);
    const reopened = AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(reopenedDatabase));
    const target = fakeEngine("claude-agent");
    const controlPlane = new AgentRuntimeControlPlane({
      registry: new AgentRuntimeRegistry({ engines: [fakeEngine("jugglework").engine, target.engine] }),
      repository: reopened,
      sessionMutations: createSessionMutationCoordinator({ randomUUID: () => "retry-run", now: () => NOW + 1 }),
      interactionResolutions: createInteractionResolutionCoordinator({ now: () => NOW }),
      resolveWorkspaceContext: async () => ({ workspaceId: "workspace", directory: root }),
      now: () => NOW + 100,
      randomUUID: () => "event-id",
    });

    await expect(controlPlane.startRun({
      workspaceId: "workspace",
      sessionId: "claude-session",
      origin: "local-renderer",
      startCommandCorrelationId: null,
      prompt: { parts: [{ type: "text", text: "retry" }] },
    })).rejects.toMatchObject({ code: "runtime_retry_confirmation_required" });
    expect(target.runs).toHaveLength(0);
    // Queue/background admission remains blocked so only the explicit run path
    // carrying confirmation can resume this session.
    await expect(controlPlane.sessionActivity("workspace", "claude-session")).resolves.toBe("busy");

    await expect(controlPlane.startRun({
      workspaceId: "workspace",
      sessionId: "claude-session",
      origin: "local-renderer",
      startCommandCorrelationId: null,
      prompt: { parts: [{ type: "text", text: "retry" }] },
      confirmAmbiguousRetry: true,
    })).resolves.toMatchObject({ runId: "retry-run" });
    expect(target.runs).toHaveLength(1);
    controlPlane.close();
    reopened.close();
  });
});

const capabilities: AgentRuntimeCapabilities = {
  models: false,
  variants: false,
  "reasoning-stream": false,
  commands: false,
  shell: false,
  compact: false,
  resume: true,
  fork: false,
  steer: false,
  enqueue: false,
  permissions: false,
  questions: false,
  todos: false,
  mcp: false,
  subagents: false,
  "file-checkpointing": false,
  "usage-and-cost": false,
  prewarm: false,
  "resident-session": false,
  "plan-mode": false,
  rewind: false,
  "dynamic-model": false,
  "dynamic-effort": false,
  "dynamic-permission-mode": false,
};

function fakeEngine(runtimeId: string, initial?: CanonicalAgentSession, messages: CanonicalAgentMessage[] = []) {
  const sessions = new Map<string, CanonicalAgentSession>(initial ? [[initial.id, initial]] : []);
  const runs: StartAgentRunInput[] = [];
  const descriptor: AgentRuntimeDescriptor = {
    schemaVersion: 1,
    id: runtimeId,
    engine: "test",
    label: runtimeId,
    isDefault: runtimeId === "jugglework",
    capabilities: { ...capabilities },
    health: { status: "healthy", checkedAt: NOW, reasonCode: null, message: null },
    models: [],
  };
  const engine: AgentEnginePort = {
    runtimeId,
    descriptor: async () => descriptor,
    health: async () => descriptor.health,
    listModels: async () => [],
    createSession: async (input: CreateAgentSessionInput) => {
      const created = session(input.sessionId, runtimeId, null, input.title, input.directory, input.configuration as CanonicalAgentSession["configuration"]);
      sessions.set(created.id, created);
      return created;
    },
    restoreSession: (restored) => { sessions.set(restored.id, restored); },
    listSessions: async () => [...sessions.values()],
    readSession: async ({ sessionId }) => sessions.get(sessionId)!,
    readMessages: async ({ sessionId }) => sessionId === initial?.id ? messages : [],
    readSnapshot: async ({ sessionId }) => snapshot(sessions.get(sessionId)!, sessionId === initial?.id ? messages : []),
    startRun: async (input) => { runs.push(input); },
    abortRun: async () => undefined,
    subscribeEvents: async function* () {},
    resolveInteraction: async () => undefined,
    reloadConfiguration: async () => undefined,
    registerMcp: async () => undefined,
    disconnectMcp: async () => undefined,
    dispose: async () => undefined,
  };
  return { engine, runs, descriptor };
}

function session(
  id: string,
  runtimeId: string,
  backendSessionId: string | null,
  title: string,
  canonicalCwd = "/workspace",
  configuration: CanonicalAgentSession["configuration"] = {},
): CanonicalAgentSession {
  return {
    id,
    workspaceId: "workspace",
    runtimeId,
    backendSessionId,
    title,
    canonicalCwd,
    status: { type: "idle" },
    configuration,
    createdAt: NOW,
    updatedAt: NOW,
    lastError: null,
  };
}

function textMessage(sessionId: string, id: string, role: "user" | "assistant", text: string): CanonicalAgentMessage {
  return {
    id,
    sessionId,
    role,
    parentId: null,
    createdAt: NOW,
    completedAt: NOW,
    parts: [{ id: `${id}:text`, messageId: id, sessionId, ordinal: 0, createdAt: NOW, updatedAt: NOW, type: "text", text, state: "complete" }],
  };
}

function snapshot(value: CanonicalAgentSession, messages: CanonicalAgentMessage[]): CanonicalSessionSnapshot {
  return { schemaVersion: 1, session: value, messages, todos: [], interactions: [], latestSequence: 0 };
}
