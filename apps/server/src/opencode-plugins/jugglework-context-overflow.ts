/**
 * Normalizes non-streaming provider context-overflow responses for OpenCode.
 *
 * OpenCode 1.18.x already understands `error.code=context_length_exceeded`,
 * but OpenAI-compatible relays sometimes return only plain text. Converting
 * that narrow failure shape preserves the provider message while allowing the
 * engine's existing automatic-compaction recovery to run.
 */

const MAX_ERROR_BODY_BYTES = 64 * 1024;

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
    return normalizedOverflowResponse(await base(input, init));
  };
  globalThis.fetch = Object.assign(patched, base);
}

// Single export: the OpenCode plugin loader treats every export as a factory.
export const JuggleWorkContextOverflow = async () => {
  installContextOverflowFetchPatch();
  return {};
};
