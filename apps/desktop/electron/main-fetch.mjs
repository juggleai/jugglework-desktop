export function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return (url.protocol === "http:" || url.protocol === "https:") && (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * Chromium's network service can stall when it calls an HTTP server hosted in
 * this same Electron main process. Use Node's fetch for loopback traffic so
 * the embedded JuggleWork server can continue handling the request; keep
 * Electron net.fetch for external traffic so it retains the app's network and
 * certificate behavior.
 */
export function selectMainProcessFetch(url, { nodeFetch, electronFetch }) {
  return isLoopbackHttpUrl(url) ? nodeFetch : electronFetch;
}
