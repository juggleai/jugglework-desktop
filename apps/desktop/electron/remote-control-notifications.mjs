const MAX_DEDUPE_ENTRIES = 2_048;

export const REMOTE_CONTROL_NOTIFICATION_CATEGORY = Object.freeze({
  WAITING: "waiting",
  TERMINAL: "terminal",
  DISCONNECT: "disconnect",
  REVOCATION: "revocation",
});

const COPY = Object.freeze({
  permission: Object.freeze({
    category: REMOTE_CONTROL_NOTIFICATION_CATEGORY.WAITING,
    title: "Permission needed",
    body: "A remote session is waiting for permission.",
  }),
  question: Object.freeze({
    category: REMOTE_CONTROL_NOTIFICATION_CATEGORY.WAITING,
    title: "Answer needed",
    body: "A remote session is waiting for an answer.",
  }),
  completed: Object.freeze({
    category: REMOTE_CONTROL_NOTIFICATION_CATEGORY.TERMINAL,
    title: "Remote run completed",
    body: "A remotely controlled run completed.",
  }),
  failed: Object.freeze({
    category: REMOTE_CONTROL_NOTIFICATION_CATEGORY.TERMINAL,
    title: "Remote run failed",
    body: "A remotely controlled run failed.",
  }),
  aborted: Object.freeze({
    category: REMOTE_CONTROL_NOTIFICATION_CATEGORY.TERMINAL,
    title: "Remote run aborted",
    body: "A remotely controlled run was aborted.",
  }),
  disconnected: Object.freeze({
    category: REMOTE_CONTROL_NOTIFICATION_CATEGORY.DISCONNECT,
    title: "Remote control disconnected",
    body: "An active remote control connection was interrupted.",
  }),
  local: Object.freeze({
    category: REMOTE_CONTROL_NOTIFICATION_CATEGORY.REVOCATION,
    title: "Remote control stopped",
    body: "Remote control was stopped on this device.",
  }),
  cloud: Object.freeze({
    category: REMOTE_CONTROL_NOTIFICATION_CATEGORY.REVOCATION,
    title: "Remote control revoked",
    body: "Cloud access to remote control was revoked.",
  }),
});

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function identity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/** @param {readonly unknown[]} values */
function dedupeKey(values) {
  return JSON.stringify(values);
}

/**
 * Converts a content-minimized live source event to fixed notification copy.
 * No source-provided text is ever copied into the title or body.
 * @param {unknown} event
 * @returns {Readonly<{ category: "waiting" | "terminal" | "disconnect" | "revocation", title: string, body: string, dedupeKey: string }> | null}
 */
export function classifyRemoteControlNotification(event) {
  if (!isRecord(event) || event.origin !== "live") return null;

  let copy;
  let key;
  if (event.type === "interaction.waiting" && identity(event.workspaceId) && identity(event.sessionId) &&
      identity(event.interactionId) && (event.interactionType === "permission" || event.interactionType === "question")) {
    copy = COPY[event.interactionType];
    key = dedupeKey([event.type, event.workspaceId, event.sessionId, event.interactionId]);
  } else if (event.type === "run.terminal" && identity(event.workspaceId) && identity(event.sessionId) &&
      identity(event.runId) && (event.outcome === "completed" || event.outcome === "failed" || event.outcome === "aborted")) {
    copy = COPY[event.outcome];
    key = dedupeKey([event.type, event.workspaceId, event.sessionId, event.runId, event.outcome]);
  } else if (event.type === "control.disconnected" && Number.isSafeInteger(event.transition) && event.transition > 0) {
    copy = COPY.disconnected;
    key = dedupeKey([event.type, event.transition]);
  } else if (event.type === "control.revoked" && (event.source === "local" || event.source === "cloud") &&
      Number.isSafeInteger(event.transition) && event.transition > 0) {
    copy = COPY[event.source];
    key = dedupeKey([event.type, event.source, event.transition]);
  } else {
    return null;
  }

  return Object.freeze({ ...copy, dedupeKey: key });
}

/**
 * Stateful delivery controller with no Electron dependency. It marks an event
 * before best-effort delivery so a failing notifier cannot create a retry storm.
 * @param {{ notify: (notification: { category: "waiting" | "terminal" | "disconnect" | "revocation", title: string, body: string }) => unknown, maxDedupeEntries?: number }} options
 */
export function createRemoteControlNotificationController({ notify, maxDedupeEntries = MAX_DEDUPE_ENTRIES }) {
  if (typeof notify !== "function" || !Number.isSafeInteger(maxDedupeEntries) || maxDedupeEntries < 1) {
    throw new TypeError("Remote control notification controller dependencies are invalid.");
  }

  const delivered = new Set();

  /** @param {unknown} event */
  function accept(event) {
    const notification = classifyRemoteControlNotification(event);
    if (!notification || delivered.has(notification.dedupeKey)) return false;
    delivered.add(notification.dedupeKey);
    while (delivered.size > maxDedupeEntries) delivered.delete(delivered.values().next().value);
    try {
      notify({
        category: notification.category,
        title: notification.title,
        body: notification.body,
      });
    } catch {}
    return true;
  }

  return Object.freeze({ accept });
}
