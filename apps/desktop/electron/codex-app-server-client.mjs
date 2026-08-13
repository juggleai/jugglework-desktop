import { spawn } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_LIMIT = 8_000;

function truncatedTail(value, limit = DEFAULT_STDERR_LIMIT) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function jsonRpcError(code, message, data) {
  return {
    code,
    message: String(message || "Codex App Server request failed."),
    ...(data === undefined ? {} : { data }),
  };
}

export class CodexAppServerError extends Error {
  constructor(message, options = {}) {
    super(String(message || "Codex App Server request failed."), options.cause ? { cause: options.cause } : undefined);
    this.name = "CodexAppServerError";
    this.code = options.code ?? "codex_app_server_error";
    this.data = options.data;
  }
}

/**
 * Minimal newline-delimited JSON-RPC client for `codex app-server --stdio`.
 * The client deliberately knows nothing about Codex method payloads; the
 * version-pinned protocol adapter owns those mappings.
 */
export function createCodexAppServerClient(options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const command = String(options.command ?? "codex");
  const args = Array.isArray(options.args) ? [...options.args] : ["app-server", "--stdio"];
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? Math.max(1, Number(options.requestTimeoutMs))
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const stderrLimit = Number.isFinite(options.stderrLimit)
    ? Math.max(0, Number(options.stderrLimit))
    : DEFAULT_STDERR_LIMIT;

  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
  let child = null;
  let stdoutBuffer = "";
  let stderrTail = "";
  let nextRequestId = 1;
  let closed = false;
  let closePromise = null;
  const pending = new Map();
  const notificationListeners = new Set();
  const serverRequestHandlers = new Map();

  function snapshot() {
    return {
      running: Boolean(child && child.exitCode === null && !child.killed),
      pid: child?.pid ?? null,
      command,
      args: [...args],
      pendingRequestCount: pending.size,
      stderrTail,
      closed,
    };
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function writeMessage(message) {
    if (!child || child.exitCode !== null || child.killed || !child.stdin.writable) {
      throw new CodexAppServerError("Codex App Server is not running.", { code: "runtime_not_running" });
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function sendServerResponse(id, result, error) {
    try {
      writeMessage(error ? { id, error } : { id, result: result ?? null });
    } catch {
      // The process may have exited while an async request handler was running.
    }
  }

  async function dispatchServerRequest(message) {
    const handler = serverRequestHandlers.get(message.method);
    if (!handler) {
      sendServerResponse(message.id, null, jsonRpcError(-32601, `Unsupported Codex App Server request: ${message.method}`));
      return;
    }
    try {
      const result = await handler(message.params, message);
      sendServerResponse(message.id, result, null);
    } catch (error) {
      sendServerResponse(
        message.id,
        null,
        jsonRpcError(-32603, error instanceof Error ? error.message : "Codex client request handler failed."),
      );
    }
  }

  function dispatchMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new CodexAppServerError(message.error.message, {
          code: message.error.code ?? "rpc_error",
          data: message.error.data,
        }));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") return;
    if (Object.hasOwn(message, "id")) {
      void dispatchServerRequest(message);
      return;
    }
    for (const listener of notificationListeners) {
      try {
        listener({ method: message.method, params: message.params });
      } catch {
        // A consumer exception must not break the protocol stream.
      }
    }
  }

  function consumeStdout(chunk) {
    stdoutBuffer += String(chunk ?? "");
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        dispatchMessage(JSON.parse(line));
      } catch (error) {
        options.onProtocolError?.(new CodexAppServerError("Codex App Server emitted invalid JSON.", {
          code: "invalid_json",
          cause: error,
        }));
      }
    }
  }

  function start() {
    if (closed) throw new CodexAppServerError("Codex App Server client is closed.", { code: "client_closed" });
    if (child && child.exitCode === null && !child.killed) return child;

    child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: options.detached === true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consumeStdout);
    child.stderr.on("data", (chunk) => {
      stderrTail = truncatedTail(`${stderrTail}${chunk}`, stderrLimit);
      options.onStderr?.(String(chunk));
    });
    child.on("error", (error) => {
      rejectPending(new CodexAppServerError("Codex App Server failed to start.", {
        code: "runtime_start_failed",
        cause: error,
      }));
    });
    child.on("exit", (code, signal) => {
      const error = new CodexAppServerError("Codex App Server exited.", {
        code: "runtime_exited",
        data: { code, signal, stderrTail },
      });
      rejectPending(error);
      options.onExit?.({ code, signal, stderrTail });
    });
    return child;
  }

  function request(method, params = {}, requestOptions = {}) {
    start();
    const id = nextRequestId++;
    const timeoutMs = Number.isFinite(requestOptions.timeoutMs)
      ? Math.max(1, Number(requestOptions.timeoutMs))
      : requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CodexAppServerError(`Codex App Server request timed out: ${method}`, {
          code: "request_timeout",
          data: { method, timeoutMs },
        }));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try {
        writeMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function notify(method, params = {}) {
    start();
    writeMessage({ method, params });
  }

  async function initialize(input = {}) {
    const result = await request("initialize", {
      clientInfo: input.clientInfo ?? { name: "jugglework-desktop", title: "JuggleWork Desktop", version: "dev" },
      capabilities: input.capabilities ?? { experimentalApi: true },
    }, input.requestOptions);
    notify("initialized", {});
    return result;
  }

  function onNotification(listener) {
    if (typeof listener !== "function") throw new TypeError("Notification listener must be a function.");
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  }

  function onRequest(method, handler) {
    if (typeof method !== "string" || !method.trim()) throw new TypeError("Server request method is required.");
    if (typeof handler !== "function") throw new TypeError("Server request handler must be a function.");
    serverRequestHandlers.set(method, handler);
    return () => {
      if (serverRequestHandlers.get(method) === handler) serverRequestHandlers.delete(method);
    };
  }

  function close(closeOptions = {}) {
    if (closePromise) return closePromise;
    closed = true;
    rejectPending(new CodexAppServerError("Codex App Server client closed.", { code: "client_closed" }));
    closePromise = new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      const forceAfterMs = Number.isFinite(closeOptions.forceAfterMs)
        ? Math.max(0, Number(closeOptions.forceAfterMs))
        : 2_000;
      let timer;
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", done);
      const terminate = options.terminateProcess ?? ((target, signal) => target.kill(signal));
      terminate(child, closeOptions.signal ?? "SIGTERM");
      timer = setTimeout(() => {
        if (child && child.exitCode === null) terminate(child, "SIGKILL");
        resolve();
      }, forceAfterMs);
    });
    return closePromise;
  }

  return {
    start,
    initialize,
    request,
    notify,
    onNotification,
    onRequest,
    close,
    snapshot,
  };
}
