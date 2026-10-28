import { createHash } from "node:crypto";

const resourcePath = "/static/doc/js/feature-pc-7458-6617ed03.js";
const resourceHash = "f5a6e8bf58cb14ac4c7275a1f98e9f1dae2a90486ad5f8cc188a75702fe9a2fa";

/** Deadline includes response-body consumption, not just receipt of headers. */
export async function fetchOfficeFont(url, fetchImpl = fetch, timeoutMs = 15000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { signal: controller.signal, credentials: "omit" });
        if (!response.ok) throw new Error("Font download failed: " + response.status);
        const blob = await response.blob();
        if (!blob.size) throw new Error("Font download returned no data");
        return { blob: () => Promise.resolve(blob) };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Font download timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Exact bundled SDK adaptation; unknown revisions are never rewritten. */
export async function configureOfficeFontResponse(request, response, host) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== host.origin || url.pathname !== resourcePath || !response.ok) return response;
  const source = await response.text();
  if (createHash("sha256").update(source).digest("hex") !== resourceHash) {
    return new Response(source, { status: response.status, headers: response.headers });
  }
  // A null result bypasses the SDK's existing error/finalization branch.
  // Throw instead and drop rejected cached requests so explicit retry is real.
  const patched = source
    .replace("r=fetch(n),this.cdnFetchCache.set(n,r)", "r=__juggleworkFetchFont(n),this.cdnFetchCache.set(n,r)")
    .replace("case 5:return i.sent(),[2,null];case 6:return[4,this.cacheFetchedFontBlob(e,o)]", "case 5:throw this.cdnFetchCache.delete(n),i.sent();case 6:return[4,this.cacheFetchedFontBlob(e,o)]");
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest"]) headers.delete(name);
  headers.set("Cache-Control", "no-store");
  return new Response(`const __juggleworkFetchFont=(${fetchOfficeFont.toString()});\n${patched}`, { status: response.status, headers });
}
