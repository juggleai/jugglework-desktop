import {
  CODEX_GATEWAY_AUDIENCE,
  CODEX_GATEWAY_SCOPE,
  CODEX_GATEWAY_TOKEN_PATH,
  CODEX_MODEL_CATALOG_PATH,
  codexGatewayErrorSchema,
  codexModelCatalogResponseSchema,
  codexGatewayTokenRequestSchema,
  codexGatewayTokenResponseSchema,
} from "../dist/runtime/codex-gateway.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export class CodexGatewayTokenError extends Error {
  /** @param {string} code @param {{ status?: number | null, retryable?: boolean, retryAfterMs?: number | null }} [metadata] */
  constructor(code, metadata = {}) {
    super("Codex gateway authentication failed.");
    this.name = "CodexGatewayTokenError";
    this.code = code;
    this.status = Number.isInteger(metadata.status) ? metadata.status : null;
    this.retryable = metadata.retryable === true;
    this.retryAfterMs = Number.isSafeInteger(metadata.retryAfterMs) && metadata.retryAfterMs >= 0
      ? metadata.retryAfterMs
      : null;
  }
}

function denApiBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new CodexGatewayTokenError("AUTH_REQUIRED");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CodexGatewayTokenError("AUTH_REQUIRED");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.toLowerCase().endsWith("/jwork/api")) {
    pathname = pathname.toLowerCase().endsWith("/jwork") ? `${pathname}/api` : `${pathname}/jwork/api`;
  }
  url.pathname = pathname.replace(/\/+/g, "/");
  url.search = "";
  url.hash = "";
  return url;
}

async function boundedJson(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new CodexGatewayTokenError("INVALID_RESPONSE");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new CodexGatewayTokenError("INVALID_RESPONSE");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CodexGatewayTokenError("INVALID_RESPONSE");
  }
}

/**
 * Builds the Main-process-only Den exchange function. `getSession` must read
 * the current login session from a Main-owned broker; its result is consumed
 * here and is never returned through IPC.
 *
 * @param {{
 *   getSession(): Promise<{ baseUrl: string, bearerToken: string, organizationId: string } | null> | { baseUrl: string, bearerToken: string, organizationId: string } | null,
 *   fetcher?: typeof fetch,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 * }} options
 */
export function createDenCodexGatewayExchange({
  getSession,
  fetcher = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  if (typeof getSession !== "function" || typeof fetcher !== "function") throw new TypeError("Codex gateway exchange options are invalid.");

  return async (rawRequest) => {
    const request = codexGatewayTokenRequestSchema.parse(rawRequest);
    const session = await getSession();
    if (!session || typeof session.bearerToken !== "string" || !session.bearerToken || session.organizationId !== request.organizationId) {
      throw new CodexGatewayTokenError("AUTH_REQUIRED");
    }
    const baseUrl = denApiBaseUrl(session.baseUrl);
    const url = new URL(`${baseUrl.pathname}${CODEX_GATEWAY_TOKEN_PATH}`.replace(/\/+/g, "/"), baseUrl.origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetcher(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${session.bearerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          cache: "no-store",
          credentials: "omit",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        throw new CodexGatewayTokenError(controller.signal.aborted ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_UNAVAILABLE", { retryable: true });
      }
      if (response.status >= 300 && response.status < 400) throw new CodexGatewayTokenError("INVALID_RESPONSE");
      const payload = await boundedJson(response, maxResponseBytes);
      if (!response.ok) {
        const parsed = codexGatewayErrorSchema.safeParse(payload);
        throw new CodexGatewayTokenError(parsed.success ? parsed.data.error.code : "UPSTREAM_UNAVAILABLE", {
          status: response.status,
          retryable: parsed.success ? parsed.data.error.retryable : response.status >= 500,
          retryAfterMs: parsed.success ? parsed.data.error.retryAfterMs : null,
        });
      }
      const parsed = codexGatewayTokenResponseSchema.safeParse(payload);
      if (!parsed.success) throw new CodexGatewayTokenError("INVALID_RESPONSE");
      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * Main-only organization model catalog loader. Unlike the OpenCode connect
 * response, this returns capability metadata and never returns a credential.
 *
 * @param {{
 *   getSession(): Promise<{ baseUrl: string, bearerToken: string, organizationId: string } | null> | { baseUrl: string, bearerToken: string, organizationId: string } | null,
 *   fetcher?: typeof fetch,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 * }} options
 */
export function createDenCodexModelCatalogLoader({
  getSession,
  fetcher = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  if (typeof getSession !== "function" || typeof fetcher !== "function") throw new TypeError("Codex model catalog options are invalid.");
  return async (rawRequest) => {
    const request = codexGatewayTokenRequestSchema.pick({ organizationId: true, providerId: true }).parse(rawRequest);
    const session = await getSession();
    if (!session || typeof session.bearerToken !== "string" || !session.bearerToken || session.organizationId !== request.organizationId) {
      throw new CodexGatewayTokenError("AUTH_REQUIRED");
    }
    const baseUrl = denApiBaseUrl(session.baseUrl);
    const url = new URL(`${baseUrl.pathname}${CODEX_MODEL_CATALOG_PATH}`.replace(/\/+/g, "/"), baseUrl.origin);
    url.searchParams.set("providerId", request.providerId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetcher(url, {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${session.bearerToken}` },
          cache: "no-store",
          credentials: "omit",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        throw new CodexGatewayTokenError("UPSTREAM_UNAVAILABLE", { retryable: true });
      }
      if (response.status >= 300 && response.status < 400) throw new CodexGatewayTokenError("INVALID_RESPONSE");
      const payload = await boundedJson(response, maxResponseBytes);
      if (!response.ok) {
        const parsedError = codexGatewayErrorSchema.safeParse(payload);
        throw new CodexGatewayTokenError(parsedError.success ? parsedError.data.error.code : "UPSTREAM_UNAVAILABLE", {
          status: response.status,
          retryable: parsedError.success ? parsedError.data.error.retryable : response.status >= 500,
          retryAfterMs: parsedError.success ? parsedError.data.error.retryAfterMs : null,
        });
      }
      const parsed = codexModelCatalogResponseSchema.safeParse(payload);
      if (!parsed.success || parsed.data.organizationId !== request.organizationId) {
        throw new CodexGatewayTokenError("INVALID_RESPONSE");
      }
      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * Main-owned cache and refresh state machine. Values returned from `getToken`
 * are intended only for the loopback Credential Broker and Codex child env.
 *
 * @param {{ exchange(request: unknown): Promise<unknown>, now?: () => number, refreshSkewMs?: number }} options
 */
export function createCodexGatewayTokenProvider({ exchange, now = Date.now, refreshSkewMs = DEFAULT_REFRESH_SKEW_MS }) {
  if (typeof exchange !== "function" || typeof now !== "function" || !Number.isSafeInteger(refreshSkewMs) || refreshSkewMs < 0) {
    throw new TypeError("Codex gateway token provider options are invalid.");
  }
  const cache = new Map();
  const inFlight = new Map();
  let generation = 0;

  const keyOf = (request) => `${request.organizationId}\u0000${request.deviceId}\u0000${request.providerId}`;

  async function getToken(rawRequest) {
    const request = codexGatewayTokenRequestSchema.parse(rawRequest);
    const key = keyOf(request);
    const cached = cache.get(key);
    if (cached && Date.parse(cached.expiresAt) - refreshSkewMs > now()) return cached;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const startedGeneration = generation;
    const pending = Promise.resolve(exchange(request)).then((rawResponse) => {
      const response = codexGatewayTokenResponseSchema.parse(rawResponse);
      const requiredScopes = CODEX_GATEWAY_SCOPE.split(" ");
      if (
        response.organizationId !== request.organizationId ||
        response.deviceId !== request.deviceId ||
        response.audience !== CODEX_GATEWAY_AUDIENCE ||
        requiredScopes.some((scope) => !response.scopes.includes(scope)) ||
        Date.parse(response.expiresAt) - refreshSkewMs <= now()
      ) {
        throw new CodexGatewayTokenError("INVALID_RESPONSE");
      }
      if (generation === startedGeneration) cache.set(key, response);
      return response;
    }).catch((error) => {
      if (error instanceof CodexGatewayTokenError) throw error;
      throw new CodexGatewayTokenError("INVALID_RESPONSE");
    }).finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  }

  function invalidate(filter = {}) {
    generation += 1;
    for (const [key, value] of cache) {
      if (!filter.organizationId || value.organizationId === filter.organizationId) cache.delete(key);
    }
  }

  return Object.freeze({ getToken, invalidate });
}
