export type LatestSyncQueue<Reason> = {
  run: (reason: Reason) => Promise<void>;
};

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

/**
 * Coalesces overlapping sync requests while guaranteeing that every caller
 * waits for the latest queued pass. This matters during workspace switches:
 * the new workspace must not treat an older workspace's in-flight pass as its
 * own completed sync.
 */
export function createLatestSyncQueue<Reason>(
  task: (reason: Reason) => Promise<void>,
): LatestSyncQueue<Reason> {
  let inFlight: Promise<void> | null = null;
  let queuedReason: Reason | null = null;

  const run = (reason: Reason): Promise<void> => {
    queuedReason = reason;
    if (inFlight) return inFlight;

    const request = (async () => {
      while (queuedReason !== null) {
        const currentReason = queuedReason;
        queuedReason = null;
        await task(currentReason);
      }
    })();

    inFlight = request.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return { run };
}
