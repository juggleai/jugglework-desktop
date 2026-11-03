import { createHash, randomUUID } from "node:crypto";

export const ACTIVITY_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// One cursor and one in-flight page per watched workspace. Journal retention
// bounds restart replay; only cloud ACK advances delivery, never a socket send.
/** @param {{ workspaceId: string, list: Function, publish: Function, timers: any, signal: AbortSignal, isCurrent: () => boolean, logger?: {info?: Function, warn?: Function}, intervalMs?: number, timeoutMs?: number, now?: () => number }} options */
export function createActivityTerminalPoller({ workspaceId, list, publish, timers,
  signal, isCurrent, logger = {}, intervalMs = 5_000, timeoutMs = 10_000, now = Date.now }) {
  let cursor = 0;
  let expiredUndeliveredCount = 0;
  let running = false;
  let timer = null;
  let request = null;
  let stopped = false;
  const workspaceHash = createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
  const pollerHash = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16);
  const log = (reason, count = 0) => {
    try { logger.info?.("remote_activity_journal_lifecycle", { workspaceHash, pollerHash, cursor, count, reason }); } catch {}
  };
  const current = () => !signal.aborted && isCurrent();
  const stop = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    request?.abort();
    if (!stopped) log(["binding_failed", "phone_unbound", "bridge_stopped", "bridge_cleared", "workspace_removed"].includes(signal.reason)
      ? `stop_${signal.reason}` : "stop_aborted");
    stopped = true;
  };
  signal.addEventListener("abort", stop, { once: true });
  async function tick() {
    if (running || !current()) {
      log(running ? "skip_running" : "stop_not_current");
      return;
    }
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    running = true;
    request = new AbortController();
    const controller = request;
    let timeout;
    const expired = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      timeout = timers.setTimeout(() => controller.abort(), timeoutMs);
    });
    const valid = () => current() && !controller.signal.aborted;
    try {
      log("fetch");
      const page = await Promise.race([list({ workspaceId, after: cursor, signal: controller.signal, lifetimeSignal: signal }), expired]);
      if (!valid()) return;
      if (!Array.isArray(page?.items) || page.items.length > 100) throw new Error("invalid_page");
      log("page", page.items.length);
      for (const item of page.items) {
        if (!valid()) return;
        if (item.workspaceId !== workspaceId || !Number.isSafeInteger(item.id) || item.id <= cursor ||
            !Number.isSafeInteger(item.generation) || item.generation <= 0 ||
            typeof item.sessionId !== "string" || typeof item.runId !== "string" ||
            !["completed", "failed", "aborted"].includes(item.terminalReason) ||
            !Number.isFinite(item.occurredAt)) throw new Error("invalid_record");
        if (item.occurredAt < now() - ACTIVITY_JOURNAL_RETENTION_MS) {
          // Retention expiry is loss, not an ACK or delivery. Never consume an
          // in-retention invalid/forbidden/unavailable response as success.
          expiredUndeliveredCount++;
          try { logger.warn?.("remote_activity_journal_expired_undelivered", {
            expiredUndeliveredCount, generation: item.generation, status: item.terminalReason,
          }); } catch {}
          cursor = item.id;
          continue;
        }
        let ack = "unconfirmed";
        const accepted = await Promise.race([publish({ eventId: randomUUID(), workspaceId,
          sessionId: item.sessionId, runId: item.runId, generation: item.generation,
          status: item.terminalReason, occurredAt: new Date(item.occurredAt).toISOString(),
          title: "", workspaceName: "" }, { isCurrent: valid,
            onAck: reason => { if (valid()) ack = reason; } }), expired]);
        try { logger.info?.("remote_activity_journal_ack", {
          runHash: createHash("sha256").update(`${workspaceId}\0${item.sessionId}\0${item.runId}`).digest("hex").slice(0, 16),
          generation: item.generation, status: item.terminalReason, accepted: accepted === true, reason: ack,
        }); } catch {}
        // A scoped cloud stale ACK is an authoritative fence, not delivery.
        // Consume it so an older A cannot block delivery of newer B forever.
        if (!valid() || (accepted !== true && ack !== "stale")) {
          log(valid() ? "ack_unconfirmed" : "ack_cancelled");
          return;
        }
        cursor = item.id;
      }
    } catch {
      try { if (current()) logger.warn?.("remote_activity_journal_retry", { reason: controller.signal.aborted ? "timeout" : "request_failed" }); } catch {}
    } finally {
      timers.clearTimeout(timeout);
      request = null;
      running = false;
      if (current()) {
        timer = timers.setTimeout(() => void tick(), intervalMs);
        log("scheduled");
      } else log("stop_not_current");
    }
  }
  log("start");
  void tick();
  return { tick, diagnostics: () => ({ expiredUndeliveredCount }) };
}
