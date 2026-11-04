// Shared by Electron main and the wiring integration tests.
/** @param {{ getJson: (path: string, options: {signal: AbortSignal}) => Promise<any> }} managedRuntimeClient
 * @param {{ reconciliationTimeoutMs?: number }} options */
export function createMainActivityTerminalOptions(managedRuntimeClient, { reconciliationTimeoutMs = 10_000 } = {}) {
  const reconciling = new Map();
  return {
    timers: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
    listRunTerminals: async ({ workspaceId, after, signal, lifetimeSignal = signal }) => {
      // Reconciliation may wait for engine authority. It must never gate reads
      // of already durable terminals. Bound it to one request per workspace;
      // a replacement subscription may start immediately after the old abort.
      if (!lifetimeSignal.aborted && !reconciling.has(workspaceId)) {
        const controller = new AbortController();
        reconciling.set(workspaceId, controller);
        const cleanup = () => {
          clearTimeout(timeout);
          lifetimeSignal.removeEventListener("abort", abort);
          if (reconciling.get(workspaceId) === controller) reconciling.delete(workspaceId);
        };
        const abort = () => { cleanup(); controller.abort(); };
        const timeout = setTimeout(abort, reconciliationTimeoutMs);
        lifetimeSignal.addEventListener("abort", abort, { once: true });
        void Promise.resolve().then(() => managedRuntimeClient.getJson(
          `/workspace/${encodeURIComponent(workspaceId)}/session-runs`, { signal: controller.signal },
        )).catch(() => undefined).finally(cleanup);
      }
      return managedRuntimeClient.getJson(
        `/workspace/${encodeURIComponent(workspaceId)}/session-run-terminals?after=${after}&limit=100`, { signal },
      );
    },
  };
}
