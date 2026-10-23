export const ORG_MCP_SYNC_INTERVAL_MS = 30_000;

/** Keep cloud-side changes visible without polling hidden windows. */
export function subscribeOrgMcpSync(input: {
  windowTarget: EventTarget;
  documentTarget: EventTarget;
  isVisible: () => boolean;
  refresh: () => Promise<void>;
  setInterval: (callback: () => void, delay: number) => number;
  clearInterval: (id: number) => void;
}) {
  let disposed = false;
  let pending = false;
  const refresh = async () => {
    if (disposed || pending || !input.isVisible()) return;
    pending = true;
    try {
      await input.refresh();
    } finally {
      pending = false;
    }
  };
  const resume = () => { void refresh(); };
  input.windowTarget.addEventListener("focus", resume);
  input.windowTarget.addEventListener("online", resume);
  input.documentTarget.addEventListener("visibilitychange", resume);
  const interval = input.setInterval(resume, ORG_MCP_SYNC_INTERVAL_MS);
  return () => {
    disposed = true;
    input.clearInterval(interval);
    input.windowTarget.removeEventListener("focus", resume);
    input.windowTarget.removeEventListener("online", resume);
    input.documentTarget.removeEventListener("visibilitychange", resume);
  };
}
