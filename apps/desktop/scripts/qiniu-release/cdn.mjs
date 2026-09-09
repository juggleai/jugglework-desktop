import { createHash } from "node:crypto";

import { CDN_ORIGIN } from "./constants.mjs";

function assertResponse(response, label, statuses = [200]) {
  if (!statuses.includes(response.status)) throw new Error(`${label} returned HTTP ${response.status}`);
}

function contentType(headers) {
  return (headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

function requiredContentLength(response, expected, label) {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw) || Number(raw) !== expected) {
    throw new Error(`${label} Content-Length mismatch: expected ${expected}, received ${raw ?? "<missing>"}`);
  }
}

export async function verifyCdnObject(object, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("CDN fetch operation is unavailable");
  const url = new URL(object.url);
  if (url.protocol !== "https:" || url.origin !== CDN_ORIGIN) throw new Error(`Unapproved CDN URL: ${object.url}`);

  let metadataResponse = await fetchImpl(object.url, { method: "HEAD", redirect: "error" });
  if (metadataResponse.status === 405 || metadataResponse.status === 501) {
    metadataResponse = await fetchImpl(object.url, { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "error" });
    assertResponse(metadataResponse, `Metadata GET ${object.key}`, [200, 206]);
  } else {
    assertResponse(metadataResponse, `HEAD ${object.key}`);
  }
  requiredContentLength(metadataResponse, metadataResponse.status === 206 ? 1 : object.size, `CDN metadata for ${object.key}`);
  const actualMime = contentType(metadataResponse.headers);
  if (actualMime !== object.mime) throw new Error(`CDN MIME mismatch for ${object.key}: ${actualMime || "<missing>"}`);

  const range = await fetchImpl(object.url, { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "error" });
  assertResponse(range, `Range GET ${object.key}`, [206]);
  requiredContentLength(range, 1, `CDN range for ${object.key}`);
  if (range.headers.get("content-range") !== `bytes 0-0/${object.size}`) {
    throw new Error(`CDN Content-Range mismatch for ${object.key}`);
  }
  const rangeBody = Buffer.from(await range.arrayBuffer());
  if (rangeBody.length !== 1) throw new Error(`CDN byte range returned ${rangeBody.length} bytes for ${object.key}`);

  const full = await fetchImpl(object.url, { method: "GET", redirect: "error" });
  assertResponse(full, `Full GET ${object.key}`);
  requiredContentLength(full, object.size, `CDN full response for ${object.key}`);
  const body = Buffer.from(await full.arrayBuffer());
  const sha512 = createHash("sha512").update(body).digest("base64");
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (body.length !== object.size || sha512 !== object.sha512) {
    throw new Error(`CDN size or SHA-512 mismatch for ${object.key}`);
  }
  if (object.sha256 && sha256 !== object.sha256) throw new Error(`CDN SHA-256 mismatch for ${object.key}`);
  return {
    url: object.url,
    https: true,
    mime: actualMime,
    contentLength: object.size,
    range: true,
    size: body.length,
    sha256,
    sha512,
    checkedAt: new Date().toISOString(),
  };
}

export async function readBackDigest(url, expectedSha256, {
  fetchImpl = globalThis.fetch,
  expectedSize,
  attempts = 8,
  intervalMs = 1_000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("CDN read-back operation is unavailable");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) throw new Error("Read-back attempts must be between 1 and 60");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) throw new Error("Read-back interval must be between 0 and 60000ms");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.origin !== CDN_ORIGIN) throw new Error(`Unapproved CDN URL: ${url}`);
  let last = "no response";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { method: "GET", cache: "no-store", redirect: "error" });
      assertResponse(response, "Channel manifest read-back");
      const rawLength = response.headers.get("content-length");
      if (rawLength === null || !/^\d+$/.test(rawLength)) throw new Error("Channel manifest read-back Content-Length is missing or invalid");
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentLength = Number(rawLength);
      if (contentLength !== bytes.length || (expectedSize !== undefined && contentLength !== expectedSize)) {
        throw new Error(`Channel manifest read-back Content-Length mismatch: ${contentLength}`);
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest === expectedSha256) {
        return { url, sha256: digest, size: bytes.length, attempts: attempt, checkedAt: new Date().toISOString() };
      }
      last = digest;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`Channel manifest digest has not converged after ${attempts} attempts: ${last}`);
}
