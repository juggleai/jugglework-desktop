import { afterEach, describe, expect, test } from "bun:test";

import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  SESSION_EVENT_STREAM_SILENCE_MS,
  __disposeWorkspaceSessionSyncForTest,
  ensureWorkspaceSessionSync,
  sessionEventStreamSilent,
  snapshotKey,
  trackWorkspaceSessionSync,
} from "../src/react-app/domains/session/sync/session-sync";
import { shouldReconcileAfterCoordinatorEnded } from "../src/react-app/domains/session/surface/session-run-recovery";

// Run with --isolate: sibling UI tests mock createClient and session-sync.
afterEach(() => getReactQueryClient().clear());

const encoder = new TextEncoder();
const liveness = { silenceMs: 150, checkMs: 25 };

function requestSignal(request: RequestInfo | URL, init?: RequestInit) {
  return init?.signal ?? (request instanceof Request ? request.signal : undefined);
}

function timeout(ms: number, message: string) {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

describe("event stream liveness", () => {
  test("silence bound exceeds several OpenCode heartbeat intervals", () => {
    // OpenCode emits server.heartbeat every 10 seconds on a quiet stream.
    expect(SESSION_EVENT_STREAM_SILENCE_MS).toBeGreaterThanOrEqual(30_000);
    expect(sessionEventStreamSilent(0, SESSION_EVENT_STREAM_SILENCE_MS - 1)).toBe(false);
    expect(sessionEventStreamSilent(0, SESSION_EVENT_STREAM_SILENCE_MS)).toBe(true);
  });

  test("a half-open transport is replaced and the replacement reconciles tracked sessions", async () => {
    const originalFetch = globalThis.fetch;
    const input = { workspaceId: "half-open", baseUrl: "http://fixture.invalid", juggleworkToken: "fixture", streamLiveness: liveness };
    const key = snapshotKey(input.workspaceId, "session-running");
    let connections = 0;
    let firstAborted = false;
    let calibrations = 0;
    let reconnected!: () => void;
    const replacementCalibrated = new Promise<void>((resolve) => { reconnected = resolve; });
    globalThis.fetch = (async (request, init) => {
      const attempt = ++connections;
      const signal = requestSignal(request, init);
      return new Response(new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => {
            if (attempt === 1) firstAborted = true;
            controller.close();
          }, { once: true });
          // Connect once, then go silent without closing or erroring.
          controller.enqueue(encoder.encode('data: {"type":"server.connected"}\n\n'));
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const releaseWorkspace = ensureWorkspaceSessionSync({
      ...input,
      onReconnect: () => {
        calibrations += 1;
        if (calibrations === 1) getReactQueryClient().setQueryData(key, { session: { id: "session-running" }, messages: [] });
        if (calibrations === 2) reconnected();
      },
    });
    const releaseSession = trackWorkspaceSessionSync(input, "session-running");
    try {
      await Promise.race([replacementCalibrated, timeout(4_000, "Half-open stream was not replaced")]);
      expect(firstAborted).toBe(true);
      expect(connections).toBe(2);
      // The replacement connection invalidates the snapshot whose terminal
      // events the silent transport swallowed.
      expect(getReactQueryClient().getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      releaseSession();
      releaseWorkspace();
      __disposeWorkspaceSessionSyncForTest(input);
      globalThis.fetch = originalFetch;
    }
  }, 6_000);

  test("SSE comment heartbeats keep a quiet transport open", async () => {
    const originalFetch = globalThis.fetch;
    const input = { workspaceId: "heartbeat-only", baseUrl: "http://fixture.invalid", juggleworkToken: "fixture", streamLiveness: liveness };
    let connections = 0;
    let aborted = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    globalThis.fetch = (async (request, init) => {
      connections += 1;
      const signal = requestSignal(request, init);
      return new Response(new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => {
            aborted = true;
            clearInterval(heartbeat);
            controller.close();
          }, { once: true });
          controller.enqueue(encoder.encode('data: {"type":"server.connected"}\n\n'));
          // Comment frames never surface as parsed events; only raw bytes prove liveness.
          heartbeat = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 30);
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const release = ensureWorkspaceSessionSync(input);
    try {
      await new Promise((resolve) => setTimeout(resolve, liveness.silenceMs * 4));
      expect(connections).toBe(1);
      expect(aborted).toBe(false);
    } finally {
      clearInterval(heartbeat);
      release();
      __disposeWorkspaceSessionSyncForTest(input);
      globalThis.fetch = originalFetch;
    }
  });
});

describe("coordinator-ended reconciliation", () => {
  const base = {
    activeRunsSucceeded: true,
    previousCoordinatorActive: true,
    coordinatorActive: false,
    liveStatus: "busy",
    activityRunActive: false,
  };

  test("reconciles when the server run list ends while the local status is still busy", () => {
    expect(shouldReconcileAfterCoordinatorEnded(base)).toBe(true);
    expect(shouldReconcileAfterCoordinatorEnded({ ...base, liveStatus: "retry" })).toBe(true);
    expect(shouldReconcileAfterCoordinatorEnded({ ...base, liveStatus: "idle", activityRunActive: true })).toBe(true);
  });

  test("does not reconcile without an observed run end or a stuck local projection", () => {
    expect(shouldReconcileAfterCoordinatorEnded({ ...base, previousCoordinatorActive: false })).toBe(false);
    expect(shouldReconcileAfterCoordinatorEnded({ ...base, coordinatorActive: true })).toBe(false);
    expect(shouldReconcileAfterCoordinatorEnded({ ...base, activeRunsSucceeded: false })).toBe(false);
    expect(shouldReconcileAfterCoordinatorEnded({ ...base, liveStatus: "idle" })).toBe(false);
  });
});
