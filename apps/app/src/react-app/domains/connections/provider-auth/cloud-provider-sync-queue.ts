export {
  createLatestSyncQueue,
  type LatestSyncQueue,
} from "@/react-app/kernel/latest-sync-queue";

export type KeyedSingleflight<Key, Value> = {
  run: (key: Key, task: () => Promise<Value>) => Promise<Value>;
};

export type KeyedSerialQueue<Key> = {
  run: <Value>(key: Key, task: () => Promise<Value>) => Promise<Value>;
};

export class StaleCloudProviderAuthorityError extends Error {
  constructor() {
    super("cloud_provider_authority_changed");
    this.name = "StaleCloudProviderAuthorityError";
  }
}

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

/** Serializes cloud-provider mutations across provider-store instances.
 *
 * Session and Settings each own a store, but both write the same workspace
 * runtime config and OpenCode auth store. A per-store queue cannot prevent a
 * late request from the previous account overwriting the new account's gateway
 * credential, so mutations for one workspace must share this module-level
 * coordinator.
 */
export function createKeyedSerialQueue<Key>(): KeyedSerialQueue<Key> {
  const tails = new Map<Key, Promise<void>>();
  return {
    async run<Value>(key: Key, task: () => Promise<Value>): Promise<Value> {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.catch(() => undefined).then(() => current);
      tails.set(key, tail);
      await previous.catch(() => undefined);
      try {
        return await task();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}

export function assertCloudProviderAuthorityCurrent(
  expectedAuthorityKey: string,
  currentAuthorityKey: string,
): void {
  if (expectedAuthorityKey !== currentAuthorityKey) {
    throw new StaleCloudProviderAuthorityError();
  }
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
