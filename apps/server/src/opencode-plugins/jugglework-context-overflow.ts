/**
 * Normalizes non-streaming provider context-overflow responses for OpenCode.
 *
 * OpenCode 1.18.x already understands `error.code=context_length_exceeded`,
 * but OpenAI-compatible relays sometimes return only plain text. Converting
 * that narrow failure shape preserves the provider message while allowing the
 * engine's existing automatic-compaction recovery to run.
 */

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const TLS_RETRY_DELAY_MS = 150;

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

async function normalizedOverflowResponse(response: Response): Promise<Response> {
  if (response.ok || response.status === 429) return response;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ERROR_BODY_BYTES) return response;

  let text: string;
  try {
    text = await response.clone().text();
  } catch {
    return response;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_ERROR_BODY_BYTES) return response;
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

function installContextOverflowFetchPatch(): void {
  if (installed) return;
  installed = true;
  const base = globalThis.fetch;
  const patched = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    return normalizedOverflowResponse(await fetchWithTransientTlsRetry(base, input, init));
  };
  globalThis.fetch = Object.assign(patched, base);
}

// Single export: the OpenCode plugin loader treats every export as a factory.
export const JuggleWorkContextOverflow = async () => {
  installContextOverflowFetchPatch();
  return {};
};
