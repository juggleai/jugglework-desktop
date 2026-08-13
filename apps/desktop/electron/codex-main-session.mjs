function normalize(input) {
  if (input == null) return null;
  const baseUrl = String(input.baseUrl ?? "").trim();
  const bearerToken = String(input.bearerToken ?? "").trim();
  const organizationId = String(input.organizationId ?? "").trim();
  if (!baseUrl || !bearerToken || !organizationId) return null;
  let url;
  try { url = new URL(baseUrl); } catch { return null; }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return Object.freeze({ baseUrl: url.toString(), bearerToken, organizationId });
}

/** In-memory handoff of the app's existing login session to Electron Main. */
export function createCodexMainSession() {
  let current = null;

  function sync(input) {
    const previousOrganizationId = current?.organizationId ?? null;
    current = normalize(input);
    return Object.freeze({
      previousOrganizationId,
      organizationId: current?.organizationId ?? null,
      authenticated: current !== null,
    });
  }

  function get() { return current; }
  function status() {
    return Object.freeze({ authenticated: current !== null, organizationId: current?.organizationId ?? null });
  }

  return Object.freeze({ sync, get, status });
}
