const utf8Hex = (value: string): string =>
  Array.from(new TextEncoder().encode(value.trim()), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()

const envSafeHex = (value: string): string => utf8Hex(value) || "00"

const legacyGatewayCredentialSuffix = (cloudProviderId: string): string =>
  cloudProviderId.trim().replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()

/**
 * Who a stored gateway credential belongs to.
 *
 * A gateway credential is issued per member, provider, and signed-in device,
 * never per workspace, so the current shape is shared by every workspace that
 * imports the same organization provider: `workspaceId` is omitted. Records
 * written by older builds still carry a `workspaceId`; they stay readable so an
 * upgrade keeps working until the next import rewrites them as shared.
 */
export type CloudGatewayMirrorOwner = {
  workspaceId?: string | null
  organizationId: string
  cloudProviderId: string
}

export type CloudGatewayMirrorReference = CloudGatewayMirrorOwner & {
  key: string
}

const ownerPart = (part: string): string => `${envSafeHex(part).length}_${envSafeHex(part)}`

/** Shared records use an `ORG_` marker so they can never collide with a legacy workspace-scoped id. */
export const cloudGatewayMirrorOwnerId = (owner: CloudGatewayMirrorOwner): string => {
  const workspaceId = owner.workspaceId?.trim()
  return workspaceId
    ? [workspaceId, owner.organizationId, owner.cloudProviderId].map(ownerPart).join("_")
    : `ORG_${[owner.organizationId, owner.cloudProviderId].map(ownerPart).join("_")}`
}

export const isSharedCloudGatewayMirror = (owner: Pick<CloudGatewayMirrorOwner, "workspaceId">): boolean =>
  !owner.workspaceId?.trim()

export const cloudGatewayCredentialEnvName = (cloudProviderId: string): string => {
  const suffix = envSafeHex(cloudProviderId)
  return `JUGGLEWORK_GATEWAY_KEY_V2_${suffix}`
}

export const legacyCloudGatewayMirrorEnvName = (cloudProviderId: string): string => {
  const suffix = legacyGatewayCredentialSuffix(cloudProviderId)
  return suffix ? `MCP_GATEWAY_KEY_${suffix}` : "MCP_GATEWAY_KEY"
}

export const cloudGatewayMirrorEnvName = (owner: CloudGatewayMirrorOwner): string =>
  `MCP_GATEWAY_KEY_V2_${cloudGatewayMirrorOwnerId(owner)}`

export const isCloudGatewayCredentialEnvName = (value: string): boolean =>
  /^JUGGLEWORK_GATEWAY_KEY_V2_[A-F0-9]+$/.test(value)

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]))
}

export const providerConfigFingerprint = (value: unknown): string => JSON.stringify(stableValue(value))

export const cloudProviderConfigFingerprint = (value: unknown): string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return providerConfigFingerprint(value)
  const record = { ...(value as Record<string, unknown>) }
  delete record.models
  return providerConfigFingerprint(record)
}
