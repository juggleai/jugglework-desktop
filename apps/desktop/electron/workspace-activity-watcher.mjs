/**
 * Keeps Live Activity subscriptions aligned with the canonical Desktop
 * workspace store. Remote workspaces are served elsewhere and are not local
 * managed-runtime SSE sources.
 *
 * @param {{
 *   workspaceStore: {
 *     migrateLegacyElectronWorkspaceStateIfNeeded(): Promise<unknown>,
 *     readWorkspaceState(): Promise<unknown>,
 *   },
 *   getBridge: () => { watch(workspaces: Array<{ id: string, name?: string }>): boolean } | null,
 *   logger?: { warn?: (message: string, error?: unknown) => void },
 * }} options
 */
export function createWorkspaceActivityWatcher({ workspaceStore, getBridge, logger = {} }) {
  if (!workspaceStore || typeof workspaceStore.migrateLegacyElectronWorkspaceStateIfNeeded !== "function" ||
      typeof workspaceStore.readWorkspaceState !== "function" || typeof getBridge !== "function") {
    throw new TypeError("Workspace activity watcher dependencies are invalid.");
  }

  async function refresh() {
    const state = await workspaceStore.readWorkspaceState();
    const workspaces = Array.isArray(state?.workspaces)
      ? state.workspaces.filter((entry) => entry?.workspaceType !== "remote")
      : [];
    getBridge()?.watch(workspaces);
    return state;
  }

  async function initialize() {
    await workspaceStore.migrateLegacyElectronWorkspaceStateIfNeeded();
    return refresh();
  }

  /** @template T @param {() => Promise<T>} mutation */
  async function mutate(mutation) {
    try {
      return await mutation();
    } finally {
      await refresh().catch((error) => {
        try { logger.warn?.("[desktop-remote] failed to refresh activity workspaces", error); } catch {}
      });
    }
  }

  return Object.freeze({ initialize, mutate, refresh });
}
