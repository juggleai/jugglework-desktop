import { randomUUID } from "node:crypto";
import type {
  AgentContinuationContext,
  AgentContinuationPreview,
  AgentContinuationResult,
  AgentRuntimeDescriptor,
  AgentRuntimeHealth,
  AgentRuntimeModel,
  AgentRuntimeCurrentTurnConfiguration,
  CanonicalSessionLink,
  CanonicalAgentEvent,
  CanonicalAgentEventData,
  CanonicalAgentSession,
  CanonicalInteraction,
  CanonicalInteractionResolution,
  CanonicalSessionSnapshot,
} from "@jugglework/types/agent-runtime";
import {
  agentRuntimeAdapterConfiguration,
  classifyAgentRuntimeDiagnostic,
  validateAgentRuntimeSessionConfiguration,
} from "@jugglework/types/agent-runtime";

import { AgentEngineError } from "./agent-engine/errors.js";
import type { AgentEngineContext, AgentEnginePort } from "./agent-engine/port.js";
import type { AgentRuntimeRegistry } from "./agent-engine/registry.js";
import type { AgentRuntimeRepository } from "./agent-runtime-persistence/repository.js";
import {
  AgentContinuationError,
  buildAgentContinuationPreview,
  digestAgentContinuation,
  validateAgentContinuationContext,
} from "./agent-runtime-continuation.js";
import { InteractionResolutionError, type InteractionResolutionCoordinator } from "./interaction-resolution-coordinator.js";
import type {
  SessionMutationCoordinator,
  SessionMutationObservationStatus,
  SessionMutationOrigin,
} from "./session-mutation-coordinator.js";
import { SessionMutationError } from "./session-mutation-coordinator.js";
import type { AgentRuntimeTelemetry } from "./agent-runtime-telemetry.js";

type WorkspaceContext = AgentEngineContext;
type EventListener = (event: CanonicalAgentEvent) => void;

function diagnosticHealth(health: AgentRuntimeHealth): AgentRuntimeHealth {
  if (!health.reasonCode) return health;
  return {
    ...health,
    details: { category: classifyAgentRuntimeDiagnostic(health.reasonCode) },
  };
}

function withDiagnosticCategory(descriptor: AgentRuntimeDescriptor): AgentRuntimeDescriptor {
  return { ...descriptor, health: diagnosticHealth(descriptor.health) };
}

export interface AgentRuntimeControlPlaneOptions {
  registry: AgentRuntimeRegistry;
  repository: AgentRuntimeRepository;
  sessionMutations: SessionMutationCoordinator;
  interactionResolutions: InteractionResolutionCoordinator;
  resolveWorkspaceContext: (workspaceId: string) => Promise<WorkspaceContext>;
  isRuntimeAllowed?: (workspaceId: string, runtimeId: string) => boolean | Promise<boolean>;
  isCurrentTurnControlAllowed?: (
    workspaceId: string,
    runtimeId: string,
    control: "model" | "effort" | "permissionMode" | "planMode",
    value: string,
  ) => boolean | Promise<boolean>;
  now?: () => number;
  randomUUID?: () => string;
  telemetry?: AgentRuntimeTelemetry;
}

export class AgentRuntimeControlPlane {
  readonly #registry: AgentRuntimeRegistry;
  readonly #repository: AgentRuntimeRepository;
  readonly #sessionMutations: SessionMutationCoordinator;
  readonly #interactionResolutions: InteractionResolutionCoordinator;
  readonly #resolveWorkspaceContext: AgentRuntimeControlPlaneOptions["resolveWorkspaceContext"];
  readonly #isRuntimeAllowed: NonNullable<AgentRuntimeControlPlaneOptions["isRuntimeAllowed"]>;
  readonly #isCurrentTurnControlAllowed: NonNullable<AgentRuntimeControlPlaneOptions["isCurrentTurnControlAllowed"]>;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #telemetry?: AgentRuntimeTelemetry;
  readonly #listeners = new Map<string, Set<EventListener>>();
  readonly #eventPumps = new Map<string, AbortController>();

  constructor(options: AgentRuntimeControlPlaneOptions) {
    this.#registry = options.registry;
    this.#repository = options.repository;
    this.#sessionMutations = options.sessionMutations;
    this.#interactionResolutions = options.interactionResolutions;
    this.#resolveWorkspaceContext = options.resolveWorkspaceContext;
    this.#isRuntimeAllowed = options.isRuntimeAllowed ?? (() => true);
    this.#isCurrentTurnControlAllowed = options.isCurrentTurnControlAllowed ?? (() => true);
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#telemetry = options.telemetry;
  }

  async listRuntimes(workspaceId: string, options: { availableOnly?: boolean } = {}): Promise<AgentRuntimeDescriptor[]> {
    const descriptors = await this.#registry.descriptors();
    const result: AgentRuntimeDescriptor[] = [];
    for (const descriptor of descriptors) {
      if (!await this.#isRuntimeAllowed(workspaceId, descriptor.id)) continue;
      if (options.availableOnly && !isAvailable(descriptor.health)) continue;
      result.push(withDiagnosticCategory(descriptor));
    }
    return result;
  }

  async runtime(workspaceId: string, runtimeId: string): Promise<AgentRuntimeDescriptor> {
    await this.#requireAllowed(workspaceId, runtimeId);
    return withDiagnosticCategory(await this.#registry.resolve(runtimeId).descriptor());
  }

  async runtimeHealth(workspaceId: string, runtimeId: string): Promise<AgentRuntimeHealth> {
    await this.#requireAllowed(workspaceId, runtimeId);
    return diagnosticHealth(await this.#registry.resolve(runtimeId).health());
  }

  async runtimeModels(workspaceId: string, runtimeId: string): Promise<AgentRuntimeModel[]> {
    await this.#requireAllowed(workspaceId, runtimeId);
    const context = await this.#resolveWorkspaceContext(workspaceId);
    return (await this.#registry.requireAvailable(runtimeId)).listModels(context);
  }

  async runtimeAgentProfiles(workspaceId: string, runtimeId = this.#registry.defaultRuntimeId) {
    const context = await this.#resolveWorkspaceContext(workspaceId);
    const engine = await this.#registry.requireAvailable(runtimeId);
    return engine.listAgentProfiles ? engine.listAgentProfiles(context) : [];
  }

  async runtimeSkills(workspaceId: string, runtimeId = this.#registry.defaultRuntimeId) {
    const context = await this.#resolveWorkspaceContext(workspaceId);
    const engine = await this.#registry.requireAvailable(runtimeId);
    return engine.listSkills ? engine.listSkills(context) : [];
  }

  async runtimeTools(workspaceId: string, runtimeId = this.#registry.defaultRuntimeId) {
    const context = await this.#resolveWorkspaceContext(workspaceId);
    const engine = await this.#registry.requireAvailable(runtimeId);
    return engine.listTools ? engine.listTools(context) : [];
  }

  async createSession(input: {
    workspaceId: string;
    runtimeId?: string | null;
    title: string;
    configuration?: CanonicalAgentSession["configuration"];
  }): Promise<CanonicalAgentSession> {
    const runtimeId = input.runtimeId?.trim() || this.#registry.defaultRuntimeId;
    await this.#requireAllowed(input.workspaceId, runtimeId);
    const engine = await this.#registry.requireAvailable(runtimeId);
    if (input.configuration && "model" in input.configuration) await engine.listModels(await this.#resolveWorkspaceContext(input.workspaceId));
    const descriptor = await engine.descriptor();
    const validated = validateAgentRuntimeSessionConfiguration(descriptor, input.configuration ?? {});
    if (!validated.success) {
      throw new AgentEngineError("runtime_configuration_invalid", "Agent runtime configuration is incompatible", {
        runtimeId,
        issueCode: validated.code,
        field: validated.field,
      });
    }
    const context = await this.#resolveWorkspaceContext(input.workspaceId);
    const sessionId = this.#randomUUID();
    const created = await engine.createSession({
      ...context,
      sessionId,
      title: input.title,
      configuration: agentRuntimeAdapterConfiguration(descriptor, validated.configuration),
    });
    const session: CanonicalAgentSession = {
      ...created,
      id: sessionId,
      workspaceId: input.workspaceId,
      runtimeId,
      title: input.title,
      canonicalCwd: context.directory,
      configuration: validated.configuration,
    };
    this.#repository.createSession(session);
    this.#append({
      id: `session-created:${session.id}`,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      runtimeId: session.runtimeId,
      occurredAt: session.createdAt,
      data: { type: "session.created", session },
    });
    return session;
  }

  async listSessions(workspaceId: string, options: { roots?: boolean; start?: number; search?: string; limit?: number } = {}): Promise<CanonicalAgentSession[]> {
    const context = await this.#resolveWorkspaceContext(workspaceId);
    let defaultRuntimeFailure: AgentEngineError | null = null;
    const listedSessionIds = new Set<string>();
    for (const engine of this.#registry.list()) {
      if (!await this.#isRuntimeAllowed(workspaceId, engine.runtimeId)) continue;
      try {
        if (!isAvailable(await engine.health())) continue;
        for (const backendSession of await engine.listSessions({ ...context, ...options })) {
          const persisted = this.#persistEngineSession(backendSession, engine.runtimeId, context);
          listedSessionIds.add(persisted.id);
        }
      } catch (error) {
        if (engine.runtimeId === this.#registry.defaultRuntimeId && error instanceof AgentEngineError) {
          defaultRuntimeFailure = error;
        }
        // Persisted projections remain readable while an engine is stopped.
      }
    }
    const sessions = this.#repository.listSessions(workspaceId).filter((session) =>
      this.#registry.list().some((engine) => engine.runtimeId === session.runtimeId));
    if (sessions.length === 0 && defaultRuntimeFailure?.code === "runtime_request_failed") throw defaultRuntimeFailure;
    if (Object.keys(options).length === 0) return sessions;
    return sessions.filter((session) => listedSessionIds.has(session.id));
  }

  async readSession(workspaceId: string, sessionId: string): Promise<CanonicalAgentSession> {
    const context = await this.#resolveWorkspaceContext(workspaceId);
    let persisted = this.#repository.getSession(sessionId)
      ?? this.#repository.getSessionByBackend(this.#registry.defaultRuntimeId, sessionId);
    if (!persisted) {
      const engine = this.#registry.resolve();
      const loaded = await engine.readSession({ ...context, sessionId, backendSessionId: sessionId });
      persisted = this.#persistEngineSession(loaded, engine.runtimeId, context);
    }
    this.#assertWorkspace(persisted, workspaceId);
    try {
      const engine = await this.#registry.requireAvailable(persisted.runtimeId);
      await engine.restoreSession?.(persisted);
      const current = await engine.readSession({
        ...context,
        sessionId: persisted.id,
        backendSessionId: persisted.backendSessionId,
      });
      return this.#persistEngineSession(current, persisted.runtimeId, context, persisted);
    } catch (error) {
      if (error instanceof AgentEngineError && error.code === "runtime_unavailable") return persisted;
      throw error;
    }
  }

  async snapshot(workspaceId: string, sessionId: string, limit?: number): Promise<CanonicalSessionSnapshot> {
    const session = await this.readSession(workspaceId, sessionId);
    const context = await this.#resolveWorkspaceContext(workspaceId);
    try {
      const engine = await this.#registry.requireAvailable(session.runtimeId);
      const engineSnapshot = await engine.readSnapshot({
        ...context,
        sessionId: session.id,
        backendSessionId: session.backendSessionId,
        limit,
      });
      for (const message of engineSnapshot.messages) this.#repository.putMessage(rebindMessage(message, session.id));
      this.#syncEventOnlySnapshot(session, engineSnapshot);
    } catch (error) {
      if (!(error instanceof AgentEngineError) || error.code !== "runtime_unavailable") throw error;
    }
    return this.#repository.buildSnapshot(session.id);
  }

  async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
    const session = await this.#mutationSession(workspaceId, sessionId);
    if (await this.sessionActivity(workspaceId, sessionId) !== "idle") {
      throw new SessionMutationError("session_busy", this.#sessionMutations.getActive(workspaceId, sessionId)?.runId ?? null);
    }
    const engine = await this.#registry.requireAvailable(session.runtimeId);
    if (!engine.deleteSession) {
      throw new AgentEngineError("runtime_capability_unsupported", `${session.runtimeId} does not support session deletion`, {
        runtimeId: session.runtimeId,
      });
    }
    await engine.deleteSession({
      ...(await this.#resolveWorkspaceContext(workspaceId)),
      sessionId: session.id,
      backendSessionId: session.backendSessionId,
    });
    this.#repository.deleteSession(session.id);
  }

  async updateSession(workspaceId: string, sessionId: string, input: { title: string }): Promise<CanonicalAgentSession> {
    const session = await this.#mutationSession(workspaceId, sessionId);
    const engine = await this.#registry.requireAvailable(session.runtimeId);
    if (!engine.updateSession) {
      throw new AgentEngineError("runtime_capability_unsupported", `${session.runtimeId} does not support session updates`, {
        runtimeId: session.runtimeId,
      });
    }
    const updated = await engine.updateSession({
      ...(await this.#resolveWorkspaceContext(workspaceId)),
      sessionId: session.id,
      backendSessionId: session.backendSessionId,
      title: input.title,
    });
    const persisted = this.#repository.updateSession({
      ...session,
      title: updated.title,
      updatedAt: Math.max(updated.updatedAt, this.#now()),
    });
    this.#appendEventData(persisted, { type: "session.updated", session: persisted });
    return persisted;
  }

  async bindLegacyOpenCodeSession(workspaceId: string, backendSessionId: string): Promise<CanonicalAgentSession> {
    const existing = this.#repository.getSession(backendSessionId)
      ?? this.#repository.getSessionByBackend(this.#registry.defaultRuntimeId, backendSessionId);
    if (existing) {
      this.#assertWorkspace(existing, workspaceId);
      return existing;
    }
    const context = await this.#resolveWorkspaceContext(workspaceId);
    const timestamp = this.#now();
    return this.#repository.mapLegacyOpenCodeSession({
      backendSessionId,
      workspaceId,
      title: backendSessionId,
      canonicalCwd: context.directory,
      status: { type: "idle" },
      configuration: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async previewContinuation(input: {
    workspaceId: string;
    sourceSessionId: string;
    targetRuntimeId: string;
  }): Promise<AgentContinuationPreview> {
    if (await this.sessionActivity(input.workspaceId, input.sourceSessionId) !== "idle") {
      throw new AgentContinuationError("source_busy", "The source session must be idle before continuing with another runtime");
    }
    await this.#requireAllowed(input.workspaceId, input.targetRuntimeId);
    await this.#registry.requireAvailable(input.targetRuntimeId);
    return buildAgentContinuationPreview(
      await this.snapshot(input.workspaceId, input.sourceSessionId),
      input.targetRuntimeId,
    );
  }

  async continueSession(input: {
    workspaceId: string;
    sourceSessionId: string;
    targetRuntimeId: string;
    context: AgentContinuationContext;
  }): Promise<AgentContinuationResult> {
    const source = await this.readSession(input.workspaceId, input.sourceSessionId);
    if (await this.sessionActivity(input.workspaceId, input.sourceSessionId) !== "idle") {
      throw new AgentContinuationError("source_busy", "The source session must be idle before continuing with another runtime");
    }
    if (source.runtimeId === input.targetRuntimeId) {
      throw new AgentContinuationError("same_runtime", "Cross-runtime continuation requires a different target runtime");
    }
    const context = validateAgentContinuationContext(input.context);
    await this.#requireAllowed(input.workspaceId, input.targetRuntimeId);
    const engine = await this.#registry.requireAvailable(input.targetRuntimeId);
    const workspace = await this.#resolveWorkspaceContext(input.workspaceId);
    const sessionId = this.#randomUUID();
    const title = "Continue with Claude Agent";
    const created = await engine.createSession({
      ...workspace,
      sessionId,
      title,
      configuration: {},
    });
    const timestamp = this.#now();
    const session: CanonicalAgentSession = {
      ...created,
      id: sessionId,
      workspaceId: input.workspaceId,
      runtimeId: input.targetRuntimeId,
      title,
      canonicalCwd: workspace.directory,
      configuration: {},
    };
    const link = {
      sourceSessionId: source.id,
      targetSessionId: session.id,
      type: "migration" as const,
      contextDigest: digestAgentContinuation(source.id, input.targetRuntimeId, context),
      createdAt: timestamp,
    };
    this.#repository.createContinuation({ session, link, context });
    this.#append({
      id: `session-created:${session.id}`,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      runtimeId: session.runtimeId,
      occurredAt: session.createdAt,
      data: { type: "session.created", session },
    });
    const migrationMessage = this.#repository.buildSnapshot(session.id).messages[0];
    if (migrationMessage) this.#appendEventData(session, { type: "message.updated", message: migrationMessage });
    return { session: this.#repository.getSession(session.id) ?? session, link, context };
  }

  sessionLinks(workspaceId: string, sessionId: string) {
    this.#requiredSession(workspaceId, sessionId);
    return this.#repository.listSessionLinks(sessionId);
  }

  async forkSession(input: {
    workspaceId: string;
    sourceSessionId: string;
    title?: string;
    upToMessageId?: string;
  }): Promise<{
    session: CanonicalAgentSession;
    link: CanonicalSessionLink;
    filesystemState: {
      sharedWorkingTree: true;
      checkpointHistoryCopied: false;
      filesRewound: false;
      warning: string;
    };
  }> {
    const source = await this.#mutationSession(input.workspaceId, input.sourceSessionId);
    if (await this.sessionActivity(input.workspaceId, input.sourceSessionId) !== "idle") {
      throw new AgentContinuationError("source_busy", "Claude-native fork requires an idle source session");
    }
    if (!source.backendSessionId) {
      throw new AgentEngineError("runtime_request_failed", "Claude-native fork requires an initialized backend session", { sessionId: source.id });
    }
    const descriptor = await this.runtime(input.workspaceId, source.runtimeId);
    if (!descriptor.capabilities.fork) {
      throw new AgentEngineError("runtime_capability_unsupported", `${source.runtimeId} does not support native fork`, {
        runtimeId: source.runtimeId,
        capability: "fork",
      });
    }
    const engine = await this.#registry.requireAvailable(source.runtimeId);
    if (!engine.forkSession) {
      throw new AgentEngineError("runtime_capability_unsupported", `${source.runtimeId} does not implement native fork`, {
        runtimeId: source.runtimeId,
        capability: "fork",
      });
    }
    const workspace = await this.#resolveWorkspaceContext(input.workspaceId);
    const targetSessionId = this.#randomUUID();
    const title = input.title?.trim() || `${source.title} (fork)`;
    const result = await engine.forkSession({
      ...workspace,
      sourceSessionId: source.id,
      sourceBackendSessionId: source.backendSessionId,
      targetSessionId,
      title,
      ...(input.upToMessageId ? { upToMessageId: this.#backendForkMessageId(source, input.upToMessageId) } : {}),
    });
    const session = this.#repository.createSession(result.session);
    const link = this.#repository.addSessionLink({
      sourceSessionId: source.id,
      targetSessionId: session.id,
      type: "fork",
      contextDigest: digestAgentContinuation(source.id, source.runtimeId, { summary: `Native fork ${session.id}`, transcript: [] }),
      createdAt: this.#now(),
    });
    this.#append({
      id: `session-created:${session.id}`,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      runtimeId: session.runtimeId,
      occurredAt: session.createdAt,
      data: { type: "session.created", session },
    });
    return { session, link, filesystemState: result.filesystemState };
  }

  async stopSubagent(input: { workspaceId: string; sessionId: string; runId: string; taskId: string }): Promise<void> {
    const session = await this.#mutationSession(input.workspaceId, input.sessionId);
    const descriptor = await this.runtime(input.workspaceId, session.runtimeId);
    if (!descriptor.capabilities.subagents) {
      throw new AgentEngineError("runtime_capability_unsupported", `${session.runtimeId} does not support subagent controls`, {
        runtimeId: session.runtimeId,
        capability: "subagents",
      });
    }
    const active = this.#sessionMutations.getActive(input.workspaceId, input.sessionId);
    if (!active || active.runId !== input.runId) throw new SessionMutationError("run_mismatch", active?.runId ?? null);
    const engine = await this.#registry.requireAvailable(session.runtimeId);
    if (!engine.stopSubagent) {
      throw new AgentEngineError("runtime_capability_unsupported", `${session.runtimeId} does not implement subagent stop`, {
        runtimeId: session.runtimeId,
        capability: "subagents",
      });
    }
    await engine.stopSubagent({
      ...(await this.#resolveWorkspaceContext(input.workspaceId)),
      sessionId: session.id,
      backendSessionId: session.backendSessionId,
      runId: input.runId,
      taskId: input.taskId,
    });
  }

  async startRun(input: {
    workspaceId: string;
    sessionId: string;
    origin: SessionMutationOrigin;
    startCommandCorrelationId: string | null;
    prompt: Record<string, unknown>;
    confirmAmbiguousRetry?: boolean;
    currentTurn?: AgentRuntimeCurrentTurnConfiguration;
  }) {
    const session = await this.#mutationSession(input.workspaceId, input.sessionId);
    if (session.status.type === "interrupted" && session.status.ambiguous && input.confirmAmbiguousRetry !== true) {
      throw new AgentEngineError(
        "runtime_retry_confirmation_required",
        "Retry requires confirmation because the interrupted Claude turn may have changed external state",
        { sessionId: session.id, runtimeId: session.runtimeId },
      );
    }
    const engine = await this.#registry.requireAvailable(session.runtimeId);
    const currentTurn = input.currentTurn
      ? await this.#validateCurrentTurnConfiguration(input.workspaceId, session, input.currentTurn)
      : undefined;
    await this.startWorkspaceEvents(input.workspaceId);
    await engine.restoreSession?.(session);
    const migrationMessage = this.#migrationMessage(session);
    const prompt = migrationMessage ? this.#migrationPrompt(migrationMessage, input.prompt) : input.prompt;
    const run = this.#sessionMutations.reserveStart(input);
    this.#telemetry?.queryStarted(run.runId);
    try {
      await engine.startRun({
        ...(await this.#resolveWorkspaceContext(input.workspaceId)),
        sessionId: session.id,
        backendSessionId: session.backendSessionId,
        runId: run.runId,
        prompt,
        delivery: "start",
        ...(currentTurn ? { currentTurn } : {}),
      });
      if (migrationMessage) {
        this.#repository.putMessage({
          ...migrationMessage,
          metadata: { ...migrationMessage.metadata, injectedAt: this.#now() },
        });
      }
      const accepted = this.#sessionMutations.acceptStart({
        workspaceId: input.workspaceId,
        sessionId: session.id,
        runId: run.runId,
      });
      if (!accepted) return run;
      if (currentTurn) {
        this.#appendEventData(session, {
          type: "run.configuration",
          runId: run.runId,
          semantics: "current-turn",
          actor: input.origin,
          configuration: currentTurn,
        });
      }
      this.#appendStatus(session, { type: "running" });
      return accepted;
    } catch (error) {
      this.#telemetry?.queryFinished(run.runId, "failed");
      this.#sessionMutations.rollbackStart({ workspaceId: input.workspaceId, sessionId: session.id, runId: run.runId });
      if (error instanceof AgentEngineError && error.details?.interruptedAmbiguous === true) {
        const message = "Claude Agent transport was lost while starting the turn. The turn may have changed external state. Verify the result before retrying.";
        this.#appendEventData(session, {
          type: "run.failed",
          runId: run.runId,
          code: "worker_transport_lost_ambiguous",
          message,
          retryable: false,
        });
        this.#appendStatus(session, { type: "interrupted", ambiguous: true, message });
      }
      throw error;
    }
  }

  async dispatchPending(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    requestId: string;
    mode: "steer" | "enqueue";
    prompt: string;
  }): Promise<void> {
    const session = await this.#mutationSession(input.workspaceId, input.sessionId);
    const descriptor = await this.runtime(input.workspaceId, session.runtimeId);
    if (!descriptor.capabilities[input.mode]) {
      throw new AgentEngineError("runtime_capability_unsupported", `${session.runtimeId} does not support ${input.mode}`, {
        runtimeId: session.runtimeId,
        capability: input.mode,
      });
    }
    const engine = await this.#registry.requireAvailable(session.runtimeId);
    await this.startWorkspaceEvents(input.workspaceId);
    this.#telemetry?.queryStarted(input.runId);
    try {
      await engine.startRun({
        ...(await this.#resolveWorkspaceContext(input.workspaceId)),
        sessionId: session.id,
        backendSessionId: session.backendSessionId,
        runId: input.runId,
        requestId: input.requestId,
        prompt: { parts: [{ type: "text", text: input.prompt }] },
        delivery: input.mode,
      });
    } catch (error) {
      this.#telemetry?.queryFinished(input.runId, "failed");
      throw error;
    }
  }

  async sessionActivity(workspaceId: string, sessionId: string): Promise<"idle" | "busy"> {
    const active = this.#sessionMutations.getActive(workspaceId, sessionId);
    if (active) return "busy";
    const session = await this.readSession(workspaceId, sessionId);
    return session.status.type === "idle" ? "idle" : "busy";
  }

  activeRun(workspaceId: string, sessionId: string) {
    this.#requiredSession(workspaceId, sessionId);
    return this.#sessionMutations.getActive(workspaceId, sessionId);
  }

  activeRuns(workspaceId: string) {
    return this.#sessionMutations.listActive(workspaceId).filter((run) =>
      this.#repository.getSession(run.sessionId)?.workspaceId === workspaceId);
  }

  async abortRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    abortCommandCorrelationId: string | null;
  }) {
    const session = await this.#mutationSession(input.workspaceId, input.sessionId);
    const engine = await this.#registry.requireAvailable(session.runtimeId);
    const reservation = this.#sessionMutations.reserveAbort(input);
    try {
      await engine.abortRun({
        ...(await this.#resolveWorkspaceContext(input.workspaceId)),
        sessionId: session.id,
        backendSessionId: session.backendSessionId,
        runId: input.runId,
      });
      const run = this.#sessionMutations.acceptAbort(input) ?? reservation.run;
      this.#appendStatus(session, { type: "aborting" });
      return run;
    } catch (error) {
      this.#sessionMutations.rollbackAbort({ ...input, previousStatus: reservation.previousStatus });
      throw error;
    }
  }

  observeRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    status: SessionMutationObservationStatus;
  }) {
    const session = this.#requiredSession(input.workspaceId, input.sessionId);
    const observation = this.#sessionMutations.observe(input);
    if (observation.terminalStatus) {
      this.#telemetry?.queryFinished(
        input.runId,
        observation.terminalStatus === "completed" ? "completed" : observation.terminalStatus === "aborted" ? "aborted" : "failed",
      );
      const data: CanonicalAgentEventData = observation.terminalStatus === "completed"
        ? { type: "run.completed", runId: input.runId }
        : observation.terminalStatus === "aborted"
          ? { type: "run.aborted", runId: input.runId }
          : { type: "run.failed", runId: input.runId, code: "run_failed", message: "Run failed", retryable: false };
      this.#appendEventData(session, data);
      this.#appendStatus(session, { type: "idle" });
    } else if (input.status !== "idle" && input.status !== "completed" && input.status !== "failed" && input.status !== "aborted") {
      const status = input.status === "retrying"
        ? { type: "retrying" as const, attempt: 1, message: "Retrying", nextAt: this.#now() }
        : { type: input.status } as CanonicalAgentSession["status"];
      this.#appendStatus(session, status);
    }
    return observation;
  }

  async resolveInteraction(input: {
    workspaceId: string;
    sessionId: string;
    interactionId: string;
    origin: "local-renderer" | "remote-control";
    commandCorrelationId: string | null;
    resolution: CanonicalInteractionResolution;
    questionAnswers?: Array<{ questionId: string; values: string[] }>;
  }): Promise<CanonicalInteraction> {
    const session = this.#requiredSession(input.workspaceId, input.sessionId);
    await this.#requireAllowed(input.workspaceId, session.runtimeId);
    const engine = await this.#registry.requireAvailable(session.runtimeId);
    const context = await this.#resolveWorkspaceContext(input.workspaceId);
    const interactions = engine.readInteractions
      ? await engine.readInteractions({
          ...context,
          sessionId: session.id,
          backendSessionId: session.backendSessionId,
        })
      : (await this.snapshot(input.workspaceId, input.sessionId)).interactions;
    const interaction = interactions.find((item) => item.id === input.interactionId);
    if (!interaction) {
      for (const kind of ["permission", "question"] as const) {
        const status = this.#interactionResolutions.status({
          workspaceId: input.workspaceId,
          sessionId: session.id,
          interactionId: input.interactionId,
          kind,
        });
        if (status === "reserved" || status === "resolved") throw new InteractionResolutionError("already_resolved");
        if (status === "expired") throw new InteractionResolutionError("interaction_expired");
      }
    }
    if (interaction && interaction.state !== "pending") {
      throw new InteractionResolutionError("already_resolved");
    }
    if (!interaction) throw new InteractionResolutionError("interaction_not_found");
    if (interaction.kind === "question" && input.questionAnswers) {
      validateQuestionAnswers(interaction, input.questionAnswers);
    }
    const kind = interaction.kind === "permission" ? "permission" : "question";
    const scope = { workspaceId: input.workspaceId, sessionId: session.id, interactionId: interaction.id, kind } as const;
    const existingStatus = this.#interactionResolutions.status(scope);
    if (existingStatus === "reserved" || existingStatus === "resolved") {
      throw new InteractionResolutionError("already_resolved");
    }
    if (existingStatus === "expired") throw new InteractionResolutionError("interaction_expired");
      this.#interactionResolutions.observePending(scope);
      this.#telemetry?.interactionRequested(interaction.id);
    const reservation = this.#interactionResolutions.reserve({
      ...scope,
      origin: input.origin,
      commandCorrelationId: input.commandCorrelationId,
    });
    try {
      await engine.resolveInteraction({
        ...context,
        sessionId: session.id,
        backendSessionId: session.backendSessionId,
        interactionId: interaction.id,
        resolution: input.resolution,
        ...(input.questionAnswers ? { questionAnswers: input.questionAnswers } : {}),
      });
      this.#interactionResolutions.accept(reservation);
      const resolvedAt = this.#now();
      const resolved: CanonicalInteraction = {
        ...interaction,
        state: input.resolution.outcome === "timeout" ? "timed_out"
          : input.resolution.outcome === "cancelled" ? "cancelled" : "resolved",
        resolvedAt,
        resolution: input.resolution,
      };
      this.#appendEventData(session, { type: "interaction.resolved", interaction: resolved });
      this.#telemetry?.interactionResolved(interaction.id, input.resolution.outcome);
      return resolved;
    } catch (error) {
      this.#interactionResolutions.rollback(reservation);
      this.#telemetry?.interactionFailed();
      throw error;
    }
  }

  workspaceEvents(workspaceId: string, cursor: Record<string, number>, limit = 2_000): CanonicalAgentEvent[] {
    return this.#repository.listSessions(workspaceId)
      .flatMap((session) => this.#repository.listEvents(session.id, cursor[session.id] ?? 0, limit))
      .sort((left, right) => left.occurredAt - right.occurredAt || left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence)
      .slice(0, limit);
  }

  workspaceCursor(workspaceId: string): Record<string, number> {
    return Object.fromEntries(this.#repository.listSessions(workspaceId).map((session) => {
      const snapshot = this.#repository.buildSnapshot(session.id);
      return [session.id, snapshot.latestSequence];
    }));
  }

  canResumeWorkspaceCursor(workspaceId: string, cursor: Record<string, number>): boolean {
    const sessions = this.#repository.listSessions(workspaceId);
    const sessionIds = new Set(sessions.map((session) => session.id));
    for (const [sessionId, sequence] of Object.entries(cursor)) {
      if (!sessionIds.has(sessionId) && sequence > 0) return false;
    }
    return sessions.every((session) => {
      const sequence = cursor[session.id] ?? 0;
      const window = this.#repository.eventWindow(session.id);
      if (sequence > window.latestSequence) return false;
      if (window.earliestSequence === null) return sequence === window.latestSequence;
      return sequence >= window.earliestSequence - 1;
    });
  }

  workspaceSnapshots(workspaceId: string): CanonicalSessionSnapshot[] {
    return this.#repository.listSessions(workspaceId).map((session) => this.#repository.buildSnapshot(session.id));
  }

  onWorkspaceEvent(workspaceId: string, listener: EventListener): () => void {
    const listeners = this.#listeners.get(workspaceId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(workspaceId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(workspaceId);
    };
  }

  async startWorkspaceEvents(workspaceId: string): Promise<void> {
    if (this.#eventPumps.has(workspaceId)) return;
    const controller = new AbortController();
    this.#eventPumps.set(workspaceId, controller);
    const context = await this.#resolveWorkspaceContext(workspaceId);
    for (const engine of this.#registry.list()) {
      void this.#pumpEngineEvents(engine, context, controller.signal);
    }
  }

  close(): void {
    for (const controller of this.#eventPumps.values()) controller.abort();
    this.#eventPumps.clear();
    this.#listeners.clear();
  }

  async #pumpEngineEvents(engine: AgentEnginePort, context: WorkspaceContext, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const event of engine.subscribeEvents(context, signal)) {
          if (signal.aborted) return;
          const normalized = this.#normalizeEngineEvent(event);
          if (!normalized) continue;
          this.#telemetry?.eventObserved(normalized.occurredAt);
          this.#observeEngineInteraction(normalized);
          const { sequence: _sequence, schemaVersion: _schemaVersion, ...input } = normalized;
          this.#append(input);
          this.#observeEngineRunEvent(normalized);
        }
      } catch {
        this.#telemetry?.eventStreamError();
        // Runtime health endpoints expose engine failures; projections stay readable.
      }
      if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  #observeEngineRunEvent(event: CanonicalAgentEvent): void {
    if (event.data.type !== "run.completed" && event.data.type !== "run.failed" && event.data.type !== "run.aborted") return;
    this.#telemetry?.queryFinished(
      event.data.runId,
      event.data.type === "run.completed" ? "completed" : event.data.type === "run.aborted" ? "aborted" : "failed",
    );
    if (event.data.type === "run.completed" && event.data.usage) this.#telemetry?.usage(event.data.runId, event.data.usage);
    const active = this.#sessionMutations.getActive(event.workspaceId, event.sessionId);
    if (!active || active.runId !== event.data.runId) return;
    this.#sessionMutations.observe({
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
      runId: event.data.runId,
      status: event.data.type === "run.completed" ? "completed" : event.data.type === "run.aborted" ? "aborted" : "failed",
    });
    const session = this.#requiredSession(event.workspaceId, event.sessionId);
    if (event.data.type === "run.failed" && event.data.code.startsWith("worker_transport_lost_")) {
      this.#appendStatus(session, {
        type: "interrupted",
        ambiguous: event.data.code === "worker_transport_lost_ambiguous",
        message: event.data.message,
      });
      return;
    }
    this.#appendStatus(session, { type: "idle" });
  }

  #normalizeEngineEvent(event: CanonicalAgentEvent): CanonicalAgentEvent | null {
    const session = this.#repository.getSession(event.sessionId)
      ?? this.#repository.getSessionByBackend(event.runtimeId, event.sessionId);
    if (!session) return null;
    const sessionId = session.id;
    return {
      ...event,
      workspaceId: session.workspaceId,
      sessionId,
      runtimeId: session.runtimeId,
      data: rebindEventData(event.data, sessionId),
    };
  }

  #observeEngineInteraction(event: CanonicalAgentEvent): void {
    if (event.data.type !== "interaction.requested" && event.data.type !== "interaction.resolved") return;
    const interaction = event.data.interaction;
    const scope = {
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
      interactionId: interaction.id,
      kind: interaction.kind === "permission" ? "permission" as const : "question" as const,
    };
    try {
      if (event.data.type === "interaction.requested") {
        this.#interactionResolutions.observePending(scope);
        this.#telemetry?.interactionRequested(interaction.id);
        return;
      }
      const status = this.#interactionResolutions.status(scope);
      if (status === "resolved" || status === "expired" || status === "reserved") return;
      if (status === null) this.#interactionResolutions.observePending(scope);
      const reservation = this.#interactionResolutions.reserve({
        ...scope,
        origin: "runtime",
        commandCorrelationId: null,
      });
      this.#interactionResolutions.accept(reservation);
      if (interaction.resolution) this.#telemetry?.interactionResolved(interaction.id, interaction.resolution.outcome);
    } catch (error) {
      if (!(error instanceof InteractionResolutionError)) throw error;
    }
  }

  #persistEngineSession(
    engineSession: CanonicalAgentSession,
    runtimeId: string,
    context: WorkspaceContext,
    known?: CanonicalAgentSession,
  ): CanonicalAgentSession {
    const backendSessionId = engineSession.backendSessionId ?? engineSession.id;
    const existing = known ?? this.#repository.getSessionByBackend(runtimeId, backendSessionId)
      ?? this.#repository.getSession(engineSession.id);
    if (!existing) {
      if (runtimeId === "jugglework") {
        return this.#repository.mapLegacyOpenCodeSession({
          backendSessionId,
          workspaceId: context.workspaceId,
          title: engineSession.title,
          canonicalCwd: context.directory,
          status: engineSession.status,
          configuration: engineSession.configuration,
          createdAt: engineSession.createdAt,
          updatedAt: engineSession.updatedAt,
        });
      }
      return this.#repository.createSession({
        ...engineSession,
        workspaceId: context.workspaceId,
        runtimeId,
        backendSessionId,
        canonicalCwd: context.directory,
      });
    }
    return this.#repository.updateSession({
      ...existing,
      backendSessionId: existing.backendSessionId ?? backendSessionId,
      title: engineSession.title,
      status: engineSession.status,
      updatedAt: Math.max(existing.updatedAt, engineSession.updatedAt),
      lastError: engineSession.lastError,
    });
  }

  #syncEventOnlySnapshot(session: CanonicalAgentSession, snapshot: CanonicalSessionSnapshot): void {
    const current = this.#repository.buildSnapshot(session.id);
    if (JSON.stringify(current.todos) !== JSON.stringify(snapshot.todos)) {
      this.#appendEventData(session, { type: "todo.updated", todos: snapshot.todos });
    }
    const currentInteractions = new Map(current.interactions.map((item) => [item.id, item]));
    for (const interaction of snapshot.interactions.map((item) => rebindInteraction(item, session.id))) {
      const existing = currentInteractions.get(interaction.id);
      if (existing?.state === "pending" && interaction.state === "pending") continue;
      if (existing && existing.state !== "pending" && interaction.state === "pending") continue;
      if (JSON.stringify(existing) === JSON.stringify(interaction)) continue;
      this.#appendEventData(session, {
        type: interaction.state === "pending" ? "interaction.requested" : "interaction.resolved",
        interaction,
      });
    }
  }

  async #mutationSession(workspaceId: string, sessionId: string): Promise<CanonicalAgentSession> {
    const session = await this.readSession(workspaceId, sessionId);
    await this.#requireAllowed(workspaceId, session.runtimeId);
    return session;
  }

  #requiredSession(workspaceId: string, sessionId: string): CanonicalAgentSession {
    const session = this.#repository.getSession(sessionId);
    if (!session) throw new AgentEngineError("runtime_request_failed", "Session was not found", { sessionId });
    this.#assertWorkspace(session, workspaceId);
    return session;
  }

  #assertWorkspace(session: CanonicalAgentSession, workspaceId: string): void {
    if (session.workspaceId !== workspaceId) {
      throw new AgentEngineError("runtime_session_mismatch", "Session belongs to another workspace", { sessionId: session.id });
    }
  }

  async #requireAllowed(workspaceId: string, runtimeId: string): Promise<void> {
    if (!await this.#isRuntimeAllowed(workspaceId, runtimeId)) {
      throw new AgentEngineError("runtime_unavailable", `Agent runtime ${runtimeId} is not permitted`, {
        runtimeId,
        reasonCode: "policy_denied",
      });
    }
  }

  async #validateCurrentTurnConfiguration(
    workspaceId: string,
    session: CanonicalAgentSession,
    configuration: AgentRuntimeCurrentTurnConfiguration,
  ): Promise<AgentRuntimeCurrentTurnConfiguration> {
    const descriptor = await this.runtime(workspaceId, session.runtimeId);
    const requested = [
      configuration.model ? ["model", "dynamic-model", configuration.model.modelId] as const : null,
      configuration.effort ? ["effort", "dynamic-effort", configuration.effort] as const : null,
      configuration.permissionMode ? ["permissionMode", "dynamic-permission-mode", configuration.permissionMode] as const : null,
      configuration.planMode ? ["planMode", "plan-mode", "plan"] as const : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);
    for (const [control, capability, value] of requested) {
      if (!descriptor.capabilities[capability]) {
        throw new AgentEngineError("runtime_capability_unsupported", `${session.runtimeId} does not support dynamic ${control}`, {
          runtimeId: session.runtimeId,
          capability,
        });
      }
      if (!await this.#isCurrentTurnControlAllowed(workspaceId, session.runtimeId, control, value)) {
        throw new AgentEngineError("runtime_unavailable", `Dynamic ${control} is disabled by policy`, {
          runtimeId: session.runtimeId,
          reasonCode: "policy_denied",
          control,
        });
      }
    }
    const sessionModel = session.configuration.model;
    const model = configuration.model
      ? descriptor.models.find((item) => item.providerId === configuration.model?.providerId && item.id === configuration.model.modelId)
      : sessionModel && typeof sessionModel === "object" && !Array.isArray(sessionModel)
        ? descriptor.models.find((item) => item.providerId === sessionModel.providerId && item.id === sessionModel.modelId)
        : descriptor.models.find((item) => item.isDefault);
    if (configuration.model && !model) {
      throw new AgentEngineError("runtime_configuration_invalid", "The requested current-turn model is unavailable", {
        runtimeId: session.runtimeId,
        issueCode: "model_unavailable",
        field: "currentTurn.model",
      });
    }
    const efforts = model?.capabilities.flatMap((item) => item.startsWith("effort:") ? [item.slice("effort:".length)] : []) ?? [];
    if (configuration.effort && (!model || !efforts.includes(configuration.effort))) {
      throw new AgentEngineError("runtime_configuration_invalid", "The requested effort is unavailable for the current-turn model", {
        runtimeId: session.runtimeId,
        issueCode: "effort_unavailable",
        field: "currentTurn.effort",
      });
    }
    return configuration;
  }

  #appendStatus(session: CanonicalAgentSession, status: CanonicalAgentSession["status"]): void {
    this.#appendEventData(session, { type: "session.status", status });
  }

  #appendEventData(session: CanonicalAgentSession, data: CanonicalAgentEventData): void {
    this.#append({
      id: this.#randomUUID(),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      runtimeId: session.runtimeId,
      occurredAt: this.#now(),
      data,
    });
  }

  #append(event: Omit<CanonicalAgentEvent, "sequence" | "schemaVersion">): CanonicalAgentEvent {
    const result = this.#repository.appendEventWithResult({ schemaVersion: 1, ...event });
    this.#telemetry?.eventPersisted(result.inserted);
    if (result.inserted && result.event.data.type === "run.usage") {
      this.#telemetry?.usage(result.event.data.runId, result.event.data.usage);
    }
    if (result.inserted) {
      for (const listener of this.#listeners.get(result.event.workspaceId) ?? []) {
        try { listener(result.event); } catch {}
      }
    }
    return result.event;
  }

  #migrationMessage(session: CanonicalAgentSession): CanonicalSessionSnapshot["messages"][number] | null {
    const isMigrationTarget = this.#repository.listSessionLinks(session.id).some((link) =>
      link.type === "migration" && link.targetSessionId === session.id);
    if (!isMigrationTarget) return null;
    return this.#repository.buildSnapshot(session.id).messages.find((message) =>
      message.metadata?.kind === "cross-runtime-migration" && typeof message.metadata.injectedAt !== "number") ?? null;
  }

  #backendForkMessageId(source: CanonicalAgentSession, messageId: string): string {
    const message = this.#repository.getMessage(messageId);
    const backendMessageId = message?.sessionId === source.id && typeof message.metadata?.backendMessageId === "string"
      ? message.metadata.backendMessageId : null;
    if (!backendMessageId) {
      throw new AgentEngineError("runtime_capability_unsupported", "The selected Claude message cannot be used as a safe native fork boundary", {
        runtimeId: source.runtimeId,
        capability: "fork",
        reasonCode: "backend_fork_boundary_unavailable",
      });
    }
    return backendMessageId;
  }

  #migrationPrompt(
    migrationMessage: CanonicalSessionSnapshot["messages"][number],
    prompt: Record<string, unknown>,
  ): Record<string, unknown> {
    const migrationText = migrationMessage.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!migrationText) return prompt;
    const parts = Array.isArray(prompt.parts) ? prompt.parts : [];
    return {
      ...prompt,
      parts: [{
        type: "text",
        text: `${migrationText}\n\nNew request in the Claude session follows.`,
      }, ...parts],
    };
  }
}

function isAvailable(health: AgentRuntimeHealth): boolean {
  return health.status === "healthy" || health.status === "degraded";
}

function rebindMessage(message: CanonicalSessionSnapshot["messages"][number], sessionId: string) {
  return {
    ...message,
    sessionId,
    parts: message.parts.map((part) => ({ ...part, sessionId })),
  };
}

function rebindInteraction(interaction: CanonicalInteraction, sessionId: string): CanonicalInteraction {
  return { ...interaction, sessionId };
}

function validateQuestionAnswers(
  interaction: CanonicalInteraction,
  answers: Array<{ questionId: string; values: string[] }>,
): void {
  const questions = interaction.questions ?? [];
  if (answers.length !== questions.length) throw new AgentEngineError("runtime_request_failed", "Question answers do not match the pending request");
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!;
    const answer = answers[index]!;
    if (answer.questionId !== question.id || answer.values.length === 0 || (!question.multiple && answer.values.length !== 1)) {
      throw new AgentEngineError("runtime_request_failed", "Question answers do not match the pending request");
    }
    if (question.options?.length && answer.values.some((value) => !question.options!.includes(value))) {
      throw new AgentEngineError("runtime_request_failed", "Question answers include an unavailable option");
    }
  }
}

function rebindEventData(data: CanonicalAgentEventData, sessionId: string): CanonicalAgentEventData {
  switch (data.type) {
    case "session.created":
    case "session.updated":
      return { ...data, session: { ...data.session, id: sessionId } };
    case "message.updated":
      return { ...data, message: rebindMessage(data.message, sessionId) };
    case "message.part.updated":
      return { ...data, part: { ...data.part, sessionId } };
    case "interaction.requested":
    case "interaction.resolved":
      return { ...data, interaction: rebindInteraction(data.interaction, sessionId) };
    default:
      return data;
  }
}
