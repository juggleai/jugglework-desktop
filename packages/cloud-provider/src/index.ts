export type CloudProviderModel = {
  id: string;
  name: string;
  config?: Record<string, unknown>;
  createdAt?: string | null;
};

export type CloudProvider = {
  id: string;
  providerId: string;
  name: string;
  source?: string | null;
  providerConfig?: Record<string, unknown>;
  hasApiKey?: boolean;
  enabled?: boolean;
  models: CloudProviderModel[];
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type CloudProviderConnection = CloudProvider & {
  apiKey?: string | null;
  apiKeys?: Record<string, string> | null;
};

export type CloudImportedProvider = {
  cloudProviderId: string;
  providerId: string;
  sourceProviderId: string;
  name: string;
  source: string | null;
  updatedAt: string | null;
  modelIds: string[];
  importedAt: number | null;
  metadataVersion: number | null;
};

export type DeploymentCatalogModel = Record<string, unknown>;
export type DeploymentModelCatalog = Record<string, Record<string, DeploymentCatalogModel>>;

export type CloudProviderConfig = {
  id?: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  options?: Record<string, unknown>;
  whitelist?: string[];
  blacklist?: string[];
  models?: Record<string, Record<string, unknown>>;
};

const getStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

const sameStringList = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const gatewayMirrorEnvName = (cloudProviderId: string): string => {
  const suffix = cloudProviderId.trim().replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return suffix ? `MCP_GATEWAY_KEY_${suffix}` : "MCP_GATEWAY_KEY";
};

export const getCloudProviderEnv = (config: Record<string, unknown>) => getStringList(config.env);

export const resolveCloudProviderCredentials = (
  provider: Pick<CloudProviderConnection, "apiKey" | "apiKeys" | "providerConfig">,
) => {
  const apiKeys = provider.apiKeys ?? {};
  const envNames = getCloudProviderEnv(provider.providerConfig ?? {});
  const orderedNames = [
    ...envNames.filter((name) => name in apiKeys),
    ...Object.keys(apiKeys).filter((name) => !envNames.includes(name)),
  ];
  const envEntries = orderedNames.flatMap((name) => {
    const value = apiKeys[name]?.trim();
    return value ? [{ key: name, value }] : [];
  });
  return {
    envEntries,
    primaryApiKey: provider.apiKey?.trim() || envEntries[0]?.value || "",
  };
};

export const getCloudManagedProviderId = (provider: Pick<CloudProvider, "id">) => provider.id.trim();

export const getProviderModelIds = (provider: Pick<CloudProvider, "models">) =>
  provider.models.flatMap((model) => {
    const id = model.id.trim();
    return id ? [id] : [];
  }).sort();

export const CLOUD_PROVIDER_METADATA_VERSION = 8;

export const buildCloudImportedProvider = (
  provider: CloudProvider,
  importedAt = Date.now(),
): CloudImportedProvider => ({
  cloudProviderId: provider.id,
  providerId: getCloudManagedProviderId(provider),
  sourceProviderId: provider.providerId,
  name: provider.name,
  source: provider.source ?? null,
  updatedAt: provider.updatedAt ?? null,
  modelIds: getProviderModelIds(provider),
  importedAt,
  metadataVersion: CLOUD_PROVIDER_METADATA_VERSION,
});

export const filterImportableCloudOrgProviders = <T extends CloudProvider>(providers: readonly T[]): T[] =>
  providers.filter((provider) =>
    provider.enabled !== false &&
    provider.source !== "jugglework" &&
    provider.providerId.trim().toLowerCase() !== "jugglework"
  );

export const getCurrentCloudManagedProviderIds = (input: {
  imported: Record<string, CloudImportedProvider>;
  liveProviders: Array<Pick<CloudProvider, "id">>;
}) => {
  const liveIds = new Set(input.liveProviders.map((provider) => provider.id.trim()));
  return Object.values(input.imported)
    .filter((provider) => liveIds.has(provider.cloudProviderId.trim()))
    .map((provider) => provider.providerId);
};

export const isCloudManagedProviderKey = (providerId: string) =>
  /^lpr_/i.test(providerId) || providerId.trim().toLowerCase() === "jugglework";

export const isCloudProviderOutOfSync = (
  provider: CloudProvider,
  importedProvider: CloudImportedProvider,
) =>
  (importedProvider.metadataVersion ?? 0) < CLOUD_PROVIDER_METADATA_VERSION ||
  importedProvider.providerId !== getCloudManagedProviderId(provider) ||
  importedProvider.sourceProviderId !== provider.providerId ||
  (importedProvider.source ?? null) !== (provider.source ?? null) ||
  (importedProvider.updatedAt ?? null) !== (provider.updatedAt ?? null) ||
  !sameStringList(importedProvider.modelIds, getProviderModelIds(provider));

export function missingCloudProviderReloadKey(input: {
  workspaceId: string;
  imported: Record<string, CloudImportedProvider>;
  engineProviderIds: readonly string[];
}): string | null {
  const expected = new Set(
    Object.values(input.imported).map((entry) => entry.providerId.trim()).filter(Boolean),
  );
  if (expected.size === 0) return null;
  const known = new Set(input.engineProviderIds.map((id) => id.trim()).filter(Boolean));
  const missing = [...expected].filter((id) => !known.has(id)).sort();
  return missing.length > 0 ? `${input.workspaceId}::${missing.join(",")}` : null;
}

const CLOUD_PROVIDER_MODEL_FIELDS = [
  "family", "release_date", "attachment", "reasoning", "temperature", "tool_call",
  "interleaved", "structured_output", "open_weights", "cost", "limit", "modalities",
  "imageGeneration", "mediaGeneration", "status", "options", "headers", "provider", "variants",
] as const;

export const buildCloudProviderConfig = (
  provider: CloudProviderConnection,
  catalog?: DeploymentModelCatalog | null,
): CloudProviderConfig => {
  const sourceProviderId = provider.providerId.trim().toLowerCase();
  const catalogModels = catalog?.[provider.providerId] ??
    Object.entries(catalog ?? {}).find(
      ([providerId]) => providerId.trim().toLowerCase() === sourceProviderId,
    )?.[1] ?? null;
  const models = Object.fromEntries(provider.models.map((model) => {
    const next: Record<string, unknown> = { id: model.id, name: model.name };
    const raw = model.config ?? {};
    const catalogModel = catalogModels?.[model.id];
    for (const key of CLOUD_PROVIDER_MODEL_FIELDS) {
      const value = raw[key] !== undefined ? raw[key] : catalogModel?.[key];
      if (value !== undefined) next[key] = value;
    }
    return [model.id, next];
  }));
  const providerConfig = provider.providerConfig ?? {};
  const next: CloudProviderConfig = {
    id: provider.providerId,
    name: provider.name,
    env: getCloudProviderEnv(providerConfig),
    models,
  };
  if (typeof providerConfig.npm === "string" && providerConfig.npm.trim()) next.npm = providerConfig.npm;
  if (typeof providerConfig.api === "string" && providerConfig.api.trim()) next.api = providerConfig.api;
  if (providerConfig.options && typeof providerConfig.options === "object") {
    next.options = providerConfig.options as Record<string, unknown>;
  }
  if (Array.isArray(providerConfig.whitelist)) next.whitelist = getStringList(providerConfig.whitelist);
  if (Array.isArray(providerConfig.blacklist)) next.blacklist = getStringList(providerConfig.blacklist);
  return next;
};

export const buildRuntimeProviderPatch = (
  provider: CloudProviderConnection,
  localProviderId: string,
  previousProviderId?: string | null,
  catalog?: DeploymentModelCatalog | null,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  if (previousProviderId && previousProviderId !== localProviderId) patch[previousProviderId] = null;
  patch[localProviderId] = buildCloudProviderConfig(provider, catalog);
  return patch;
};
