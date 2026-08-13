import {
  AGENT_RUNTIME_TELEMETRY_MAX_COUNT,
  AGENT_RUNTIME_TELEMETRY_MAX_DURATION_MS,
  AGENT_RUNTIME_TELEMETRY_MAX_TOKENS,
  CLAUDE_ADVANCED_FEATURES,
  agentRuntimeSupportDiagnosticsSchema,
  type AgentRuntimeSupportDiagnostics,
  type AgentRuntimeTelemetryDistribution,
  type CanonicalAgentUsage,
  type ClaudeAdvancedFeature,
} from "@jugglework/types/agent-runtime";

export type AgentRuntimeWorkerStatus = AgentRuntimeSupportDiagnostics["worker"]["status"];
export type AgentRuntimeCrashReason = NonNullable<AgentRuntimeSupportDiagnostics["crash"]["lastReason"]>;
const MAX_TRACKED_OPERATIONS = 10_000;
const clamp = (value: number, maximum: number) => Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
const increment = (value: number) => clamp(value + 1, AGENT_RUNTIME_TELEMETRY_MAX_COUNT);
const emptyDistribution = (): AgentRuntimeTelemetryDistribution => ({ count: 0, total: 0, max: 0 });

function addDistribution(target: AgentRuntimeTelemetryDistribution, value: number): void {
  const bounded = Math.round(clamp(value, AGENT_RUNTIME_TELEMETRY_MAX_DURATION_MS));
  target.count = increment(target.count);
  target.total = clamp(target.total + bounded, AGENT_RUNTIME_TELEMETRY_MAX_DURATION_MS);
  target.max = Math.max(target.max, bounded);
}

export class AgentRuntimeTelemetry {
  readonly #now: () => number;
  readonly #windowStartedAt: number;
  readonly #queryStarted = new Map<string, number>();
  readonly #interactionStarted = new Map<string, number>();
  readonly #usageRuns = new Set<string>();
  #workerStatus: AgentRuntimeWorkerStatus;
  #worker = { statusChanges: 0, starts: 0, restarts: 0, crashes: 0, circuitOpens: 0 };
  #query = { active: 0, started: 0, completed: 0, failed: 0, aborted: 0, durationMs: emptyDistribution() };
  #mcp = { events: 0, initializing: 0, pending: 0, connected: 0, failed: 0, needsAuth: 0, expired: 0, removed: 0, outputTruncated: 0 };
  #interaction = { requested: 0, resolved: 0, allowed: 0, denied: 0, answered: 0, rejected: 0, timedOut: 0, cancelled: 0, failed: 0, durationMs: emptyDistribution() };
  #event = { observed: 0, persisted: 0, duplicates: 0, streamErrors: 0, lagMs: emptyDistribution() };
  #queue = { created: 0, pending: 0, dispatching: 0, admitted: 0, completed: 0, failed: 0, cancelled: 0, waitMs: emptyDistribution() };
  readonly #advancedRollout = new Map(CLAUDE_ADVANCED_FEATURES.map((feature) => [feature, {
    feature,
    enabled: false,
    attempts: 0,
    used: 0,
    fallbacks: 0,
    flagDisabled: 0,
    policyDenied: 0,
    killed: 0,
    capabilityMissing: 0,
  }]));
  #usage = { samples: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0, estimatedCostUsd: 0 };
  #crash: AgentRuntimeSupportDiagnostics["crash"] = { total: 0, worker: 0, query: 0, eventStream: 0, lastAt: null, lastReason: null };

  constructor(options: { now?: () => number; workerStatus?: AgentRuntimeWorkerStatus } = {}) {
    this.#now = options.now ?? Date.now;
    this.#windowStartedAt = this.#now();
    this.#workerStatus = options.workerStatus ?? "disabled";
  }

  workerStatus(status: AgentRuntimeWorkerStatus): void {
    if (status === this.#workerStatus) return;
    const previous = this.#workerStatus;
    this.#workerStatus = status;
    this.#worker.statusChanges = increment(this.#worker.statusChanges);
    if (status === "starting") {
      this.#worker.starts = increment(this.#worker.starts);
      if (previous === "backoff") this.#worker.restarts = increment(this.#worker.restarts);
    }
    if (status === "circuit_open") {
      this.#worker.circuitOpens = increment(this.#worker.circuitOpens);
      this.crash("circuit_open", "worker");
    } else if (status === "failed") {
      this.crash("startup_failed", "worker");
    }
  }

  workerCrash(): void {
    this.#worker.crashes = increment(this.#worker.crashes);
    this.crash("worker_exit", "worker");
  }

  queryStarted(runId: string): void {
    if (this.#queryStarted.has(runId)) return;
    if (this.#queryStarted.size >= MAX_TRACKED_OPERATIONS) this.#queryStarted.delete(this.#queryStarted.keys().next().value!);
    this.#queryStarted.set(runId, this.#now());
    this.#query.active = increment(this.#query.active);
    this.#query.started = increment(this.#query.started);
  }

  queryFinished(runId: string, outcome: "completed" | "failed" | "aborted"): void {
    const startedAt = this.#queryStarted.get(runId);
    if (startedAt === undefined) return;
    this.#queryStarted.delete(runId);
    this.#query.active = Math.max(0, this.#query.active - 1);
    this.#query[outcome] = increment(this.#query[outcome]);
    addDistribution(this.#query.durationMs, this.#now() - startedAt);
  }

  mcp(state: "initializing" | "pending" | "connected" | "failed" | "needs_auth" | "expired" | "removed" | "output_truncated"): void {
    this.#mcp.events = increment(this.#mcp.events);
    const key = state === "needs_auth" ? "needsAuth" : state === "output_truncated" ? "outputTruncated" : state;
    this.#mcp[key] = increment(this.#mcp[key]);
  }

  interactionRequested(interactionId: string): void {
    if (this.#interactionStarted.has(interactionId)) return;
    if (this.#interactionStarted.size >= MAX_TRACKED_OPERATIONS) this.#interactionStarted.delete(this.#interactionStarted.keys().next().value!);
    this.#interactionStarted.set(interactionId, this.#now());
    this.#interaction.requested = increment(this.#interaction.requested);
  }

  interactionResolved(interactionId: string, outcome: "allow" | "deny" | "answer" | "reject" | "timeout" | "cancelled"): void {
    const startedAt = this.#interactionStarted.get(interactionId);
    if (startedAt !== undefined) {
      this.#interactionStarted.delete(interactionId);
      addDistribution(this.#interaction.durationMs, this.#now() - startedAt);
    }
    this.#interaction.resolved = increment(this.#interaction.resolved);
    const key = outcome === "allow" ? "allowed" : outcome === "deny" ? "denied" : outcome === "answer" ? "answered" : outcome === "reject" ? "rejected" : outcome === "timeout" ? "timedOut" : "cancelled";
    this.#interaction[key] = increment(this.#interaction[key]);
  }

  interactionFailed(): void {
    this.#interaction.failed = increment(this.#interaction.failed);
  }

  eventObserved(occurredAt: number): void {
    this.#event.observed = increment(this.#event.observed);
    addDistribution(this.#event.lagMs, this.#now() - occurredAt);
  }

  eventPersisted(inserted: boolean): void {
    if (inserted) this.#event.persisted = increment(this.#event.persisted);
    else this.#event.duplicates = increment(this.#event.duplicates);
  }

  eventStreamError(): void {
    this.#event.streamErrors = increment(this.#event.streamErrors);
    this.crash("event_stream_failed", "eventStream");
  }

  queueSnapshot(items: ReadonlyArray<{ state: "pending" | "dispatching" | "admitted" | "cancelled" | "completed" | "failed" }>): void {
    this.#queue.pending = items.filter((item) => item.state === "pending").length;
    this.#queue.dispatching = items.filter((item) => item.state === "dispatching").length;
    this.#queue.admitted = items.filter((item) => item.state === "admitted").length;
  }

  queueCreated(): void { this.#queue.created = increment(this.#queue.created); }
  queueAdmitted(waitMs: number): void { addDistribution(this.#queue.waitMs, waitMs); }
  queueFinished(outcome: "completed" | "failed" | "cancelled", waitMs: number): void {
    this.#queue[outcome] = increment(this.#queue[outcome]);
    if (waitMs >= 0) addDistribution(this.#queue.waitMs, waitMs);
  }

  advancedFeatureConfigured(feature: ClaudeAdvancedFeature, enabled: boolean): void {
    const metric = this.#advancedRollout.get(feature)!;
    metric.enabled = enabled;
  }

  advancedFeature(
    feature: ClaudeAdvancedFeature,
    outcome: "used" | "fallbacks" | "flagDisabled" | "policyDenied" | "killed" | "capabilityMissing",
  ): void {
    const metric = this.#advancedRollout.get(feature)!;
    if (outcome !== "fallbacks") metric.attempts = increment(metric.attempts);
    metric[outcome] = increment(metric[outcome]);
    if (outcome !== "used" && outcome !== "fallbacks") metric.fallbacks = increment(metric.fallbacks);
  }

  usage(runId: string, usage: CanonicalAgentUsage): void {
    if (this.#usageRuns.has(runId)) return;
    this.#usageRuns.add(runId);
    if (this.#usageRuns.size > MAX_TRACKED_OPERATIONS) this.#usageRuns.delete(this.#usageRuns.values().next().value!);
    this.#usage.samples = increment(this.#usage.samples);
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
      this.#usage[key] = clamp(this.#usage[key] + (usage[key] ?? 0), AGENT_RUNTIME_TELEMETRY_MAX_TOKENS);
    }
    this.#usage.turns = clamp(this.#usage.turns + (usage.turns ?? 0), AGENT_RUNTIME_TELEMETRY_MAX_COUNT);
    this.#usage.durationMs = clamp(this.#usage.durationMs + (usage.durationMs ?? 0), AGENT_RUNTIME_TELEMETRY_MAX_DURATION_MS);
    this.#usage.estimatedCostUsd = clamp(this.#usage.estimatedCostUsd + (usage.estimatedCostUsd ?? 0), 1_000_000_000);
  }

  crash(reason: AgentRuntimeCrashReason, source: "worker" | "query" | "eventStream"): void {
    this.#crash.total = increment(this.#crash.total);
    this.#crash[source] = increment(this.#crash[source]);
    this.#crash.lastAt = this.#now();
    this.#crash.lastReason = reason;
  }

  snapshot(): AgentRuntimeSupportDiagnostics {
    return agentRuntimeSupportDiagnosticsSchema.parse({
      schemaVersion: 1,
      capturedAt: this.#now(),
      windowStartedAt: this.#windowStartedAt,
      worker: { status: this.#workerStatus, ...this.#worker },
      query: this.#query,
      mcp: this.#mcp,
      interaction: this.#interaction,
      event: this.#event,
      queue: this.#queue,
      advancedRollout: { features: CLAUDE_ADVANCED_FEATURES.map((feature) => ({ ...this.#advancedRollout.get(feature)! })) },
      usage: this.#usage,
      crash: this.#crash,
    });
  }
}
