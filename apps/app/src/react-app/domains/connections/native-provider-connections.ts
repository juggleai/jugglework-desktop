export type NativeProviderDisconnectableConnection = {
  id: string;
  connectedForMe: boolean;
};

export type ReconnectableConnection = {
  needsReconnect?: boolean;
  missingFeatures?: readonly string[];
};

export type OrgMcpConnectionReadiness = ReconnectableConnection & {
  credentialMode: "shared" | "per_member";
  connected: boolean;
  connectedForMe: boolean;
};

export function connectionNeedsReconnect(connection: ReconnectableConnection): boolean {
  return connection.needsReconnect === true || (connection.missingFeatures?.length ?? 0) > 0;
}

/**
 * 判断组织 MCP 连接对当前成员是否可用。
 *
 * 共享凭证以组织连接状态为准，成员凭证还需确保当前成员授权有效且无需重连。
 */
export function isOrgMcpConnectionReady(connection: OrgMcpConnectionReadiness): boolean {
  return connection.credentialMode === "shared"
    ? connection.connected
    : connection.connectedForMe && !connectionNeedsReconnect(connection);
}

export function isNativeProviderConnectionId(id: string): boolean {
  return id === "google-workspace" || id === "microsoft-365";
}

export function canDisconnectNativeProviderAccount(connection: NativeProviderDisconnectableConnection): boolean {
  return connection.connectedForMe && isNativeProviderConnectionId(connection.id);
}
