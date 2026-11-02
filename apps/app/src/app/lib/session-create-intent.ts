// Shared across recreated SDK clients. Never log/persist credential scopes.
export function createSessionIntentTransport() {
  const intents = new Map<string, { key: string; fingerprint: string }>();
  return async (request: Request, send: (request: Request) => Promise<Response>) => {
    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.endsWith("/session")) return send(request);
    const digest = async (value: string) => Array.from(new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const scope = await digest(JSON.stringify([url.origin, url.pathname,
      request.headers.get("authorization"), request.headers.get("x-opencode-directory"), url.search]));
    const fingerprint = await digest(await request.clone().text());
    let intent = intents.get(scope);
    if (intent && intent.fingerprint !== fingerprint) throw new Error("A session creation has an unresolved result. Retry its original payload first.");
    if (!intent) {
      if (intents.size >= 1024) throw new Error("Too many unresolved session creations");
      intent = { key: `${Date.now()}.${crypto.randomUUID()}`, fingerprint };
      intents.set(scope, intent);
    }
    const headers = new Headers(request.headers);
    headers.set("X-JuggleWork-Create-Intent", intent.key);
    // Exceptions/5xx retain intent after UI singleflight settles. No blind expiry.
    const response = await send(new Request(request, { headers }));
    if (response.ok) {
      const body = await response.clone().json();
      if (typeof body?.id === "string" && intents.get(scope) === intent) intents.delete(scope);
    }
    return response;
  };
}
export const sessionIntentTransport = createSessionIntentTransport();
