import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const SAFE_RESPONSE_HEADERS = ["content-type", "retry-after", "x-request-id", "x-jugglework-provider"];
const SAFE_FORWARD_HEADERS = [
  "accept", "content-type", "idempotency-key", "user-agent", "x-app", "originator",
  "session_id", "x-codex-beta-features", "x-codex-turn-metadata",
  "x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version",
  "x-stainless-retry-count", "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout",
];

export class CodexCredentialBrokerError extends Error {
  constructor(code) {
    super("The Codex credential broker failed.");
    this.name = "CodexCredentialBrokerError";
    this.code = code;
  }
}

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(String(left ?? "")).digest();
  const rightDigest = createHash("sha256").update(String(right ?? "")).digest();
  return timingSafeEqual(leftDigest, rightDigest) && left === right;
}

function bearer(request) {
  const value = String(request.headers.authorization ?? "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function remoteBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new CodexCredentialBrokerError("invalid_gateway");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CodexCredentialBrokerError("invalid_gateway");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

async function readBoundedBody(request, maxBytes) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new CodexCredentialBrokerError("request_too_large");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new CodexCredentialBrokerError("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function safeRequestHeaders(request, remoteToken) {
  const headers = new Headers({ Authorization: `Bearer ${remoteToken}` });
  for (const name of SAFE_FORWARD_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string" && value) headers.set(name, value);
  }
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

function sendSafeError(response, status, code, retryAfterSeconds = null) {
  if (retryAfterSeconds !== null) response.setHeader("Retry-After", String(retryAfterSeconds));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify({ error: { code, message: "The Codex gateway request failed." } }));
}

/**
 * Main-only loopback broker. The returned child secret/base URL must be passed
 * directly to the Codex child and must never be projected through IPC/status.
 *
 * @param {{
 *   tokenProvider: { getToken(input: unknown): Promise<unknown>, invalidate(input?: unknown): void },
 *   fetcher?: typeof fetch,
 *   maxRequestBytes?: number,
 *   timeoutMs?: number,
 * }} options
 */
export function createCodexCredentialBroker({
  tokenProvider,
  fetcher = fetch,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!tokenProvider?.getToken || !tokenProvider?.invalidate || typeof fetcher !== "function") {
    throw new TypeError("Codex credential broker options are invalid.");
  }
  let state = null;
  let server = null;
  let disposed = false;

  async function proxy(request, response) {
    if (!state || disposed || request.headers.origin) {
      sendSafeError(response, 403, "forbidden");
      return;
    }
    if (!safeEqual(bearer(request), state.localSecret)) {
      sendSafeError(response, 401, "unauthorized");
      return;
    }
    const expectedPath = `/${state.pathNonce}/v1/responses`;
    if (request.method !== "POST" || request.url?.split("?", 1)[0] !== expectedPath) {
      sendSafeError(response, 404, "not_found");
      return;
    }
    let body;
    try {
      body = await readBoundedBody(request, maxRequestBytes);
    } catch (error) {
      sendSafeError(response, error?.code === "request_too_large" ? 413 : 400, error?.code ?? "invalid_request");
      return;
    }
    const idempotencyKey = typeof request.headers["idempotency-key"] === "string"
      ? request.headers["idempotency-key"].trim()
      : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onClose = () => controller.abort();
    request.once("aborted", onClose);
    response.once("close", onClose);
    try {
      /** @type {{ gatewayBaseUrl: string, accessToken: string }} */
      let token = /** @type {any} */ (await tokenProvider.getToken(state.binding));
      let upstream;
      const send = async () => {
        const baseUrl = remoteBaseUrl(token.gatewayBaseUrl);
        const target = new URL(`${baseUrl.pathname}/responses`.replace(/\/+/g, "/"), baseUrl.origin);
        return fetcher(target, {
          method: "POST",
          headers: safeRequestHeaders(request, token.accessToken),
          body,
          cache: "no-store",
          credentials: "omit",
          redirect: "manual",
          signal: controller.signal,
        });
      };
      upstream = await send();
      if (upstream.status === 401 && idempotencyKey) {
        tokenProvider.invalidate({ organizationId: state.binding.organizationId });
        token = /** @type {any} */ (await tokenProvider.getToken(state.binding));
        upstream = await send();
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        sendSafeError(response, 502, "upstream_redirect");
        return;
      }
      response.statusCode = upstream.status;
      response.setHeader("Cache-Control", "no-store");
      for (const name of SAFE_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      if (!upstream.body) {
        response.end();
        return;
      }
      for await (const chunk of upstream.body) {
        if (!response.write(chunk)) await once(response, "drain");
      }
      response.end();
    } catch (error) {
      if (!response.headersSent) sendSafeError(response, controller.signal.aborted ? 504 : 502, controller.signal.aborted ? "timeout" : "upstream_unavailable");
      else response.destroy();
    } finally {
      clearTimeout(timeout);
      request.removeListener("aborted", onClose);
      response.removeListener("close", onClose);
    }
  }

  async function start(rawBinding) {
    if (disposed) throw new CodexCredentialBrokerError("disposed");
    if (state) throw new CodexCredentialBrokerError("already_started");
    const binding = {
      organizationId: String(rawBinding?.organizationId ?? "").trim(),
      deviceId: String(rawBinding?.deviceId ?? "").trim(),
      providerId: String(rawBinding?.providerId ?? "").trim(),
    };
    if (Object.values(binding).some((value) => !value)) throw new TypeError("Codex broker binding is invalid.");
    state = {
      binding,
      localSecret: randomBytes(32).toString("base64url"),
      pathNonce: randomBytes(24).toString("base64url"),
    };
    server = createServer((request, response) => void proxy(request, response));
    server.maxHeadersCount = 64;
    server.requestTimeout = timeoutMs;
    server.headersTimeout = Math.min(timeoutMs, 30_000);
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
    } catch {
      state = null;
      server = null;
      throw new CodexCredentialBrokerError("listen_failed");
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new CodexCredentialBrokerError("listen_failed");
    return Object.freeze({
      baseUrl: `http://127.0.0.1:${address.port}/${state.pathNonce}/v1`,
      localSecret: state.localSecret,
    });
  }

  function status() {
    return Object.freeze({ running: Boolean(server?.listening), organizationId: state?.binding.organizationId ?? null });
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    state = null;
    const active = server;
    server = null;
    if (active?.listening) {
      const closed = once(active, "close");
      active.closeAllConnections?.();
      active.close();
      await closed;
    }
  }

  return Object.freeze({ start, status, dispose });
}
