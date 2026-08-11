import type { SessionMutationCoordinator } from "./session-mutation-coordinator.js";
import type { SessionPendingOperation, SessionPendingOperationStore } from "./session-pending-operations.js";

export const SESSION_PENDING_OPERATION_PUMP_INTERVAL_MS = 250;
export const SESSION_PENDING_OPERATION_PUMP_MAX_SESSIONS = 100;
export const SESSION_PENDING_OPERATION_PUMP_ATTEMPT_TIMEOUT_MS = 10_000;
export const SESSION_PENDING_OPERATION_IDLE_CONFIRM_MS = 500;
export const SESSION_PENDING_OPERATION_STOP_TIMEOUT_MS = 2_000;
export const SESSION_PENDING_OPERATION_STEER_CANCEL_GRACE_MS = 250;

export function createSessionPendingOperationPump(options: {
  store: SessionPendingOperationStore;
  sessionMutations: SessionMutationCoordinator;
  getSessionStatus: (workspaceId: string, sessionId: string, signal: AbortSignal) => Promise<"idle" | "busy">;
  admit: (operation: SessionPendingOperation, signal: AbortSignal) => Promise<void>;
  isModeEnabled?: (mode: SessionPendingOperation["mode"]) => boolean | Promise<boolean>;
  intervalMs?: number;
  maxSessionsPerPass?: number;
  attemptTimeoutMs?: number;
  idleConfirmMs?: number;
  stopTimeoutMs?: number;
  steerCancelGraceMs?: number;
}) {
  const intervalMs = options.intervalMs ?? SESSION_PENDING_OPERATION_PUMP_INTERVAL_MS;
  const maxSessionsPerPass = options.maxSessionsPerPass ?? SESSION_PENDING_OPERATION_PUMP_MAX_SESSIONS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? SESSION_PENDING_OPERATION_PUMP_ATTEMPT_TIMEOUT_MS;
  const idleConfirmMs = options.idleConfirmMs ?? SESSION_PENDING_OPERATION_IDLE_CONFIRM_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? SESSION_PENDING_OPERATION_STOP_TIMEOUT_MS;
  const steerCancelGraceMs = options.steerCancelGraceMs ?? SESSION_PENDING_OPERATION_STEER_CANCEL_GRACE_MS;
  let closed = false;
  let paused = false;
  let running: Promise<void> | null = null;
  let rerunRequested = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scanOffset = 0;
  const activeControllers = new Set<AbortController>();
  const preAdmissionClaims = new Set<string>();
  let lifecycleGeneration = 1;

  function liveSessionKeys(): Array<{ workspaceId: string; sessionId: string }> {
    const unique = new Map<string, { workspaceId: string; sessionId: string }>();
    for (const operation of options.store.list()) {
      if (operation.state !== "admitted" && operation.state !== "dispatching" && operation.state !== "pending") continue;
      const key = `${operation.workspaceId}\0${operation.sessionId}`;
      if (!unique.has(key)) unique.set(key, { workspaceId: operation.workspaceId, sessionId: operation.sessionId });
    }
    const sessions = [...unique.values()];
    if (sessions.length <= maxSessionsPerPass) {
      scanOffset = 0;
      return sessions;
    }
    const start = scanOffset % sessions.length;
    const selected = Array.from({ length: maxSessionsPerPass }, (_, index) => sessions[(start + index) % sessions.length]!);
    scanOffset = (start + maxSessionsPerPass) % sessions.length;
    return selected;
  }

  async function reconcileSession(workspaceId: string, sessionId: string): Promise<void> {
    const reconcileGeneration = lifecycleGeneration;
    if (!options.store.acceptance().enabled) return;
    const controller = new AbortController();
    activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error("Pending operation reconciliation timed out")), attemptTimeoutMs);
    timeout.unref?.();
    try {
      const status = await options.getSessionStatus(workspaceId, sessionId, controller.signal);
      if (closed || reconcileGeneration !== lifecycleGeneration) return;
      if (!options.store.acceptance().enabled) return;
      if (status === "busy") {
        const active = options.sessionMutations.getActive(workspaceId, sessionId);
        if (active) options.sessionMutations.observe({ workspaceId, sessionId, runId: active.runId, status: "running" });
        for (const operation of options.store.list(workspaceId, sessionId)) {
          if (operation.state === "admitted") options.store.clearIdleConfirmation(operation.id);
        }
        const ambiguousSteer = options.store.list(workspaceId, sessionId).find((operation) => operation.mode === "steer" && operation.state === "dispatching");
        if (ambiguousSteer) {
          const acceptance = options.store.acceptance();
          if (acceptance.steer && (!options.isModeEnabled || await options.isModeEnabled("steer"))) {
            try {
              await options.admit(ambiguousSteer, controller.signal);
              if (closed || reconcileGeneration !== lifecycleGeneration) return;
              options.store.markAdmitted(ambiguousSteer.id, active?.runId ?? ambiguousSteer.id);
            } catch {}
          }
          return;
        }
        const steerAcceptance = options.store.acceptance();
        if (steerAcceptance.steer && (!options.isModeEnabled || await options.isModeEnabled("steer"))) {
          const pendingSteer = options.store.list(workspaceId, sessionId).find((operation) => operation.mode === "steer" && operation.state === "pending");
          const steer = pendingSteer ? options.store.claimById(pendingSteer.id, Date.now() - steerCancelGraceMs) : null;
          if (steer) {
            const generation = lifecycleGeneration;
            preAdmissionClaims.add(steer.id);
            try {
              await options.admit(steer, controller.signal);
              preAdmissionClaims.delete(steer.id);
              if (closed || generation !== lifecycleGeneration) return;
              options.store.markAdmitted(steer.id, active?.runId ?? steer.id);
            } catch {
              preAdmissionClaims.delete(steer.id);
              // Outcome may be committed upstream. Preserve dispatching for
              // same-ID steer reconciliation rather than terminalizing it.
            }
          }
        }
        return;
      }

      const active = options.sessionMutations.getActive(workspaceId, sessionId);
      if (active) {
        const observation = options.sessionMutations.observe({ workspaceId, sessionId, runId: active.runId, status: "idle" });
        if (!observation.cleared) {
          const admitted = options.store.list(workspaceId, sessionId)
            .find((operation) => operation.state === "admitted" && operation.admittedId === active.runId);
          // Admission acknowledgement can race ahead of OpenCode's busy status.
          // Two authoritative idle observations separated by a grace interval
          // close the fast-completion case without treating the first idle as terminal.
          if (!admitted || !options.store.confirmIdle(admitted.id, idleConfirmMs)) return;
          options.sessionMutations.observe({ workspaceId, sessionId, runId: active.runId, status: "completed" });
        }
      }

      // Persisted admissions after restart use the same two-idle confirmation
      // as in-memory runs; acknowledgement may still precede engine busy state.
      for (const operation of options.store.list(workspaceId, sessionId)) {
        if (operation.state === "admitted") {
          if (!options.store.confirmIdle(operation.id, idleConfirmMs)) return;
          options.store.markCompleted(operation.id);
        }
      }

      if (options.sessionMutations.getActive(workspaceId, sessionId)) return;
      const currentAcceptance = options.store.acceptance();
      const unfinishedCommit = options.store.list(workspaceId, sessionId)
        .find((operation) => operation.state === "dispatching" && currentAcceptance[operation.mode]);
      if (unfinishedCommit) {
        const acceptance = options.store.acceptance();
        if (!acceptance[unfinishedCommit.mode] || (options.isModeEnabled && !await options.isModeEnabled(unfinishedCommit.mode))) return;
        // Dispatching means the upstream result is unknown. Re-submit the exact
        // same durable ID; OpenCode's idempotency contract converts this into
        // either the original admission or the first admission, never a new ID.
        try {
          await options.admit(unfinishedCommit, controller.signal);
          if (closed || reconcileGeneration !== lifecycleGeneration) return;
          const recoveryRun = unfinishedCommit.mode === "enqueue" ? options.sessionMutations.reserveStart({
            workspaceId,
            sessionId,
            origin: "remote-control",
            startCommandCorrelationId: unfinishedCommit.commandCorrelationId,
          }) : null;
          options.store.markAdmitted(unfinishedCommit.id, recoveryRun?.runId ?? unfinishedCommit.id);
          if (recoveryRun) options.sessionMutations.acceptStart({ workspaceId, sessionId, runId: recoveryRun.runId });
        } catch {
          // Keep the unknown outcome durable for the next same-ID reconciliation.
        }
        return;
      }
      if (closed || reconcileGeneration !== lifecycleGeneration) return;
      const enabledModes = options.store.acceptance();
      const pendingSteer = enabledModes.steer && options.store.list(workspaceId, sessionId).some((operation) => operation.mode === "steer" && operation.state === "pending");
      const nextMode = pendingSteer ? "steer" : "enqueue";
      const modeAcceptance = options.store.acceptance();
      if (!modeAcceptance[nextMode] || (options.isModeEnabled && !await options.isModeEnabled(nextMode))) return;
      const next = options.store.claimNext(workspaceId, sessionId, nextMode);
      if (!next) return;

      let run;
      let upstreamCommitted = false;
      const generation = lifecycleGeneration;
      preAdmissionClaims.add(next.id);
      try {
        run = next.mode === "enqueue" ? options.sessionMutations.reserveStart({
          workspaceId,
          sessionId,
          origin: "remote-control",
          startCommandCorrelationId: next.commandCorrelationId,
        }) : null;
        await options.admit(next, controller.signal);
        upstreamCommitted = true;
        preAdmissionClaims.delete(next.id);
        if (closed || generation !== lifecycleGeneration) {
          // Leave dispatching durable. Startup/current-generation reconciliation
          // repairs the local commit using the same upstream idempotency identity.
          return;
        }
        options.store.markAdmitted(next.id, run?.runId ?? next.id);
        if (run) options.sessionMutations.acceptStart({ workspaceId, sessionId, runId: run.runId });
      } catch {
        preAdmissionClaims.delete(next.id);
        if (upstreamCommitted) {
          // Never classify a post-admission local persistence failure as an
          // upstream failure or redispatch the accepted prompt.
          if (run) options.sessionMutations.rollbackStart({ workspaceId, sessionId, runId: run.runId });
          return;
        }
        if (run) options.sessionMutations.rollbackStart({ workspaceId, sessionId, runId: run.runId });
        if (controller.signal.aborted || generation !== lifecycleGeneration) {
          // The abort can race a server-side durable commit. Preserve the
          // dispatching ambiguity and force Stop All to report it instead of
          // claiming that the prompt was cancelled.
          return;
        }
        // A transport or malformed-response failure can arrive after OpenCode
        // committed. Preserve dispatching for same-ID/original-mode recovery.
        return;
      }
    } finally {
      clearTimeout(timeout);
      activeControllers.delete(controller);
    }
  }

  async function run(): Promise<void> {
    for (const session of liveSessionKeys()) {
      if (closed) return;
      try {
        await reconcileSession(session.workspaceId, session.sessionId);
      } catch {
        // A workspace or engine can be temporarily unavailable. The bounded
        // lifecycle tick will retry without overlapping this pass.
      }
    }
  }

  function wake(): Promise<void> {
    if (closed) return Promise.resolve();
    if (paused) return running ?? Promise.resolve();
    if (running) {
      rerunRequested = true;
      return running;
    }
    if (!running) {
      running = run().finally(() => {
        running = null;
        if (rerunRequested && !closed && !paused) {
          rerunRequested = false;
          void wake();
        }
      });
    }
    return running;
  }

  function schedule(): void {
    if (closed) return;
    timer = setTimeout(() => {
      void wake().finally(schedule);
    }, intervalMs);
    timer.unref?.();
  }

  void wake();
  schedule();

  return Object.freeze({
    wake,
    async cancelAll(commandCorrelationId: string) {
      paused = true;
      const fenceGeneration = options.store.fenceRemoteAcceptance();
      lifecycleGeneration += 1;
      for (const controller of activeControllers) controller.abort(new Error("Remote acceptance stopped"));
      try {
        if (running) {
          await Promise.race([
            running,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Pending operation stop timed out")), stopTimeoutMs)),
          ]);
        }
        // Compute releasable claims only after all cooperative admission calls
        // have settled. Any remaining dispatching row has an ambiguous upstream
        // outcome and must block a successful Stop All result.
        const result = options.store.cancelAllPendingRemote(commandCorrelationId, fenceGeneration, [...preAdmissionClaims]);
        if (result.blockedDispatching.length > 0) throw new Error("Pending operation admission outcome is unresolved");
        return result.cancelled;
      } finally {
        // Stop All intentionally leaves acceptance fenced. Explicit local
        // re-enable must reopen it after policy and settings are restored.
      }
    },
    enable(policy = { steer: true, enqueue: true }) {
      if (closed) throw new Error("Pending operation pump is closed");
      const previous = options.store.acceptance();
      const disablesMode = (previous.steer && !policy.steer) || (previous.enqueue && !policy.enqueue);
      if (disablesMode) {
        lifecycleGeneration += 1;
        for (const controller of activeControllers) controller.abort(new Error("Busy-session policy changed"));
      }
      const result = options.store.enableRemoteAcceptance(policy);
      paused = false;
      void wake();
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      for (const controller of activeControllers) controller.abort(new Error("Pending operation pump closed"));
      if (running) {
        let timedOut = false;
        await Promise.race([
          running,
          new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, stopTimeoutMs)),
        ]);
        if (timedOut) throw new Error("Pending operation pump did not stop before its deadline");
      }
    },
    drained() {
      return running ?? Promise.resolve();
    },
  });
}

export type SessionPendingOperationPump = ReturnType<typeof createSessionPendingOperationPump>;
