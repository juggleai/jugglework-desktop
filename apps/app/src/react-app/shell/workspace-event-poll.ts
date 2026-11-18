// Schedule the next request after the previous one settles. A focus or route
// change during a request queues at most one catch-up.
export function startWorkspaceEventPoll(poll: () => Promise<void>, foreground: () => boolean) {
  let timer: number | undefined;
  let running = false;
  let stopped = false;
  let catchUp = false;
  const refresh = async () => {
    if (stopped) return;
    window.clearTimeout(timer);
    if (running) {
      catchUp = true;
      return;
    }
    running = true;
    try {
      await poll();
    } finally {
      running = false;
      if (!stopped) {
        const active = foreground() && document.visibilityState !== "hidden" && document.hasFocus();
        const intervalMs = active ? 3_000 : 30_000;
        timer = window.setTimeout(refresh, catchUp ? 0 : intervalMs);
        catchUp = false;
      }
    }
  };
  void refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      window.clearTimeout(timer);
    },
  };
}
