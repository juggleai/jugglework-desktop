import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionFileArtifacts } from "@jugglework/types/file-artifacts";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";

interface FileDeliveriesContextValue {
  data?: SessionFileArtifacts;
  retry: (turnId: string) => Promise<void>;
}
const FileDeliveriesContext =
  React.createContext<FileDeliveriesContextValue | null>(null);

/** 会话级批量读取交付；旧 Server 不支持接口时继续使用历史消息兼容展示。 */
export function FileDeliveriesProvider({
  children,
  client,
  workspaceId,
  sessionId,
  running,
  enabled,
  messageKey,
}: {
  children: React.ReactNode;
  client: JuggleWorkServerClient;
  workspaceId: string;
  sessionId: string;
  running: boolean;
  enabled: boolean;
  messageKey: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = React.useMemo(
    () => ["file-deliveries", client.baseUrl, workspaceId, sessionId],
    [client.baseUrl, workspaceId, sessionId],
  );
  const query = useQuery({
    queryKey,
    enabled,
    retry: false,
    queryFn: () => client.listFileDeliveries(workspaceId, sessionId),
    refetchInterval: (query) =>
      query.state.data?.turns.some(
        (turn) => turn.status === "collecting" || turn.status === "finalizing",
      )
        ? 2000
        : false,
  });
  React.useEffect(() => {
    if (!enabled || running) return;
    let cancelled = false;
    void client
      .syncFileDeliveries(workspaceId, sessionId)
      .then((data) => {
        if (!cancelled) queryClient.setQueryData(queryKey, data);
      })
      .catch(() => {
        /* 旧服务端或引擎暂不可用，保留已有卡片。 */
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    workspaceId,
    sessionId,
    enabled,
    running,
    messageKey,
    queryClient,
    queryKey,
  ]);
  const retry = React.useCallback(
    async (turnId: string) => {
      const data = await client.retryFileDelivery(
        workspaceId,
        sessionId,
        turnId,
      );
      queryClient.setQueryData(queryKey, data);
    },
    [client, workspaceId, sessionId, queryClient, queryKey],
  );
  const value = React.useMemo(
    () => ({ data: enabled ? query.data : undefined, retry }),
    [enabled, query.data, retry],
  );
  return (
    <FileDeliveriesContext.Provider value={value}>
      {children}
    </FileDeliveriesContext.Provider>
  );
}

/** 返回当前会话的权威交付记录，按用户消息 ID 选择真实轮次。 */
export function useFileDeliveries() {
  return React.useContext(FileDeliveriesContext);
}
