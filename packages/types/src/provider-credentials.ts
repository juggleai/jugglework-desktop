const utf8Hex = (value: string): string =>
  Array.from(new TextEncoder().encode(value.trim()), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()

const envSafeHex = (value: string): string => utf8Hex(value) || "00"

const legacyGatewayCredentialSuffix = (cloudProviderId: string): string =>
  cloudProviderId.trim().replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()

export type CloudGatewayMirrorOwner = {
  workspaceId: string
  organizationId: string
  cloudProviderId: string
}

export type CloudGatewayMirrorReference = CloudGatewayMirrorOwner & {
  key: string
}

export const cloudGatewayMirrorOwnerId = (owner: CloudGatewayMirrorOwner): string =>
  [owner.workspaceId, owner.organizationId, owner.cloudProviderId]
    .map((part) => `${envSafeHex(part).length}_${envSafeHex(part)}`)
    .join("_")

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
