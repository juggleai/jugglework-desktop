import type { DenMcpWorkspaceConnectionPolicy, DenOrgPlugin } from "@/app/lib/den";

/** 连接器行里与工作区开关有关的部分。 */
export type ConnectScopeRow =
  | { kind: "connection"; id: string }
  | { kind: "plugin"; plugin: Pick<DenOrgPlugin, "cloudReadiness"> };

/**
 * 一行连接器背后的组织连接 id。
 *
 * 独立连接行就是它自己；插件行来自 `cloudReadiness.connections`——插件把它绑定的
 * 连接吸收进了自己这一行，工作区开关要落到这些连接上。
 *
 * @param row 连接器行
 */
export function connectRowConnectionIds(row: ConnectScopeRow): string[] {
  if (row.kind === "connection") return [row.id];
  return row.plugin.cloudReadiness?.connections.flatMap((connection) => connection.id ? [connection.id] : []) ?? [];
}

/**
 * 一行连接器在当前工作区的开关状态。
 *
 * @param connectionIds 这一行实际会被开关影响的组织连接 id
 * @param enabled 是否允许在当前工作区生效
 */
export type ConnectRowWorkspaceScope = {
  connectionIds: string[];
  enabled: boolean;
};

/**
 * 求一行连接器在当前工作区的开关状态。
 *
 * TIPS：插件行可能绑定多条组织连接。只要有一条被关掉就整行显示为「已关闭」，
 * 打开时把这一行的全部连接一起打开——开关的读与写落在同一组连接上，不会出现
 * 「看着是开的、其实半开」的中间态。
 *
 * @param connectionIds 这一行背后的组织连接 id
 * @param items 当前工作区的连接策略
 * @returns 策略里没有对应连接时返回 null，该行不显示开关
 */
export function resolveConnectRowWorkspaceScope(
  connectionIds: string[],
  items: DenMcpWorkspaceConnectionPolicy[],
): ConnectRowWorkspaceScope | null {
  const byId = new Map(items.map((item) => [item.connectionId, item]));
  const matched = connectionIds.filter((id) => byId.has(id));
  if (matched.length === 0) return null;
  return {
    connectionIds: matched,
    enabled: matched.every((id) => byId.get(id)?.enabled !== false),
  };
}
