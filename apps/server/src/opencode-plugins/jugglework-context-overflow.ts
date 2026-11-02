/**
 * Normalizes provider transport edge cases for OpenCode.
 *
 * OpenCode 1.18.x already understands `error.code=context_length_exceeded`,
 * but OpenAI-compatible relays sometimes return only plain text. Converting
 * that narrow failure shape preserves the provider message while allowing the
 * engine's existing automatic-compaction recovery to run.
 *
 * Cloud-managed OpenAI-compatible providers are also guarded against a truly
 * empty HTTP-200 SSE response. A request is retried at most once, and only
 * before any response-body byte has arrived. Once a stream is established it
 * is handed to OpenCode immediately and is never replayed.
 */

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const TLS_RETRY_DELAY_MS = 150;
const EMPTY_STREAM_RETRY_DELAYS_MS = [1_000] as const;
const EMPTY_STREAM_RETRY_HEADER = "x-jugglework-empty-stream-retry";
const MANAGED_GATEWAY_PATH = /\/jwork\/api\/gateway\/v1\/lpr_[a-z0-9._-]+(?:\/|$)/i;
// The managed gateway owns the authoritative 300-second upstream and stream
// idle deadlines. Keep the desktop slightly behind it so the gateway can
// return the real failure instead of being recorded as client_disconnected.
const PROVIDER_RESPONSE_TIMEOUT_MS = 330_000;
const PROVIDER_FIRST_BYTE_TIMEOUT_MS = 330_000;
const PROVIDER_CHUNK_TIMEOUT_MS = 330_000;

type EmptyStreamRetryReason = "empty" | "response_timeout" | "first_byte_timeout";

class ProviderStreamTimeoutError extends Error {
  constructor(public readonly reason: Exclude<EmptyStreamRetryReason, "empty">) {
    super(reason);
    this.name = "ProviderStreamTimeoutError";
  }
}

function providerTimeoutMs(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 10 && configured <= 10 * 60_000
    ? Math.floor(configured)
    : fallback;
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function transientTlsFailure(error: unknown): { code: string | null } | null {
  const records: Record<string, unknown>[] = [];
  let current = errorRecord(error);
  for (let depth = 0; current && depth < 5; depth += 1) {
    records.push(current);
    current = errorRecord(current.cause);
  }
  const code = records
    .map((record) => typeof record.code === "string" ? record.code.trim().toUpperCase() : "")
    .find(Boolean) ?? null;
  const text = records
    .map((record) => typeof record.message === "string" ? record.message : "")
    .join("\n")
    .toLowerCase();
  if (
    code?.startsWith("ERR_TLS_CERT_")
    || code === "CERT_HAS_EXPIRED"
    || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    || code === "SELF_SIGNED_CERT_IN_CHAIN"
    || text.includes("unknown certificate verification error")
    || text.includes("unable to verify the first certificate")
  ) {
    return { code };
  }
  return null;
}

function canReplayBody(body: BodyInit | null | undefined): boolean {
  if (body == null || typeof body === "string") return true;
  if (body instanceof URLSearchParams || body instanceof Blob || body instanceof FormData) return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  return false;
}

function sanitizedHost(input: Parameters<typeof fetch>[0]): string {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).host;
  } catch {
    return "unknown";
  }
}

async function fetchWithTransientTlsRetry(
  base: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  let retryInput: Parameters<typeof fetch>[0] = input;
  if (input instanceof Request) {
    try {
      retryInput = input.clone();
    } catch {
      // A consumed request cannot be replayed safely.
    }
  }
  const replayable = input instanceof Request ? retryInput !== input : canReplayBody(init?.body);
  try {
    return await base(input, init);
  } catch (error) {
    const tls = transientTlsFailure(error);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    if (!tls || !replayable || signal?.aborted) throw error;
    console.warn("JuggleWork provider TLS handshake failed; retrying once", {
      host: sanitizedHost(input),
      code: tls.code ?? "certificate_verification_error",
    });
    await new Promise((resolve) => setTimeout(resolve, TLS_RETRY_DELAY_MS));
    if (signal?.aborted) throw error;
    return base(retryInput, init);
  }
}

function responseWithBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function inspectEmptyProviderStream(
  response: Response,
  signal: AbortSignal | null,
  abortAttempt: (reason?: unknown) => void,
): Promise<{ retry: boolean; reason?: EmptyStreamRetryReason; response?: Response }> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    return { retry: false, response };
  }

  // Keep one owner of the network reader. Tee cancellation can leave the
  // sibling alive during retries, and can deadlock while handing off output.
  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  const handoff = () => {
    let index = 0;
    return responseWithBody(response, new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < prefix.length) {
          controller.enqueue(prefix[index++]!);
          return;
        }
        try {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        abortAttempt(reason);
        await reader.cancel(reason).catch(() => undefined);
      },
    }));
  };
  const firstByteDeadline = Date.now() + providerTimeoutMs(
    "JUGGLEWORK_PROVIDER_FIRST_BYTE_TIMEOUT_MS",
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  );

  const readBeforeDeadline = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    const timeoutMs = Math.max(0, firstByteDeadline - Date.now());
    return await new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (work: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        work();
      };
      const onAbort = () => settle(() => reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError")));
      const timer = setTimeout(
        () => settle(() => reject(new ProviderStreamTimeoutError("first_byte_timeout"))),
        timeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      reader.read().then(
        (result) => settle(() => resolve(result)),
        (error) => settle(() => reject(error)),
      );
    });
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      const { done, value } = await readBeforeDeadline();
      if (done) {
        abortAttempt();
        await reader.cancel().catch(() => undefined);
        return { retry: true, reason: "empty" };
      }
      if (!value?.byteLength) continue;
      prefix.push(value);
      // A 2xx SSE response that has produced bytes is already a live model
      // stream. The first frame may be a role, metadata, or keepalive while a
      // high-reasoning model works for several minutes. Hand it off now and
      // never replay the established request.
      return { retry: false, response: handoff() };
    }
  } catch (error) {
    // Abort the actual fetch before releasing its body or starting a retry.
    // Cancelling only a stream wrapper does not reliably stop every runtime's
    // upstream transport. Use the caller's signal to distinguish user abort.
    abortAttempt(error);
    await reader.cancel(error).catch(() => undefined);
    if (error instanceof ProviderStreamTimeoutError && !signal?.aborted) {
      return { retry: true, reason: error.reason };
    }
    throw error;
  }
}

async function fetchProviderResponse(
  base: typeof fetch,
  request: Request,
): Promise<{ response: Response; abort: (reason?: unknown) => void }> {
  const timeoutController = new AbortController();
  const combinedSignal = AbortSignal.any([request.signal, timeoutController.signal]);
  const timeoutMs = providerTimeoutMs("JUGGLEWORK_PROVIDER_RESPONSE_TIMEOUT_MS", PROVIDER_RESPONSE_TIMEOUT_MS);
  const timer = setTimeout(
    () => timeoutController.abort(new ProviderStreamTimeoutError("response_timeout")),
    timeoutMs,
  );
  try {
    const response = await fetchWithTransientTlsRetry(base, new Request(request.clone(), { signal: combinedSignal }));
    return { response, abort: (reason) => timeoutController.abort(reason) };
  } catch (error) {
    if (timeoutController.signal.aborted && !request.signal.aborted) {
      throw new ProviderStreamTimeoutError("response_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRetry(delayMs: number, signal: AbortSignal | null): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function markedStreamingRequest(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<{ request: Request; signal: AbortSignal | null; stream: boolean } | null> {
  let request: Request;
  try {
    request = new Request(input, init);
  } catch {
    return null;
  }
  const marked = request.headers.get(EMPTY_STREAM_RETRY_HEADER) === "1";
  // OpenCode provider SDKs can capture `fetch` before chat headers are applied.
  // The URL fallback keeps the managed gateway on the guarded transport even
  // when a provider integration drops the private marker header.
  if (!marked && !MANAGED_GATEWAY_PATH.test(request.url)) return null;
  const headers = new Headers(request.headers);
  headers.delete(EMPTY_STREAM_RETRY_HEADER);
  const sanitized = new Request(request.clone(), { headers });
  if (sanitized.method !== "POST") return { request: sanitized, signal: sanitized.signal, stream: false };
  try {
    const payload = await sanitized.clone().json() as { stream?: unknown };
    return { request: sanitized, signal: sanitized.signal, stream: payload.stream === true };
  } catch {
    return { request: sanitized, signal: sanitized.signal, stream: false };
  }
}

async function fetchWithEmptyStreamRetry(
  base: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const marked = await markedStreamingRequest(input, init);
  if (!marked) return fetchWithTransientTlsRetry(base, input, init);

  // A marked request that is not a replayable streaming JSON request is still
  // sanitized before dispatch, but is deliberately not retried.
  if (!marked.stream) return fetchWithTransientTlsRetry(base, marked.request.clone());

  let lastReason: EmptyStreamRetryReason = "empty";
  for (let attempt = 0; attempt <= EMPTY_STREAM_RETRY_DELAYS_MS.length; attempt += 1) {
    let inspected: Awaited<ReturnType<typeof inspectEmptyProviderStream>>;
    try {
      const provider = await fetchProviderResponse(base, marked.request);
      inspected = await inspectEmptyProviderStream(provider.response, marked.signal, provider.abort);
    } catch (error) {
      if (!(error instanceof ProviderStreamTimeoutError) || marked.signal?.aborted) throw error;
      inspected = { retry: true, reason: error.reason };
    }
    if (!inspected.retry) {
      if (!inspected.response) throw new Error("Provider stream inspection returned no response.");
      return inspected.response;
    }
    lastReason = inspected.reason ?? "empty";
    if (attempt === EMPTY_STREAM_RETRY_DELAYS_MS.length) {
      const message = lastReason === "empty"
        ? `Provider returned an empty response after ${attempt + 1} attempts.`
        // Do not use OpenCode's generic timeout phrases here. They are treated
        // as retryable by the outer session loop and would replay another full
        // retry cycle after this transport has already exhausted its budget.
        : `Managed model produced no output after ${attempt + 1} attempts (${lastReason}).`;
      throw new Error(message);
    }
    console.warn("JuggleWork provider stream produced no output; retrying", {
      host: sanitizedHost(marked.request),
      attempt: attempt + 1,
      maxAttempts: EMPTY_STREAM_RETRY_DELAYS_MS.length,
      reason: lastReason,
    });
    await waitForRetry(EMPTY_STREAM_RETRY_DELAYS_MS[attempt]!, marked.signal);
  }
  throw new Error("unreachable");
}

function contextOverflowMessage(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("throttl") ||
    lower.includes("service unavailable")
  ) {
    return null;
  }
  if (
    lower.includes("context_length_exceeded") ||
    lower.includes("exceeds the context window") ||
    lower.includes("maximum context length") ||
    lower.includes("input is too long for requested model") ||
    lower.includes("prompt is too long") ||
    lower.includes("too many tokens") ||
    lower.includes("token limit exceeded")
  ) {
    try {
      const parsed = JSON.parse(normalized) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) {
        return parsed.error.message.trim();
      }
    } catch {
      // Plain text is the compatibility case this plugin exists for.
    }
    return normalized;
  }
  return null;
}

async function normalizedProviderErrorResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ERROR_BODY_BYTES) return response;

  let text: string;
  try {
    text = await response.clone().text();
  } catch {
    return response;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_ERROR_BODY_BYTES) return response;
  // The managed gateway uses HTTP 409 for an exhausted points wallet. SDKs
  // retry conflicts, although this failure cannot recover through backoff.
  // Expose it as a non-retryable billing error so OpenCode ends the turn and
  // persists the error in session history, including for unattended tasks.
  const lower = text.toLowerCase();
  if (lower.includes("insufficient_points") || lower.includes("does not have enough available points")) {
    let message = "The organization does not have enough available points for this managed model request.";
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) message = parsed.error.message;
    } catch {
      message = text.trim() || message;
    }
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    headers.delete("retry-after");
    return new Response(JSON.stringify({
      type: "error",
      error: { code: "insufficient_points", type: "insufficient_quota", message },
    }), { status: 402, statusText: "Payment Required", headers });
  }
  if (response.status === 429) return response;
  const message = contextOverflowMessage(text);
  if (!message) return response;

  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    if (parsed.error?.code === "context_length_exceeded") return response;
  } catch {
    // Rewrite the plain response below.
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify({
    type: "error",
    error: { code: "context_length_exceeded", type: "invalid_request_error", message },
  }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

let installed = false;
let managedProviderFetch: typeof fetch | null = null;

function installContextOverflowFetchPatch(): typeof fetch {
  if (installed && managedProviderFetch) return managedProviderFetch;
  installed = true;
  const base = globalThis.fetch;
  const patched = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    return normalizedProviderErrorResponse(await fetchWithEmptyStreamRetry(base, input, init));
  };
  managedProviderFetch = Object.assign(patched, base);
  globalThis.fetch = managedProviderFetch;
  return managedProviderFetch;
}

// Single export: the OpenCode plugin loader treats every export as a factory.
export const JuggleWorkContextOverflow = async () => {
  const providerFetch = installContextOverflowFetchPatch();
  return {
    config: async (config: {
      provider?: Record<string, { options?: Record<string, unknown> }>;
    }) => {
      for (const [providerID, provider] of Object.entries(config.provider ?? {})) {
        if (!/^lpr_/i.test(providerID) || !provider || typeof provider !== "object") continue;
        const options = provider.options && typeof provider.options === "object" ? provider.options : {};
        provider.options = {
          ...options,
          // Bind the guard directly to the provider. Patching global fetch is
          // insufficient when an SDK captured the old function during import.
          fetch: providerFetch,
          // The custom fetch owns the per-attempt response-header deadline and
          // its bounded retry. Keep OpenCode's outer header timer from
          // aborting that cycle. The outer idle timer stays behind the
          // gateway's authoritative 300-second stream-idle deadline.
          headerTimeout: false,
          chunkTimeout: providerTimeoutMs(
            "JUGGLEWORK_PROVIDER_NO_PROGRESS_TIMEOUT_MS",
            PROVIDER_CHUNK_TIMEOUT_MS,
          ),
        };
      }
    },
    "chat.headers": async (
      input: { model?: { providerID?: string } },
      output: { headers: Record<string, string> },
    ) => {
      if (/^lpr_/i.test(input.model?.providerID ?? "")) {
        output.headers[EMPTY_STREAM_RETRY_HEADER] = "1";
      }
    },
  };
};
