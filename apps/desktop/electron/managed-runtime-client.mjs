const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

/** @param {unknown} value @returns {value is string} */
function safeIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export class ManagedRuntimeClientError extends Error {
  /**
   * @param {"unavailable" | "redirect" | "http_error" | "invalid_response" | "response_too_large" | "timeout"} code
   */
  constructor(code, metadata) {
    super("The managed runtime request failed.");
    this.name = "ManagedRuntimeClientError";
    this.code = code;
    /** @type {number | null} */
    this.status = null;
    this.serverCode = safeIdentifier(metadata?.serverCode) ? metadata.serverCode : null;
    this.currentRunId = safeIdentifier(metadata?.currentRunId) ? metadata.currentRunId : null;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {readonly string[]} keys */
function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** @param {unknown} value */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** @param {Response} response @param {number} limit */
async function readBoundedJson(response, limit) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function runtimeAccess(value) {
  if (!isRecord(value) || !hasExactKeys(value, ["baseUrl", "clientToken"])) throw new ManagedRuntimeClientError("unavailable");
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  const clientToken = typeof value.clientToken === "string" ? value.clientToken.trim() : "";
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ManagedRuntimeClientError("unavailable");
  }
  if (!clientToken || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new ManagedRuntimeClientError("unavailable");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return { baseUrl: url.toString().replace(/\/+$/, ""), clientToken };
}

/**
 * Creates a deliberately narrow JSON client for the Main-managed local server.
 * The collaborator token is obtained lazily and is never returned by this API.
 *
 * @param {{
 *   getAccess(): unknown | Promise<unknown>,
 *   fetcher?: typeof fetch,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 * }} options
 */
export function createManagedRuntimeClient({
  getAccess,
  fetcher = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  if (typeof getAccess !== "function" || typeof fetcher !== "function" || !positiveInteger(timeoutMs) || !positiveInteger(maxResponseBytes)) {
    throw new TypeError("Managed runtime client options are invalid.");
  }

  /** @param {string} pathname */
  async function getJson(pathname) {
    return requestJson("GET", pathname, null);
  }

  /**
   * @param {string} pathname
   * @param {unknown} body
   * @returns {Promise<unknown>} Parsed JSON, or null for 204 No Content.
   */
  async function postJson(pathname, body) {
    return requestJson("POST", pathname, body);
  }

  /**
   * @param {"GET" | "POST"} method
   * @param {string} pathname
   * @param {unknown} body
   * @returns {Promise<unknown>}
   */
  async function requestJson(method, pathname, body) {
    const access = runtimeAccess(await getAccess());
    const path = String(pathname ?? "");
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
      throw new TypeError("Managed runtime paths must be absolute pathnames.");
    }
    const url = new URL(path, `${access.baseUrl}/`);
    if (url.origin !== new URL(access.baseUrl).origin) throw new TypeError("Managed runtime path escaped its origin.");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      /** @type {Response} */
      let response;
      try {
        /** @type {RequestInit} */
        const init = {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${access.clientToken}`,
          },
          credentials: "omit",
          cache: "no-store",
          redirect: "manual",
          signal: controller.signal,
        };
        if (body !== null) {
          init.headers = { ...init.headers, "Content-Type": "application/json" };
          init.body = JSON.stringify(body);
        }
        response = await fetcher(url, init);
      } catch (error) {
        if (controller.signal.aborted) throw new ManagedRuntimeClientError("timeout");
        throw new ManagedRuntimeClientError("unavailable");
      }

      if (response.status >= 300 && response.status < 400) throw new ManagedRuntimeClientError("redirect");
      // 204 No Content — prompt_async returns empty body on success.
      if (response.status === 204) return null;
      if (!response.ok) {
        const payload = await readBoundedJson(response, Math.min(maxResponseBytes, MAX_ERROR_RESPONSE_BYTES));
        const details = isRecord(payload) && isRecord(payload.details) ? payload.details : null;
        const error = new ManagedRuntimeClientError("http_error", {
          serverCode: isRecord(payload) ? payload.code : null,
          currentRunId: details?.currentRunId,
        });
        error.status = response.status;
        throw error;
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        throw new ManagedRuntimeClientError("response_too_large");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new ManagedRuntimeClientError("invalid_response");
      const chunks = [];
      let byteLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ManagedRuntimeClientError("response_too_large");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let parsed;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new ManagedRuntimeClientError("invalid_response");
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({ getJson, postJson });
}
