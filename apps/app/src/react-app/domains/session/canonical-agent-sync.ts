import {
  canonicalAgentEventSchema,
  canonicalSessionSnapshotSchema,
  type CanonicalAgentEvent,
  type CanonicalSessionSnapshot,
} from "@jugglework/types/agent-runtime";

import type { CanonicalAgentClient } from "@/app/lib/agent-client";

import { reconcileCanonicalEvents, reconcileCanonicalSnapshot } from "./canonical-agent-cache";

export type CanonicalAgentSyncState = "idle" | "connecting" | "live" | "recovering" | "stopped";

export type CanonicalAgentSyncOptions = {
  client: Pick<CanonicalAgentClient, "openWorkspaceEventStream">;
  initialSnapshots?: readonly CanonicalSessionSnapshot[];
  staleAfterMs?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxSeenEventIds?: number;
  onSnapshot?: (snapshot: CanonicalSessionSnapshot) => void;
  onStateChange?: (state: CanonicalAgentSyncState) => void;
  onError?: (error: unknown) => void;
};

type SseFrame = { event: string; data: string; id: string | null };

export function createCanonicalAgentSync(options: CanonicalAgentSyncOptions) {
  const staleAfterMs = positiveOption(options.staleAfterMs ?? 45_000, "staleAfterMs");
  const reconnectDelayMs = positiveOption(options.reconnectDelayMs ?? 250, "reconnectDelayMs");
  const maxReconnectDelayMs = positiveOption(options.maxReconnectDelayMs ?? 5_000, "maxReconnectDelayMs");
  const maxSeenEventIds = positiveOption(options.maxSeenEventIds ?? 4_096, "maxSeenEventIds");
  const snapshots = new Map<string, CanonicalSessionSnapshot>();
  const seenIds = new Set<string>();
  const seenOrder: string[] = [];
  for (const snapshot of options.initialSnapshots ?? []) snapshots.set(snapshot.session.id, snapshot);

  let cursorToken: string | null = null;
  let state: CanonicalAgentSyncState = "idle";
  let stopped = false;
  let task: Promise<void> | null = null;
  let active: AbortController | null = null;

  const setState = (next: CanonicalAgentSyncState) => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  const publish = (snapshot: CanonicalSessionSnapshot) => {
    snapshots.set(snapshot.session.id, snapshot);
    options.onSnapshot?.(snapshot);
  };

  const recover = () => {
    cursorToken = null;
    setState("recovering");
    active?.abort("snapshot-recovery");
  };

  const applyFrame = (frame: SseFrame): void => {
    if (frame.event === "heartbeat") {
      const heartbeat = parseJson(frame.data) as { cursorToken?: unknown };
      if (typeof heartbeat.cursorToken === "string") cursorToken = heartbeat.cursorToken;
      return;
    }
    if (frame.event === "snapshot") {
      const batch = parseWorkspaceBatch(parseJson(frame.data));
      for (const incoming of batch.snapshots ?? []) {
        publish(reconcileCanonicalSnapshot(snapshots.get(incoming.session.id), incoming));
      }
      cursorToken = batch.cursorToken;
      setState("live");
      return;
    }
    if (frame.event !== "event") return;
    const event = canonicalAgentEventSchema.parse(parseJson(frame.data));
    if (seenIds.has(event.id)) {
      if (frame.id) cursorToken = frame.id;
      return;
    }
    rememberEventId(event.id, seenIds, seenOrder, maxSeenEventIds);
    const current = snapshots.get(event.sessionId);
    if (!current) {
      recover();
      return;
    }
    const result = reconcileCanonicalEvents(current, [event]);
    if (result.needsSnapshot) {
      recover();
      return;
    }
    if (result.applied > 0) publish(result.snapshot);
    if (frame.id) cursorToken = frame.id;
    setState("live");
  };

  const run = async () => {
    let delay = reconnectDelayMs;
    while (!stopped) {
      active = new AbortController();
      setState(cursorToken ? "connecting" : "recovering");
      let staleTimer: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog = () => {
        if (staleTimer) clearTimeout(staleTimer);
        staleTimer = setTimeout(() => active?.abort("stale-stream"), staleAfterMs);
      };
      try {
        const response = await options.client.openWorkspaceEventStream(cursorToken, active.signal);
        armWatchdog();
        await readSseFrames(response, (frame) => {
          armWatchdog();
          applyFrame(frame);
        });
        delay = reconnectDelayMs;
      } catch (error) {
        if (!stopped && active.signal.reason !== "snapshot-recovery") options.onError?.(error);
      } finally {
        if (staleTimer) clearTimeout(staleTimer);
        active = null;
      }
      if (stopped) break;
      await sleep(delay);
      delay = Math.min(maxReconnectDelayMs, delay * 2);
    }
    setState("stopped");
  };

  return {
    start(): void {
      if (task || stopped) return;
      task = run();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      active?.abort("stopped");
      setState("stopped");
    },
    state: () => state,
    cursor: () => cursorToken,
    snapshot: (sessionId: string) => snapshots.get(sessionId),
    completed: () => task ?? Promise.resolve(),
  };
}

async function readSseFrames(response: Response, onFrame: (frame: SseFrame) => void): Promise<void> {
  if (!response.body) throw new Error("Canonical event stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = frameBoundary(buffer);
    while (boundary) {
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const frame = parseFrame(raw);
      if (frame) onFrame(frame);
      boundary = frameBoundary(buffer);
    }
    if (done) break;
  }
}

function frameBoundary(value: string): { index: number; length: number } | null {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    else if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, id, data: data.join("\n") } : null;
}

function parseWorkspaceBatch(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid canonical snapshot frame");
  const batch = value as Record<string, unknown>;
  if (batch.schemaVersion !== 1 || typeof batch.workspaceId !== "string" || typeof batch.cursorToken !== "string"
    || typeof batch.requiresSnapshot !== "boolean" || !Array.isArray(batch.events)
    || !batch.cursor || typeof batch.cursor !== "object" || Array.isArray(batch.cursor)) {
    throw new Error("Invalid canonical snapshot frame");
  }
  return {
    schemaVersion: 1,
    workspaceId: batch.workspaceId,
    events: canonicalAgentEventSchema.array().parse(batch.events),
    cursor: Object.fromEntries(Object.entries(batch.cursor).map(([key, item]) => {
      if (!Number.isSafeInteger(item) || Number(item) < 0) throw new Error("Invalid canonical cursor");
      return [key, Number(item)];
    })),
    cursorToken: batch.cursorToken,
    requiresSnapshot: batch.requiresSnapshot,
    snapshots: batch.snapshots === undefined ? undefined : canonicalSessionSnapshotSchema.array().parse(batch.snapshots),
  };
}

function rememberEventId(id: string, seen: Set<string>, order: string[], limit: number): void {
  seen.add(id);
  order.push(id);
  while (order.length > limit) seen.delete(order.shift()!);
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function positiveOption(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
