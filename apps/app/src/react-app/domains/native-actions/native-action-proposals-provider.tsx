import * as React from "react";
import type { JuggleWorkServerClient, NativeActionProposalView } from "@/app/lib/jugglework-server";

const Context = React.createContext<{ items: NativeActionProposalView[]; refresh: () => Promise<void>; replace: (item: NativeActionProposalView) => void }>({
  items: [], refresh: async () => {}, replace: () => {},
});

/**
 * One request per session for all proposal cards, refreshed when a turn starts
 * and ends. Only the desktop app can run native actions, so other runtimes
 * never ask.
 */
export function NativeActionProposalsProvider({ client, workspaceId, sessionId, busy, children }: {
  client: JuggleWorkServerClient | null; workspaceId: string; sessionId: string; busy: boolean; children: React.ReactNode;
}) {
  const [items, setItems] = React.useState<NativeActionProposalView[]>([]);
  const scope = `${client?.baseUrl}/${workspaceId}/${sessionId}`;
  const active = React.useRef(scope);
  active.current = scope;
  const enabled = typeof window !== "undefined" && Boolean(window.__JUGGLEWORK_ELECTRON__?.nativeActions);
  const refresh = React.useCallback(async () => {
    if (!enabled || !client || !workspaceId || !sessionId) { setItems([]); return; }
    try {
      const value = await client.nativeActionProposals(workspaceId, sessionId);
      if (active.current === scope) setItems(value.items);
    } catch { /* keep last known state; the card shows its own errors */ }
  }, [enabled, client, workspaceId, sessionId, scope]);
  const replace = React.useCallback((item: NativeActionProposalView) => {
    setItems((current) => current.some((entry) => entry.id === item.id) ? current.map((entry) => entry.id === item.id ? item : entry) : [...current, item]);
  }, []);
  React.useEffect(() => { setItems([]); }, [scope]);
  React.useEffect(() => { void refresh(); }, [busy, refresh]);
  return <Context.Provider value={{ items, refresh, replace }}>{children}</Context.Provider>;
}

export function useNativeActionProposals() { return React.useContext(Context); }
