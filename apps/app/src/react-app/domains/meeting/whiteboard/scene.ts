// Excalidraw-free helpers, so they can be unit tested without loading the canvas.

export type WhiteboardInitialData = {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
} | null;

// View state that should not survive a reopen or leak between users.
const TRANSIENT_APP_STATE = ["collaborators", "selectedElementIds", "editingTextElement", "openDialog", "openMenu", "openSidebar"];

/** Parse a saved Excalidraw JSON scene; corrupt or foreign content starts empty. */
export function parseWhiteboardScene(json: string | null): WhiteboardInitialData {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (value?.type !== "excalidraw" || !Array.isArray(value.elements)) return null;
    const appState = { ...(value.appState && typeof value.appState === "object" ? value.appState as Record<string, unknown> : {}) };
    for (const key of TRANSIENT_APP_STATE) delete appState[key];
    const files = value.files && typeof value.files === "object" ? value.files as Record<string, unknown> : {};
    return { elements: value.elements, appState, files };
  } catch {
    return null;
  }
}

/** Trailing debounce that can be flushed synchronously on pagehide. */
// Wrapped so the browser timer functions are never invoked as methods of
// another object ("Illegal invocation" in Chromium).
const defaultTimers = {
  set: ((fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms)) as unknown as typeof setTimeout,
  clear: ((handle?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle)) as typeof clearTimeout,
};

export function createSceneSaver(save: (json: string) => Promise<unknown>, saveNow: (json: string) => unknown, delayMs = 500,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = defaultTimers) {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onError: (error: unknown) => void = () => {};
  const run = () => {
    timer = undefined;
    const json = pending;
    pending = null;
    if (json !== null) void save(json).catch((error) => onError(error));
  };
  return {
    schedule(json: string) {
      pending = json;
      if (timer !== undefined) timers.clear(timer);
      timer = timers.set(run, delayMs);
    },
    /** Write any unsaved change synchronously. Returns false when nothing was written. */
    flushSync() {
      if (timer !== undefined) { timers.clear(timer); timer = undefined; }
      const json = pending;
      pending = null;
      return json === null ? false : saveNow(json) !== false;
    },
    hasPending: () => pending !== null,
    onError(handler: (error: unknown) => void) { onError = handler; },
  };
}

/** Largest output size that keeps the board's aspect ratio within 1920x1080 and 2x pixel density. */
export function mirrorSize(width: number, height: number, devicePixelRatio = 1) {
  const w = Math.max(1, width), h = Math.max(1, height);
  const scale = Math.min(2, Math.max(1, devicePixelRatio), 1920 / w, 1080 / h);
  // Even dimensions keep H.264 encoders from cropping a pixel.
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(w * scale), height: even(h * scale), scale };
}
