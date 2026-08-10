const DEFAULT_HEADER_TIMEOUT_MS = 8_000;
const DEFAULT_INACTIVITY_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** @typedef {{ setTimeout(callback: (...args: any[]) => void, delay?: number): unknown, clearTimeout(handle: unknown): void }} Timers */

export class ManagedRuntimeSseClientError extends Error {
  /** @param {"unavailable" | "redirect" | "http_error" | "invalid_response" | "buffer_overflow" | "timeout" | "unauthorized"} code */
  constructor(code) {
    super("The managed runtime event subscription failed.");
    this.name = "ManagedRuntimeSseClientError";
    this.code = code;
    /** @type {number | null} */
    this.status = null;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** @param {unknown} value */
function identifier(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/** @param {unknown} value */
function runtimeAccess(value) {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "baseUrl") || !Object.hasOwn(value, "clientToken")) {
    throw new ManagedRuntimeSseClientError("unavailable");
  }
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  const clientToken = typeof value.clientToken === "string" ? value.clientToken.trim() : "";
  let url;
  try { url = new URL(baseUrl); } catch { throw new ManagedRuntimeSseClientError("unavailable"); }
  if (!clientToken || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ManagedRuntimeSseClientError("unavailable");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return { baseUrl: url.toString().replace(/\/+$/, ""), clientToken };
}

/**
 * Creates the narrow collaborator-authenticated OpenCode SSE client. Fatal
 * authorization/not-found responses reject the subscription; transient stream
 * failures reconnect until the caller aborts.
 *
 * @param {{
 *   getAccess(): unknown | Promise<unknown>,
 *   fetcher?: typeof fetch,
 *   headerTimeoutMs?: number,
 *   inactivityMs?: number,
 *   maxBufferBytes?: number,
 *   maxBackoffMs?: number,
 *   timers?: Timers,
 * }} options
 */
export function createManagedRuntimeSseClient({
  getAccess,
  fetcher = fetch,
  headerTimeoutMs = DEFAULT_HEADER_TIMEOUT_MS,
  inactivityMs = DEFAULT_INACTIVITY_MS,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
}) {
  if (typeof getAccess !== "function" || typeof fetcher !== "function" || !positiveInteger(headerTimeoutMs) ||
    !positiveInteger(inactivityMs) || !positiveInteger(maxBufferBytes) || !positiveInteger(maxBackoffMs) ||
    !timers || typeof timers.setTimeout !== "function" || typeof timers.clearTimeout !== "function") {
    throw new TypeError("Managed runtime SSE client options are invalid.");
  }

  /** @param {number} delay @param {AbortSignal} signal */
  function sleep(delay, signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const handle = timers.setTimeout(done, delay);
      function done() {
        signal.removeEventListener("abort", done);
        timers.clearTimeout(handle);
        resolve(undefined);
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * @param {{ workspaceId: string, onEvent(raw: unknown): void | Promise<void>, onReconnectGap(reason: "sequence_gap"): void | Promise<void>, signal: AbortSignal }} input
   */
  async function subscribe({ workspaceId, onEvent, onReconnectGap, signal }) {
    if (!identifier(workspaceId) || typeof onEvent !== "function" || typeof onReconnectGap !== "function" || !(signal instanceof AbortSignal)) {
      throw new TypeError("Managed runtime SSE subscription input is invalid.");
    }
    let lastEventId = "";
    let reconnects = 0;
    let serverRetryMs = 1_000;
    let connectedOnce = false;

    while (!signal.aborted) {
      const access = runtimeAccess(await getAccess());
      const path = `/workspace/${encodeURIComponent(workspaceId)}/opencode/event`;
      const url = new URL(path, `${access.baseUrl}/`);
      if (url.origin !== new URL(access.baseUrl).origin) throw new ManagedRuntimeSseClientError("unavailable");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const headerTimer = timers.setTimeout(() => controller.abort(), headerTimeoutMs);
      /** @type {Response} */
      let response;
      try {
        /** @type {Record<string, string>} */
        const headers = { Accept: "text/event-stream", Authorization: `Bearer ${access.clientToken}` };
        if (lastEventId) headers["Last-Event-ID"] = lastEventId;
        response = await fetcher(url, {
          method: "GET",
          headers,
          credentials: "omit",
          cache: "no-store",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        timers.clearTimeout(headerTimer);
        signal.removeEventListener("abort", abort);
        if (signal.aborted) break;
        if (controller.signal.aborted) throw new ManagedRuntimeSseClientError("timeout");
        if (connectedOnce) await onReconnectGap("sequence_gap");
        await sleep(Math.min(serverRetryMs * (2 ** Math.min(reconnects++, 5)), maxBackoffMs), signal);
        continue;
      }
      timers.clearTimeout(headerTimer);
      if (response.status >= 300 && response.status < 400) {
        signal.removeEventListener("abort", abort);
        throw new ManagedRuntimeSseClientError("redirect");
      }
      if ([401, 403, 404].includes(response.status)) {
        signal.removeEventListener("abort", abort);
        const error = new ManagedRuntimeSseClientError("unauthorized");
        error.status = response.status;
        throw error;
      }
      if (!response.ok) {
        signal.removeEventListener("abort", abort);
        if (connectedOnce) await onReconnectGap("sequence_gap");
        await sleep(Math.min(serverRetryMs * (2 ** Math.min(reconnects++, 5)), maxBackoffMs), signal);
        continue;
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        signal.removeEventListener("abort", abort);
        throw new ManagedRuntimeSseClientError("invalid_response");
      }
      const reader = response.body?.getReader();
      if (!reader) {
        signal.removeEventListener("abort", abort);
        throw new ManagedRuntimeSseClientError("invalid_response");
      }
      connectedOnce = true;
      reconnects = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let lineBuffer = "";
      let dataLines = [];
      let recordBytes = 0;
      let recordId = null;
      let streamFailed = false;
      /** @type {unknown} */
      let inactivityTimer = null;
      const resetWatchdog = () => {
        if (inactivityTimer !== null) timers.clearTimeout(inactivityTimer);
        inactivityTimer = timers.setTimeout(() => controller.abort(), inactivityMs);
      };
      /** @param {string} line */
      const consumeLine = async (line) => {
        if (line === "") {
          if (dataLines.length > 0) {
            const data = dataLines.join("\n");
            let parsed;
            try { parsed = JSON.parse(data); } catch { throw new ManagedRuntimeSseClientError("invalid_response"); }
            await onEvent(parsed);
          }
          if (recordId !== null) lastEventId = recordId;
          dataLines = [];
          recordBytes = 0;
          recordId = null;
          return;
        }
        recordBytes += Buffer.byteLength(line, "utf8") + 1;
        if (recordBytes > maxBufferBytes) throw new ManagedRuntimeSseClientError("buffer_overflow");
        if (line.startsWith(":")) return;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") dataLines.push(value);
        else if (field === "id" && !value.includes("\0")) recordId = value;
        else if (field === "retry" && /^\d+$/.test(value)) serverRetryMs = Math.max(250, Math.min(Number(value), maxBackoffMs));
      };
      resetWatchdog();
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          resetWatchdog();
          lineBuffer += decoder.decode(value, { stream: true });
          if (Buffer.byteLength(lineBuffer, "utf8") > maxBufferBytes) throw new ManagedRuntimeSseClientError("buffer_overflow");
          while (true) {
            const match = /\r\n|\r|\n/.exec(lineBuffer);
            if (!match || match.index === undefined) break;
            const line = lineBuffer.slice(0, match.index);
            lineBuffer = lineBuffer.slice(match.index + match[0].length);
            await consumeLine(line);
          }
        }
      } catch (error) {
        if (!signal.aborted && error instanceof ManagedRuntimeSseClientError && error.code === "buffer_overflow") throw error;
        streamFailed = !signal.aborted;
      } finally {
        if (inactivityTimer !== null) timers.clearTimeout(inactivityTimer);
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => undefined);
      }
      if (signal.aborted) break;
      await onReconnectGap("sequence_gap");
      await sleep(Math.min(serverRetryMs * (2 ** Math.min(reconnects++, 5)), maxBackoffMs), signal);
      void streamFailed;
    }
  }

  return Object.freeze({ subscribe });
}
