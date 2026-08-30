import { useCallback, useEffect, useRef, useState } from "react";

import {
  createDenClient,
  DenApiError,
  readDenSettings,
  type DenMcpWorkspaceConnectionPolicy,
} from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";

import { resolveWorkspaceMcpKey } from "./workspace-mcp-key";

/**
 * 组织连接在当前工作区的可用状态。
 *
 * - `unsupported`：JuggleWork 服务端或 Cloud 缺少工作区策略路由（旧版本）。
 *   连接器页据此**只隐藏工作区开关**，连接器列表本身照常展示。
 * - `signed_out`：未登录或未选组织，没有组织连接可谈。
 */
export type WorkspaceMcpPolicyAvailability = "ready" | "loading" | "unsupported" | "signed_out" | "error";

export type WorkspaceMcpPolicy = {
  availability: WorkspaceMcpPolicyAvailability;
  workspaceKey: string | null;
  items: DenMcpWorkspaceConnectionPolicy[];
  error: string | null;
  /** 正在提交的连接 id；用于给该行加载态。 */
  savingConnectionId: string | null;
  refresh: () => Promise<void>;
  setConnectionEnabled: (connectionId: string, enabled: boolean) => Promise<void>;
  /** 一次提交多条连接：一行连接器可能绑定多条组织连接。 */
  setConnectionsEnabled: (connectionIds: string[], enabled: boolean) => Promise<void>;
};

function isMissingRouteError(error: unknown): boolean {
  return error instanceof DenApiError && (error.status === 404 || error.code === "not_found");
}

function disabledIdsFrom(items: DenMcpWorkspaceConnectionPolicy[]): string[] {
  return items.filter((item) => !item.enabled).map((item) => item.connectionId);
}

/**
 * 当前工作区的组织 MCP 连接开关。
 *
 * TIPS：写入是**全量替换**（提交整个关闭集合）而不是逐条 PATCH。连续拨动多个开关
 * 时，逐条写入会因请求乱序产生错误终态；全量替换的最后一次提交总是对的。
 *
 * @param input.client JuggleWork 服务端客户端（用于取 workspaceKey）
 * @param input.workspaceId 当前工作区 id
 */
export function useWorkspaceMcpPolicy(input: {
  client: JuggleWorkServerClient | null;
  workspaceId: string | null;
}): WorkspaceMcpPolicy {
  const [availability, setAvailability] = useState<WorkspaceMcpPolicyAvailability>("loading");
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);
  const [items, setItems] = useState<DenMcpWorkspaceConnectionPolicy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savingConnectionId, setSavingConnectionId] = useState<string | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const runRef = useRef(0);
  const workspaceKeyRef = useRef<string | null>(null);
  const itemsRef = useRef<DenMcpWorkspaceConnectionPolicy[]>([]);
  const writeQueueRef = useRef(Promise.resolve());
  const mutationRef = useRef(0);
  itemsRef.current = items;

  const client = input.client;
  const workspaceId = input.workspaceId?.trim() ?? "";

  const refresh = useCallback(async () => {
    const run = runRef.current + 1;
    runRef.current = run;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!client || !workspaceId) {
      setAvailability("unsupported");
      return;
    }
    if (!token || !orgId) {
      setAvailability("signed_out");
      setItems([]);
      return;
    }
    setError(null);
    try {
      const key = await resolveWorkspaceMcpKey(client, workspaceId);
      if (runRef.current !== run) return;
      workspaceKeyRef.current = key;
      setWorkspaceKey(key);
      if (!key) {
        setAvailability("unsupported");
        setItems([]);
        return;
      }
      const policy = await createDenClient({ baseUrl: settings.baseUrl, token })
        .getMcpWorkspacePolicy(orgId, key);
      if (runRef.current !== run) return;
      setItems(policy.items);
      setAvailability("ready");
    } catch (loadError) {
      if (runRef.current !== run) return;
      if (isMissingRouteError(loadError)) {
        setAvailability("unsupported");
        setItems([]);
        return;
      }
      setAvailability("error");
      setError(loadError instanceof Error ? loadError.message : "Failed to load organization connections.");
    }
  }, [client, workspaceId]);

  const setConnectionsEnabled = useCallback(async (connectionIds: string[], enabled: boolean) => {
    const key = workspaceKeyRef.current;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    const targets = new Set(connectionIds.filter((id) => id.trim()));
    if (!key || !token || !orgId || targets.size === 0) return;
    const [head] = [...targets];

    const previous = itemsRef.current;
    const next = previous.map((item) => targets.has(item.connectionId) ? { ...item, enabled } : item);
    // 乐观更新：服务端过滤在下一次能力搜索时生效，开关本身没有引擎重载的等待，
    // 让它立刻响应；失败才回滚。
    setItems(next);
    itemsRef.current = next;
    setSavingConnectionId(head);
    setError(null);
    const mutation = mutationRef.current + 1;
    mutationRef.current = mutation;
    writeQueueRef.current = writeQueueRef.current.then(async () => {
      try {
        const policy = await createDenClient({ baseUrl: settings.baseUrl, token })
          .replaceMcpWorkspacePolicy(orgId, key, disabledIdsFrom(next));
        if (mutationRef.current === mutation) {
          setItems(policy.items);
          itemsRef.current = policy.items;
        }
      } catch (saveError) {
        // 不用旧快照回滚并覆盖后续操作；重新读取服务端真值。
        if (mutationRef.current === mutation) {
          setError(saveError instanceof Error ? saveError.message : "Failed to update the connection switch.");
          await refresh();
        }
      } finally {
        if (mutationRef.current === mutation) {
          setSavingConnectionId((current) => current === head ? null : current);
        }
      }
    });
    await writeQueueRef.current;
  }, [refresh]);

  const setConnectionEnabled = useCallback(
    (connectionId: string, enabled: boolean) => setConnectionsEnabled([connectionId], enabled),
    [setConnectionsEnabled],
  );

  useEffect(() => {
    const handleSettingsChanged = () => setSettingsVersion((version) => version + 1);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    return () => window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
  }, []);

  useEffect(() => {
    setAvailability("loading");
    void refresh();
    return () => {
      runRef.current += 1;
    };
  }, [refresh, settingsVersion]);

  return {
    availability,
    workspaceKey,
    items,
    error,
    savingConnectionId,
    refresh,
    setConnectionEnabled,
    setConnectionsEnabled,
  };
}
