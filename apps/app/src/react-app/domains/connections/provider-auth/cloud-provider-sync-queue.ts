export {
  createLatestSyncQueue,
  type LatestSyncQueue,
} from "@/react-app/kernel/latest-sync-queue";

export type KeyedSingleflight<Key, Value> = {
  run: (key: Key, task: () => Promise<Value>) => Promise<Value>;
};

/** Shares one in-flight request across store instances without caching the
 * result. Session and settings routes each own a provider store, and both can
 * reconcile on the same focus event; issuing two `/connect` requests would
 * otherwise rotate a gateway credential twice before either import settles.
 */
export function createKeyedSingleflight<Key, Value>(): KeyedSingleflight<Key, Value> {
  const inFlight = new Map<Key, Promise<Value>>();
  return {
    run(key, task) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      const request = task().finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
      inFlight.set(key, request);
      return request;
    },
  };
}

export function shouldAdoptWorkspaceSnapshot(input: {
  currentWorkspaceKey: string;
  snapshotWorkspaceKey: string;
  currentEntryCount: number;
  nextEntryCount: number;
}): boolean {
  return (
    input.currentWorkspaceKey !== input.snapshotWorkspaceKey ||
    input.nextEntryCount > 0 ||
    input.currentEntryCount === 0
  );
}
