import { useEffect, useRef } from "react";

export const ACTIVE_SNAPSHOT_RECONCILE_INTERVAL_MS = 2_000;

export type ActiveSnapshotReconciler = {
  reconcile: (final?: boolean) => Promise<void>;
};

/**
 * Coalesce periodic and terminal snapshot reads. A terminal read that arrives
 * during an in-flight request is retained and runs once after that request.
 */
export function createActiveSnapshotReconciler(readSnapshot: () => Promise<unknown>): ActiveSnapshotReconciler {
  let inFlight = false;
  let finalPending = false;

  const reconcile = async (final = false): Promise<void> => {
    if (inFlight) {
      finalPending ||= final;
      return;
    }
    inFlight = true;
    try {
      await readSnapshot();
    } catch {
      // This is a recovery path. A failed read must not create an unhandled
      // rejection or disturb the run; the next interval can try again.
    } finally {
      inFlight = false;
      if (finalPending) {
        finalPending = false;
        await reconcile(true);
      }
    }
  };

  return { reconcile };
}

export function useActiveSnapshotReconciliation(options: {
  active: boolean;
  visible: boolean;
  scopeKey: string;
  readSnapshot: () => Promise<unknown>;
}) {
  const reconcilerRef = useRef<ActiveSnapshotReconciler | null>(null);
  const previousRunRef = useRef({ active: false, scopeKey: options.scopeKey });

  useEffect(() => {
    reconcilerRef.current = createActiveSnapshotReconciler(options.readSnapshot);
    return () => {
      reconcilerRef.current = null;
    };
  }, [options.readSnapshot]);

  useEffect(() => {
    const previous = previousRunRef.current;
    const sameScope = previous.scopeKey === options.scopeKey;
    previousRunRef.current = { active: options.active, scopeKey: options.scopeKey };
    if (sameScope && previous.active && !options.active && options.visible) {
      void reconcilerRef.current?.reconcile(true);
    }
  }, [options.active, options.scopeKey, options.visible]);

  useEffect(() => {
    if (!options.active || !options.visible) return;
    void reconcilerRef.current?.reconcile();
    const timer = window.setInterval(() => {
      void reconcilerRef.current?.reconcile();
    }, ACTIVE_SNAPSHOT_RECONCILE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [options.active, options.visible, options.readSnapshot]);
}
