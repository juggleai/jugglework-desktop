const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Let concurrent cleanup callers await the same in-flight work. Once it
 * settles, a later caller starts a fresh attempt so updater retries re-check
 * that shutdown is still complete.
 */
export function createJoinableCleanup(cleanup) {
  if (typeof cleanup !== "function") throw new TypeError("Cleanup must be a function");
  let inFlight = null;

  return function runCleanup() {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(cleanup)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

/**
 * Wait for graceful shutdown without allowing a stuck collaborator to block
 * Squirrel.Mac forever. The underlying cleanup promises are not cancelled;
 * Electron exits after the bounded grace period so ShipIt can replace the app.
 */
export async function waitForQuitCleanup(
  tasks,
  {
    timeoutMs = DEFAULT_QUIT_CLEANUP_TIMEOUT_MS,
    setTimeoutFn = globalThis.setTimeout.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
  } = {},
) {
  if (!Array.isArray(tasks)) throw new TypeError("Quit cleanup tasks must be an array");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("Quit cleanup timeout must be positive");

  let timeoutId;
  const settled = Promise.allSettled(tasks).then((results) => ({ timedOut: false, results }));
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeoutFn(() => resolve({ timedOut: true, results: [] }), timeoutMs);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeoutFn(timeoutId);
  }
}

export { DEFAULT_QUIT_CLEANUP_TIMEOUT_MS };
