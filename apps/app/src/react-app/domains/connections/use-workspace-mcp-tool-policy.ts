import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { JuggleWorkServerError, type JuggleWorkServerClient } from "@/app/lib/jugglework-server";

/** 普通工作区 MCP 的无重载工具暴露策略。 */
export function useWorkspaceMcpToolPolicy(input: {
  client: JuggleWorkServerClient | null;
  workspaceId: string | null;
}) {
  const [disabledServerNames, setDisabledServerNames] = useState<string[]>([]);
  const [available, setAvailable] = useState(false);
  const [savingName, setSavingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabledRef = useRef<string[]>([]);
  const writeQueueRef = useRef(Promise.resolve());
  const mutationRef = useRef(0);
  disabledRef.current = disabledServerNames;

  const refresh = useCallback(async () => {
    if (!input.client || !input.workspaceId) {
      setDisabledServerNames([]);
      setAvailable(false);
      return;
    }
    try {
      const policy = await input.client.getMcpToolPolicy(input.workspaceId);
      setDisabledServerNames(policy.disabledServerNames);
      disabledRef.current = policy.disabledServerNames;
      setAvailable(true);
      setError(null);
    } catch (reason) {
      setAvailable(false);
      if (reason instanceof JuggleWorkServerError && (reason.status === 404 || reason.code === "not_found")) {
        setError(null);
      } else {
        setError(reason instanceof Error ? reason.message : "Failed to load MCP workspace policy");
      }
    }
  }, [input.client, input.workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setServerEnabled = useCallback(async (name: string, enabled: boolean) => {
    if (!input.client || !input.workspaceId || !available) return;
    const previous = disabledRef.current;
    const next = enabled
      ? previous.filter((item) => item !== name)
      : [...new Set([...previous, name])].sort((left, right) => left.localeCompare(right));
    setDisabledServerNames(next);
    disabledRef.current = next;
    setSavingName(name);
    setError(null);
    const mutation = mutationRef.current + 1;
    mutationRef.current = mutation;
    writeQueueRef.current = writeQueueRef.current.then(async () => {
      try {
        const policy = await input.client!.setMcpToolPolicy(input.workspaceId!, next);
        // 迟到响应不能覆盖队列中更晚的乐观状态。
        if (mutationRef.current === mutation) {
          setDisabledServerNames(policy.disabledServerNames);
          disabledRef.current = policy.disabledServerNames;
        }
      } catch (reason) {
        // 队列中可能已有更晚的乐观状态；失败后重新读取服务端真值，而不是用旧快照覆盖。
        if (mutationRef.current === mutation) {
          setError(reason instanceof Error ? reason.message : "Failed to update MCP workspace policy");
          await refresh();
        }
      } finally {
        if (mutationRef.current === mutation) setSavingName(null);
      }
    });
    await writeQueueRef.current;
  }, [available, input.client, input.workspaceId, refresh]);

  return useMemo(() => ({
    available,
    disabledServerNames,
    savingName,
    error,
    refresh,
    setServerEnabled,
  }), [available, disabledServerNames, error, refresh, savingName, setServerEnabled]);
}
