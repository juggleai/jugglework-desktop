import { randomUUID } from "node:crypto";

export const JUGGLECHAT_SKILL_INVOKE_CHANNEL = "jugglework:jugglechat:skill-invoke";
export const JUGGLECHAT_SKILL_REPLY_CHANNEL = "jugglework:jugglechat:skill-reply";

const DEFAULT_TIMEOUT_MS = 30_000;

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * @param {{
 *   ipcMain: import("node:events").EventEmitter,
 *   getWindow: () => any,
 *   timeoutMs?: number | string,
 * }} options
 */
export function createJuggleChatSkillBridge(options) {
  const { ipcMain, getWindow, timeoutMs } = options;
  if (!ipcMain?.on || !ipcMain?.removeListener) {
    throw new TypeError("ipcMain is required");
  }
  if (typeof getWindow !== "function") {
    throw new TypeError("getWindow is required");
  }

  const configuredTimeout = Number.parseInt(
    String(timeoutMs ?? process.env.JUGGLECHAT_SKILL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    10,
  );
  const replyTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;
  const pending = new Map();

  const onReply = (event, envelope) => {
    if (!envelope?.requestId) return;
    const entry = pending.get(envelope.requestId);
    if (!entry) return;
    if (entry.webContents !== event.sender) return;

    pending.delete(envelope.requestId);
    clearTimeout(entry.timer);
    const ok = envelope.ok === true;
    let error = envelope.error;
    if (!ok && !error && envelope.message !== undefined && envelope.message !== null) {
      error = { code: "CB_ERROR", message: String(envelope.message) };
    }
    entry.resolve({ ok, data: envelope.data, error });
  };
  ipcMain.on(JUGGLECHAT_SKILL_REPLY_CHANNEL, onReply);

  const invoke = (input = {}) => new Promise((resolve) => {
    const win = getWindow();
    const webContents = win?.webContents;
    if (!win || win.isDestroyed?.() || !webContents || webContents.isDestroyed?.()) {
      resolve(failure("NO_RENDERER", "no renderer window"));
      return;
    }

    const requestId = input.requestId || randomUUID();
    const payload = {
      requestId,
      source: input.source,
      module: input.module,
      action: input.action,
      args: input.args,
      meta: input.meta,
    };
    const timer = setTimeout(() => {
      if (!pending.delete(requestId)) return;
      resolve(failure("TIMEOUT", `skill event timeout after ${replyTimeoutMs}ms`));
    }, replyTimeoutMs);
    pending.set(requestId, { resolve, timer, webContents });
    try {
      webContents.send(JUGGLECHAT_SKILL_INVOKE_CHANNEL, payload);
    } catch (error) {
      pending.delete(requestId);
      clearTimeout(timer);
      resolve(failure("SEND_FAILED", error instanceof Error ? error.message : String(error)));
    }
  });

  const dispose = () => {
    ipcMain.removeListener(JUGGLECHAT_SKILL_REPLY_CHANNEL, onReply);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(failure("APP_QUIT", "application is shutting down"));
    }
    pending.clear();
  };

  return { invoke, dispose };
}
