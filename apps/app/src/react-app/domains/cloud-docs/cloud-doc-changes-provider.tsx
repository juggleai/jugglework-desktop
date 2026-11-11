import * as React from "react";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";

type Summaries = Awaited<ReturnType<JuggleWorkServerClient["cloudDocsSessionChanges"]>>;
const empty: Summaries = { turns: [] };
const Context = React.createContext({ data: empty, refresh: async () => {} });

/** 每个会话只批量读取一次汇总，在轮次结束和撤销后刷新，避免每张卡片各发一次请求。 */
export function CloudDocChangesProvider({ client, workspaceId, sessionId, busy, children }: {
  client: JuggleWorkServerClient | null; workspaceId: string; sessionId: string; busy: boolean; children: React.ReactNode;
}) {
  const [data, setData] = React.useState(empty);
  const scope = `${client?.baseUrl}/${workspaceId}/${sessionId}`;
  const active = React.useRef(scope);
  active.current = scope;
  const refresh = React.useCallback(async () => {
    if (!client) { setData(empty); return; }
    try {
      const value = await client.cloudDocsSessionChanges(workspaceId, sessionId);
      if (active.current === scope) setData(value);
    } catch { if (active.current === scope) setData(empty); }
  }, [client, workspaceId, sessionId, scope]);
  React.useEffect(() => { setData(empty); }, [scope]);
  React.useEffect(() => { if (!busy) void refresh(); }, [busy, refresh]);
  return <Context.Provider value={{ data, refresh }}>{children}</Context.Provider>;
}

/** 读取当前会话已批量获取的卡片汇总，不发起额外请求。 */
export function useCloudDocChanges() { return React.useContext(Context); }
