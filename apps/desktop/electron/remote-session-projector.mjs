import { Buffer } from "node:buffer";

import { desktopRemoteSessionEventSchema } from "../dist/runtime/desktop-remote-control.js";

import {
  normalizeCanonicalRemoteInteraction,
  normalizeCanonicalRemoteMessage,
  normalizeRemoteMessage,
  normalizeRemoteMessagePart,
  normalizeRemoteTodo,
} from "./remote-control-read-adapters.mjs";
import {
  normalizeRemotePermissionInteraction,
  normalizeRemoteQuestionInteraction,
} from "./remote-control-interaction-store.mjs";

const MAX_EVENT_BYTES = 512 * 1024;
const MAX_BINDINGS = 100;
const MAX_MESSAGES = 1_000;
const MAX_PARTS_PER_MESSAGE = 1_000;
const MAX_PENDING_DELTAS = 128 * 1024;
const MAX_TODOS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @typedef {import("@jugglework/types/desktop-remote-control").DesktopRemoteSessionEvent} DesktopRemoteSessionEvent */
/** @typedef {import("@jugglework/types/desktop-remote-control").DesktopRemoteMessage} DesktopRemoteMessage */
/** @typedef {import("@jugglework/types/desktop-remote-control").DesktopRemoteMessagePart} DesktopRemoteMessagePart */
/** @typedef {import("@jugglework/types/desktop-remote-control").DesktopRemoteInteraction} DesktopRemoteInteraction */
/** @typedef {{ setTimeout(callback: () => void, delay: number): unknown, clearTimeout(handle: unknown): void }} ProjectorTimers */
/** @typedef {{ controlSessionId: string, deviceId: string, workspaceId: string, sessionId: string, sequence: number }} Binding */
/** @typedef {{ info: Record<string, any> | null, parts: Map<string, { raw: Record<string, any>, normalized: DesktopRemoteMessagePart }>, pending: Map<string, string>, fullEmitted: boolean }} MessageState */
/** @typedef {{ messages: Map<string, MessageState>, todos: unknown[], interactions: Map<string, DesktopRemoteInteraction>, durableSequence: number | null }} SessionState */
/** @typedef {{ key: string, workspaceId: string, sessionId: string, messageId: string, partId: string, occurredAt: string, timer: unknown }} PendingPartEmission */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** @param {unknown} value @returns {string | null} */
function sessionIdOf(value) {
  if (!isRecord(value)) return null;
  if (isIdentifier(value.sessionID)) return value.sessionID;
  if (isIdentifier(value.sessionId)) return value.sessionId;
  if (isRecord(value.info) && isIdentifier(value.info.sessionID)) return value.info.sessionID;
  if (isRecord(value.part) && isIdentifier(value.part.sessionID)) return value.part.sessionID;
  return null;
}

/**
 * Accepts the legacy event, global SSE wrapper, and V2 event shapes without
 * carrying transport-only fields into the remote-control payload.
 * @param {unknown} raw
 * @returns {{ type: string, data: Record<string, any>, durable: unknown } | null}
 */
function unwrapEvent(raw) {
  let event = raw;
  if (isRecord(event) && Object.hasOwn(event, "payload")) event = event.payload;
  if (!isRecord(event) || typeof event.type !== "string") return null;
  const data = isRecord(event.data) ? event.data : isRecord(event.properties) ? event.properties : null;
  return data ? { type: event.type, data, durable: event.durable } : null;
}

/** @param {unknown} value @returns {number | null} */
function durableSequenceOf(value) {
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value);
  if (!isRecord(value)) return null;
  const candidate = value.sequence ?? value.cursor ?? value.offset;
  return Number.isSafeInteger(candidate) && Number(candidate) > 0 ? Number(candidate) : null;
}

/** @param {unknown} value @returns {number} */
function timestampMs(value) {
  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

/** @param {unknown} value @returns {string} */
function errorMessage(value) {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  if (isRecord(value)) {
    const candidate = value.message ?? value.name ?? value.data;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 500);
  }
  return "The session run failed.";
}

/**
 * @param {{
 *   randomUUID: () => string,
 *   now: () => number | Date,
 *   coalesceMs?: number,
 *   timers: ProjectorTimers,
 *   getActiveRunId: (input: { workspaceId: string, sessionId: string }) => string | null,
 *   emit: (payload: DesktopRemoteSessionEvent) => boolean,
 * }} options
 */
export function createRemoteSessionProjector({ randomUUID, now, coalesceMs = 25, timers, getActiveRunId, emit }) {
  if (typeof randomUUID !== "function" || typeof now !== "function" || typeof getActiveRunId !== "function" || typeof emit !== "function" ||
      !timers || typeof timers.setTimeout !== "function" || typeof timers.clearTimeout !== "function" ||
      !Number.isFinite(coalesceMs) || coalesceMs < 0) {
    throw new TypeError("Remote session projector dependencies are invalid.");
  }

  /** @type {Map<string, Binding>} */
  const bindings = new Map();
  /** @type {Map<string, SessionState>} */
  const sessions = new Map();
  /** @type {Map<string, PendingPartEmission>} */
  const pendingEmissions = new Map();
  let stopped = false;

  /** @param {string} workspaceId @param {string} sessionId */
  const sessionKey = (workspaceId, sessionId) => `${workspaceId}\u0000${sessionId}`;

  /** @param {string} workspaceId @param {string} sessionId @returns {SessionState} */
  function stateFor(workspaceId, sessionId) {
    const key = sessionKey(workspaceId, sessionId);
    let state = sessions.get(key);
    if (!state) {
      state = { messages: new Map(), todos: [], interactions: new Map(), durableSequence: null };
      sessions.set(key, state);
    }
    return state;
  }

  /** @param {SessionState} state @param {string} messageId @returns {MessageState} */
  function messageFor(state, messageId) {
    let message = state.messages.get(messageId);
    if (!message) {
      if (state.messages.size >= MAX_MESSAGES) state.messages.delete(state.messages.keys().next().value);
      message = { info: null, parts: new Map(), pending: new Map(), fullEmitted: false };
      state.messages.set(messageId, message);
    }
    return message;
  }

  /** @param {Binding} binding @param {unknown} data @param {string} occurredAt */
  function emitToBinding(binding, data, occurredAt) {
    if (stopped) return;
    const candidate = {
      schemaVersion: 1,
      payloadVersion: 1,
      eventId: randomUUID(),
      controlSessionId: binding.controlSessionId,
      deviceId: binding.deviceId,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
      sequence: binding.sequence + 1,
      occurredAt,
      data,
    };
    const parsed = desktopRemoteSessionEventSchema.safeParse(candidate);
    if (!parsed.success) return;
    if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > MAX_EVENT_BYTES) {
      if (!isRecord(data) || data.type !== "snapshot_required") {
        emitToBinding(binding, { type: "snapshot_required", reason: "sequence_gap" }, occurredAt);
      }
      return;
    }
    if (emit(parsed.data)) binding.sequence += 1;
  }

  /** @param {string} workspaceId @param {string} sessionId @param {unknown} data @param {string} occurredAt */
  function emitForSession(workspaceId, sessionId, data, occurredAt) {
    for (const binding of bindings.values()) {
      if (binding.workspaceId !== workspaceId || binding.sessionId !== sessionId) continue;
      emitToBinding(binding, data, occurredAt);
    }
  }

  /** @param {string} workspaceId @param {string} sessionId @param {string} reason @param {string} occurredAt */
  function requireSnapshot(workspaceId, sessionId, reason, occurredAt) {
    emitForSession(workspaceId, sessionId, { type: "snapshot_required", reason }, occurredAt);
  }

  /** @param {MessageState} state @param {string} sessionId @returns {DesktopRemoteMessage | null} */
  function normalizedMessage(state, sessionId) {
    if (!state.info) return null;
    return /** @type {DesktopRemoteMessage | null} */ (normalizeRemoteMessage(
      /** @type {any} */ ({ info: state.info, parts: [...state.parts.values()].map((entry) => entry.raw) }),
      sessionId,
    ));
  }

  /** @param {string} workspaceId @param {string} sessionId @param {string} messageId @param {string} partId @param {string} occurredAt */
  function schedulePart(workspaceId, sessionId, messageId, partId, occurredAt) {
    const key = `${workspaceId}\u0000${sessionId}\u0000${messageId}\u0000${partId}`;
    const existing = pendingEmissions.get(key);
    if (existing) {
      existing.occurredAt = occurredAt;
      return;
    }
    /** @type {PendingPartEmission} */
    const pending = { key, workspaceId, sessionId, messageId, partId, occurredAt, timer: null };
    pending.timer = timers.setTimeout(() => {
      pendingEmissions.delete(key);
      const part = sessions.get(sessionKey(workspaceId, sessionId))?.messages.get(messageId)?.parts.get(partId)?.normalized;
      if (part) emitForSession(workspaceId, sessionId, { type: "message.part.upsert", messageId, part }, pending.occurredAt);
    }, coalesceMs);
    pendingEmissions.set(key, pending);
  }

  /** @param {string} workspaceId @param {string} sessionId @param {Record<string, any>} data @param {string} occurredAt */
  function updatePart(workspaceId, sessionId, data, occurredAt) {
    const rawPart = isRecord(data.part) ? data.part : data;
    if (!isIdentifier(rawPart.id) || !isIdentifier(rawPart.messageID) || rawPart.sessionID !== sessionId) return;
    const normalized = /** @type {DesktopRemoteMessagePart | null} */ (normalizeRemoteMessagePart(/** @type {any} */ (rawPart)));
    if (!normalized) return;
    const message = messageFor(stateFor(workspaceId, sessionId), rawPart.messageID);
    if (!message.parts.has(rawPart.id) && message.parts.size >= MAX_PARTS_PER_MESSAGE) return;
    const cached = message.parts.get(rawPart.id)?.normalized;
    if (cached && (cached.type === "text" || cached.type === "reasoning") &&
        normalized.type === cached.type && cached.text.startsWith(normalized.text)) {
      normalized.text = cached.text;
    }
    const pendingText = message.pending.get(rawPart.id);
    if (pendingText !== undefined && (normalized.type === "text" || normalized.type === "reasoning")) {
      if (normalized.text.startsWith(pendingText)) {
        // The declaration is the longer cumulative view.
      } else if (pendingText.startsWith(normalized.text)) {
        normalized.text = pendingText;
      }
    }
    message.pending.delete(rawPart.id);
    const storedRaw = { ...rawPart, ...(normalized.type === "text" || normalized.type === "reasoning" ? { text: normalized.text } : {}) };
    message.parts.set(rawPart.id, { raw: storedRaw, normalized });
    if (message.info && !message.fullEmitted) {
      const full = normalizedMessage(message, sessionId);
      if (full) {
        emitForSession(workspaceId, sessionId, { type: "message.upsert", message: full }, occurredAt);
        message.fullEmitted = true;
      }
    }
    schedulePart(workspaceId, sessionId, rawPart.messageID, rawPart.id, occurredAt);
  }

  /** @param {string} workspaceId @param {string} sessionId @param {Record<string, any>} data @param {string} occurredAt */
  function appendDelta(workspaceId, sessionId, data, occurredAt) {
    if (data.sessionID !== sessionId || !isIdentifier(data.messageID) || !isIdentifier(data.partID) || typeof data.delta !== "string" || !data.delta) return;
    const message = messageFor(stateFor(workspaceId, sessionId), data.messageID);
    const part = message.parts.get(data.partID);
    if (!part) {
      const current = message.pending.get(data.partID) ?? "";
      message.pending.set(data.partID, (current + data.delta).slice(0, MAX_PENDING_DELTAS));
      return;
    }
    if (part.normalized.type !== "text" && part.normalized.type !== "reasoning") return;
    part.normalized.text = (part.normalized.text + data.delta).slice(0, MAX_PENDING_DELTAS);
    part.raw.text = part.normalized.text;
    schedulePart(workspaceId, sessionId, data.messageID, data.partID, occurredAt);
  }

  /** @param {string} workspaceId @param {string} sessionId @param {Record<string, any>} data @param {string} occurredAt */
  function projectStatus(workspaceId, sessionId, data, occurredAt) {
    const rawStatus = isRecord(data.status) ? data.status.type : data.status;
    const status = rawStatus === "busy" || rawStatus === "running" ? "running"
      : rawStatus === "retry" || rawStatus === "retrying" ? "retrying"
        : rawStatus === "aborting" ? "aborting"
          : rawStatus === "waiting" ? "waiting"
            : rawStatus === "failed" ? "failed"
              : rawStatus === "completed" ? "completed"
              : rawStatus === "idle" ? "idle" : null;
    if (status === null) return;
    const runId = getActiveRunId({ workspaceId, sessionId });
    const active = runId && ["running", "retrying", "aborting", "waiting"].includes(status)
      ? { workspaceId, sessionId, runId, status }
      : null;
    emitForSession(workspaceId, sessionId, { type: "session.status", status, run: active }, occurredAt);
    if (runId) {
      const runStatus = status === "idle" || status === "completed" ? "completed" : status;
      emitForSession(workspaceId, sessionId, { type: "run.status", runId, status: runStatus, error: null }, occurredAt);
    }
  }

  /** @param {{ controlSessionId: string, deviceId: string, workspaceId: string, sessionId: string }} input */
  function bind(input) {
    if (stopped || !isRecord(input) || !UUID_PATTERN.test(input.controlSessionId) || !UUID_PATTERN.test(input.deviceId) ||
        !isIdentifier(input.workspaceId) || !isIdentifier(input.sessionId)) {
      throw new TypeError("Remote session binding is invalid.");
    }
    const existing = bindings.get(input.controlSessionId);
    if (existing) {
      if (existing.deviceId !== input.deviceId || existing.workspaceId !== input.workspaceId || existing.sessionId !== input.sessionId) {
        return false;
      }
      return true;
    }
    if (bindings.size >= MAX_BINDINGS) throw new RangeError("Remote session binding limit exceeded.");
    bindings.set(input.controlSessionId, { ...input, sequence: 0 });
    return true;
  }

  /** @param {string} controlSessionId */
  function unbind(controlSessionId) {
    const binding = bindings.get(controlSessionId);
    if (!binding) return false;
    bindings.delete(controlSessionId);
    const stillBound = [...bindings.values()].some((candidate) =>
      candidate.workspaceId === binding.workspaceId && candidate.sessionId === binding.sessionId);
    if (!stillBound) {
      const prefix = `${binding.workspaceId}\u0000${binding.sessionId}\u0000`;
      for (const [key, pending] of pendingEmissions) {
        if (!key.startsWith(prefix)) continue;
        timers.clearTimeout(pending.timer);
        pendingEmissions.delete(key);
      }
      sessions.delete(sessionKey(binding.workspaceId, binding.sessionId));
    }
    return true;
  }

  /** @param {string} workspaceId @param {unknown} raw */
  function accept(workspaceId, raw) {
    if (stopped || !isIdentifier(workspaceId)) return;
    if (isRecord(raw) && raw.schemaVersion === 1 && isIdentifier(raw.sessionId) && isRecord(raw.data)) {
      return acceptCanonical(workspaceId, raw);
    }
    const event = unwrapEvent(raw);
    if (!event) return;
    const sessionId = sessionIdOf(event.data);
    if (!sessionId || ![...bindings.values()].some((binding) => binding.workspaceId === workspaceId && binding.sessionId === sessionId)) return;
    const occurredAtMs = timestampMs(now());
    const occurredAt = new Date(occurredAtMs).toISOString();
    const state = stateFor(workspaceId, sessionId);
    const durableSequence = durableSequenceOf(event.durable);
    if (durableSequence !== null) {
      if (state.durableSequence !== null && durableSequence <= state.durableSequence) return;
      if (state.durableSequence !== null && durableSequence !== state.durableSequence + 1) {
        state.durableSequence = durableSequence;
        requireSnapshot(workspaceId, sessionId, "sequence_gap", occurredAt);
        return;
      }
      state.durableSequence = durableSequence;
    }

    const data = event.data;
    if (event.type === "message.updated") {
      const info = isRecord(data.info) ? data.info : null;
      if (!info || info.sessionID !== sessionId || !isIdentifier(info.id)) return;
      const message = messageFor(state, info.id);
      message.info = info;
      const full = normalizedMessage(message, sessionId);
      if (full) {
        emitForSession(workspaceId, sessionId, { type: "message.upsert", message: full }, occurredAt);
        message.fullEmitted = true;
      }
      return;
    }
    if (event.type === "message.removed") {
      if (data.sessionID !== sessionId || !isIdentifier(data.messageID)) return;
      state.messages.delete(data.messageID);
      emitForSession(workspaceId, sessionId, { type: "message.remove", messageId: data.messageID }, occurredAt);
      return;
    }
    if (event.type === "message.part.updated") return updatePart(workspaceId, sessionId, data, occurredAt);
    if (event.type === "message.part.delta") return appendDelta(workspaceId, sessionId, data, occurredAt);
    if (event.type === "message.part.removed") {
      if (data.sessionID !== sessionId || !isIdentifier(data.messageID) || !isIdentifier(data.partID)) return;
      const message = state.messages.get(data.messageID);
      if (!message) return;
      message.parts.delete(data.partID);
      message.pending.delete(data.partID);
      const full = normalizedMessage(message, sessionId);
      if (full) emitForSession(workspaceId, sessionId, { type: "message.upsert", message: full }, occurredAt);
      else requireSnapshot(workspaceId, sessionId, "sequence_gap", occurredAt);
      return;
    }
    if (event.type === "todo.updated") {
      if (data.sessionID !== sessionId || !Array.isArray(data.todos)) return;
      const todos = data.todos.slice(0, MAX_TODOS).flatMap((todo, index) => {
        if (!isRecord(todo) || typeof todo.content !== "string" || typeof todo.status !== "string" || typeof todo.priority !== "string") return [];
        const normalized = normalizeRemoteTodo(/** @type {any} */ (todo), sessionId, index);
        return normalized ? [normalized] : [];
      });
      state.todos = todos;
      emitForSession(workspaceId, sessionId, { type: "todos.replace", todos }, occurredAt);
      return;
    }
    if (["permission.asked", "permission.v2.asked", "question.asked", "question.v2.asked"].includes(event.type)) {
      const interaction = event.type.startsWith("permission")
        ? normalizeRemotePermissionInteraction(data, sessionId, occurredAtMs)
        : normalizeRemoteQuestionInteraction(data, sessionId, occurredAtMs);
      if (!interaction) return;
      const runId = getActiveRunId({ workspaceId, sessionId });
      interaction.runId = isIdentifier(runId) ? runId : null;
      state.interactions.set(interaction.id, interaction);
      emitForSession(workspaceId, sessionId, { type: "interaction.upsert", interaction }, occurredAt);
      return;
    }
    if (["permission.replied", "permission.rejected", "permission.v2.replied", "permission.v2.rejected", "question.replied", "question.rejected", "question.v2.replied", "question.v2.rejected"].includes(event.type)) {
      const interactionId = isIdentifier(data.requestID) ? data.requestID : isIdentifier(data.id) ? data.id : null;
      if (data.sessionID !== sessionId || !interactionId) return;
      state.interactions.delete(interactionId);
      emitForSession(workspaceId, sessionId, { type: "interaction.remove", interactionId }, occurredAt);
      return;
    }
    if (event.type === "session.status") return projectStatus(workspaceId, sessionId, data, occurredAt);
    if (event.type === "session.idle") return projectStatus(workspaceId, sessionId, { ...data, status: "completed" }, occurredAt);
    if (event.type === "session.error") {
      const runId = getActiveRunId({ workspaceId, sessionId });
      emitForSession(workspaceId, sessionId, { type: "session.status", status: "failed", run: null }, occurredAt);
      if (runId) {
        emitForSession(workspaceId, sessionId, {
          type: "run.status",
          runId,
          status: "failed",
          error: { schemaVersion: 1, code: "internal_error", message: errorMessage(data.error), retryable: false, correlationId: null },
        }, occurredAt);
      }
    }
  }

  /** @param {string} workspaceId @param {Record<string, any>} event */
  function acceptCanonical(workspaceId, event) {
    const sessionId = event.sessionId;
    if (event.workspaceId !== workspaceId || ![...bindings.values()].some((binding) => binding.workspaceId === workspaceId && binding.sessionId === sessionId)) return;
    const state = stateFor(workspaceId, sessionId);
    const sequence = durableSequenceOf(event.sequence);
    const occurredAtMs = Number.isSafeInteger(event.occurredAt) ? event.occurredAt : timestampMs(now());
    const occurredAt = new Date(occurredAtMs).toISOString();
    if (sequence !== null) {
      if (state.durableSequence !== null && sequence <= state.durableSequence) return;
      if (state.durableSequence !== null && sequence !== state.durableSequence + 1) {
        state.durableSequence = sequence;
        requireSnapshot(workspaceId, sessionId, "sequence_gap", occurredAt);
        return;
      }
      state.durableSequence = sequence;
    }
    const data = event.data;
    if (data.type === "message.updated" && isRecord(data.message)) {
      const message = normalizeCanonicalRemoteMessage(data.message, sessionId);
      if (message) emitForSession(workspaceId, sessionId, { type: "message.upsert", message }, occurredAt);
      return;
    }
    if (data.type === "todo.updated" && Array.isArray(data.todos)) {
      const todos = data.todos.slice(0, MAX_TODOS).flatMap((todo, index) => {
        const normalized = normalizeRemoteTodo(todo, sessionId, index);
        return normalized ? [normalized] : [];
      });
      emitForSession(workspaceId, sessionId, { type: "todos.replace", todos }, occurredAt);
      return;
    }
    if ((data.type === "interaction.requested" || data.type === "interaction.resolved") && isRecord(data.interaction)) {
      if (data.type === "interaction.resolved") {
        emitForSession(workspaceId, sessionId, { type: "interaction.remove", interactionId: data.interaction.id }, occurredAt);
        return;
      }
      const interaction = normalizeCanonicalRemoteInteraction(data.interaction, sessionId);
      if (interaction) emitForSession(workspaceId, sessionId, { type: "interaction.upsert", interaction }, occurredAt);
      return;
    }
    if (data.type === "session.status") return projectStatus(workspaceId, sessionId, data, occurredAt);
    if (data.type === "run.completed" || data.type === "run.aborted" || data.type === "run.failed") {
      const status = data.type === "run.failed" ? "failed" : data.type === "run.aborted" ? "aborted" : "completed";
      emitForSession(workspaceId, sessionId, { type: "session.status", status: status === "completed" ? "idle" : status, run: null }, occurredAt);
      emitForSession(workspaceId, sessionId, {
        type: "run.status",
        runId: data.runId,
        status,
        error: data.type === "run.failed" ? { schemaVersion: 1, code: data.code, message: errorMessage(data.message), retryable: data.retryable === true, correlationId: null } : null,
      }, occurredAt);
    }
  }

  /** @param {string} workspaceId @param {"cursor_missing" | "cursor_expired" | "sequence_gap"} [reason] */
  function reconnectGap(workspaceId, reason = "cursor_missing") {
    if (stopped || !isIdentifier(workspaceId) || !["cursor_missing", "cursor_expired", "sequence_gap"].includes(reason)) return;
    const occurredAt = new Date(timestampMs(now())).toISOString();
    for (const binding of bindings.values()) {
      if (binding.workspaceId === workspaceId) emitToBinding(binding, { type: "snapshot_required", reason }, occurredAt);
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const pending of pendingEmissions.values()) timers.clearTimeout(pending.timer);
    pendingEmissions.clear();
    bindings.clear();
    sessions.clear();
  }

  return Object.freeze({ bind, unbind, accept, reconnectGap, stop });
}
