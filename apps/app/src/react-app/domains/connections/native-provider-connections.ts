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

export type OrgMcpDisconnectableConnection = NativeProviderDisconnectableConnection & {
  credentialMode: "shared" | "per_member";
};

/**
 * 判断当前成员能否断开某个组织 MCP 连接（服务端下发的连接器，如 GitHub）。
 *
 * TIPS: 断开的对象是「成员自己的授权」，因此只有 `per_member` 且已授权的连接可断开；
 * `shared` 凭证由管理员统一维护，成员断开无意义（也无权限）。原生 Provider
 * （Google Workspace / Microsoft 365）走 oauth-providers 断开通道，同样满足此判据。
 */
export function canDisconnectOrgMcpConnection(connection: OrgMcpDisconnectableConnection): boolean {
  return connection.credentialMode === "per_member" && connection.connectedForMe;
}
