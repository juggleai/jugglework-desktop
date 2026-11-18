import type { BootPhaseId } from "./boot-state";

export const BACKGROUND_WORKSPACE_SYNC_BATCH_SIZE = 2;
export const BACKGROUND_WORKSPACE_SYNC_BATCH_INTERVAL_MS = 500;
export const BACKGROUND_WORKSPACE_DISCOVERY_INTERVAL_MS = 15_000;

/**
 * Desktop background subscriptions must wait until the host has finished
 * booting OpenCode. Web runtimes have no native boot sequence to wait for.
 * `idle + routeReady` covers a dev HMR remount after the runtime is already up.
 */
export function backgroundWorkspaceSyncIsReady(input: {
  desktop: boolean;
  phase: BootPhaseId | undefined;
  routeReady: boolean | undefined;
}) {
  if (!input.desktop) return true;
  return input.phase === "ready" || (input.phase === "idle" && input.routeReady === true);
}

export function backgroundWorkspaceSyncDelay(index: number) {
  return Math.floor(Math.max(0, index) / BACKGROUND_WORKSPACE_SYNC_BATCH_SIZE)
    * BACKGROUND_WORKSPACE_SYNC_BATCH_INTERVAL_MS;
}

export function backgroundWorkspaceDiscoveryCycleDelay(itemCount: number) {
  const finalBatchDelay = itemCount > 0 ? backgroundWorkspaceSyncDelay(itemCount - 1) : 0;
  return finalBatchDelay + BACKGROUND_WORKSPACE_DISCOVERY_INTERVAL_MS;
}

/** Start background subscriptions in small batches and return one full cleanup. */
export function scheduleBatchedWorkspaceSync<T>(
  items: readonly T[],
  start: (item: T) => (() => void) | null | undefined,
  timers: {
    schedule: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
    cancel: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  } = {
    schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    cancel: (handle) => globalThis.clearTimeout(handle),
  },
) {
  let disposed = false;
  const handles: ReturnType<typeof globalThis.setTimeout>[] = [];
  const releases: (() => void)[] = [];
  const startOne = (item: T) => {
    if (disposed) return;
    const release = start(item);
    if (release) releases.push(release);
  };

  items.forEach((item, index) => {
    const delay = backgroundWorkspaceSyncDelay(index);
    if (delay === 0) startOne(item);
    else handles.push(timers.schedule(() => startOne(item), delay));
  });

  return () => {
    if (disposed) return;
    disposed = true;
    handles.forEach((handle) => timers.cancel(handle));
    releases.reverse().forEach((release) => release());
  };
}
