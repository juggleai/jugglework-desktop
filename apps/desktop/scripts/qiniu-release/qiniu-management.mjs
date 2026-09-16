import { createHmac } from "node:crypto";

const DEFAULT_REGION_QUERY_ENDPOINT = "https://uc.qiniuapi.com/v4/query";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

function urlsafeBase64(value) {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function qiniuDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Qiniu request time is invalid");
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function assertCredential(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} is required for Qiniu object metadata management`);
  }
  return value;
}

function assertObjectKey(key) {
  if (typeof key !== "string" || key.length === 0 || Buffer.byteLength(key, "utf8") > 750 || /[\r\n\0]/.test(key)) {
    throw new Error("Qiniu object key is invalid");
  }
  return key;
}

function normalizeRsEndpoint(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("Qiniu region discovery did not return an RS endpoint");
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Qiniu region discovery returned an invalid RS endpoint");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "qiniuapi.com" && !hostname.endsWith(".qiniuapi.com")) {
    throw new Error("Qiniu region discovery returned an unapproved RS endpoint");
  }
  return url.origin;
}

async function responseDetail(response) {
  try {
    const text = await response.text();
    if (!text) return "<empty>";
    const parsed = JSON.parse(text);
    return String(parsed.error ?? parsed.message ?? `HTTP ${response.status}`).slice(0, 500);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function parseStat(value) {
  if (!value || typeof value !== "object") throw new Error("Qiniu stat response is invalid");
  const size = Number(value.fsize ?? value.size);
  const etag = value.hash ?? value.etag;
  if (!Number.isSafeInteger(size) || size < 0 || typeof etag !== "string" || etag.length === 0) {
    throw new Error("Qiniu stat response is missing object identity");
  }
  return {
    size,
    etag,
    ...(value.mimeType ?? value.mime ? { mime: value.mimeType ?? value.mime } : {}),
    ...(value.putTime === undefined ? {} : { putTime: String(value.putTime) }),
    ...(value.cacheControl === undefined ? {} : { cacheControl: String(value.cacheControl) }),
  };
}

function expectedStatIdentity(value) {
  const size = Number(value?.fsize ?? value?.size);
  const etag = value?.hash ?? value?.etag;
  const putTime = value?.putTime;
  if (!Number.isSafeInteger(size) || size < 0 || typeof etag !== "string" || !/^[A-Za-z0-9_-]+$/.test(etag)
    || putTime === undefined || !/^\d+$/.test(String(putTime))) {
    throw new Error("Expected Qiniu object identity is required for conditional metadata mutation");
  }
  return { size, etag, putTime: String(putTime) };
}

export function createQiniuManagementClient({
  bucket,
  accessKey,
  secretKey,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  regionQueryEndpoint = DEFAULT_REGION_QUERY_ENDPOINT,
  timeoutMs = 30_000,
} = {}) {
  assertCredential(bucket, "Qiniu bucket");
  assertCredential(accessKey, "Qiniu access key");
  assertCredential(secretKey, "Qiniu secret key");
  if (typeof fetchImpl !== "function") throw new Error("Qiniu management fetch operation is unavailable");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("Qiniu management timeout must be between 1000 and 120000ms");
  }
  const queryEndpoint = new URL(regionQueryEndpoint);
  if (queryEndpoint.protocol !== "https:" || queryEndpoint.username || queryEndpoint.password || queryEndpoint.port || queryEndpoint.hash
    || queryEndpoint.hostname.toLowerCase() !== "uc.qiniuapi.com" || queryEndpoint.pathname !== "/v4/query" || queryEndpoint.search) {
    throw new Error("Qiniu region query endpoint is invalid");
  }

  let rsEndpointPromise;

  async function timedFetch(url, init, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function discoverRsEndpoint() {
    if (!rsEndpointPromise) {
      rsEndpointPromise = (async () => {
        const url = new URL(queryEndpoint);
        url.searchParams.set("ak", accessKey);
        url.searchParams.set("bucket", bucket);
        const response = await timedFetch(url, { method: "GET", redirect: "error" }, "Qiniu region discovery");
        if (response.status !== 200) {
          throw new Error(`Qiniu region discovery failed with HTTP ${response.status}: ${await responseDetail(response)}`);
        }
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error("Qiniu region discovery returned invalid JSON");
        }
        return normalizeRsEndpoint(payload?.hosts?.[0]?.rs?.domains?.[0]);
      })();
      rsEndpointPromise.catch(() => { rsEndpointPromise = undefined; });
    }
    return rsEndpointPromise;
  }

  async function managementRequest(method, pathname) {
    const endpoint = await discoverRsEndpoint();
    const url = new URL(pathname, endpoint);
    if (url.origin !== endpoint || !url.pathname.startsWith("/")) throw new Error("Qiniu management request path is invalid");
    const date = qiniuDate(now());
    const signingText = `${method} ${url.pathname}${url.search}\nHost: ${url.host}\nContent-Type: ${FORM_CONTENT_TYPE}\nX-Qiniu-Date: ${date}\n\n`;
    const signature = urlsafeBase64(createHmac("sha1", secretKey).update(signingText).digest());
    const response = await timedFetch(url, {
      method,
      headers: {
        Authorization: `Qiniu ${accessKey}:${signature}`,
        "Content-Type": FORM_CONTENT_TYPE,
        "X-Qiniu-Date": date,
      },
      redirect: "error",
    }, `Qiniu ${method} ${url.pathname.split("/", 2)[1] || "management request"}`);
    return response;
  }

  async function stat(key) {
    const entry = urlsafeBase64(`${bucket}:${assertObjectKey(key)}`);
    const response = await managementRequest("GET", `/stat/${entry}`);
    if (response.status === 612) return null;
    if (response.status !== 200) throw new Error(`Qiniu management stat failed with HTTP ${response.status}: ${await responseDetail(response)}`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Qiniu management stat returned invalid JSON");
    }
    return parseStat(payload);
  }

  return {
    stat,

    async setCacheControl(key, cacheControl, expected) {
      assertObjectKey(key);
      if (typeof cacheControl !== "string" || cacheControl.trim() !== cacheControl || cacheControl.length === 0 || Buffer.byteLength(cacheControl, "utf8") > 1_024 || /[\r\n\0]/.test(cacheControl)) {
        throw new Error("Qiniu Cache-Control value is invalid");
      }
      const identity = expectedStatIdentity(expected);
      const entry = urlsafeBase64(`${bucket}:${key}`);
      const encodedCacheControl = urlsafeBase64(cacheControl);
      const conditions = [`hash=${identity.etag}`, `fsize=${identity.size}`, `putTime=${identity.putTime}`];
      const encodedConditions = urlsafeBase64(conditions.join("&"));
      const response = await managementRequest("POST", `/chgm/${entry}/cacheControl/${encodedCacheControl}/cond/${encodedConditions}`);
      if (response.status === 613) {
        throw new Error(`Qiniu conditional Cache-Control mutation refused because object identity changed: ${key}`);
      }
      if (response.status !== 200) {
        throw new Error(`Qiniu Cache-Control mutation failed with HTTP ${response.status}: ${await responseDetail(response)}`);
      }
      const remote = await stat(key);
      if (!remote) throw new Error(`Qiniu channel manifest disappeared after Cache-Control mutation: ${key}`);
      if (remote.size !== identity.size || remote.etag !== identity.etag) {
        throw new Error(`Qiniu channel manifest identity changed during Cache-Control verification: ${key}`);
      }
      if (remote.cacheControl !== cacheControl) {
        throw new Error(`Qiniu Cache-Control verification failed for ${key}: expected ${cacheControl}, received ${remote.cacheControl ?? "<missing>"}`);
      }
      return remote;
    },
  };
}
