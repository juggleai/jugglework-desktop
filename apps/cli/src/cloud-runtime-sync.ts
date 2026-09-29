import {
  filterImportableCloudOrgProviders,
  getCloudManagedProviderId,
  isCloudManagedProviderKey,
  isCloudProviderOutOfSync,
  type CloudImportedProvider,
  type CloudProvider,
} from "@jugglework/cloud-provider";
import type { CliOptions } from "./args.js";
import { JuggleWorkApiError, type JuggleWorkApiClient, type RuntimeProviderStatus, type WorkspaceInfo } from "./api.js";
import { CloudClient } from "./cloud-client.js";
import { resolveCloudOrganization } from "./cloud-organization.js";
import { CloudProfileStore, cloudProfilePath } from "./cloud-profiles.js";
import { normalizeCloudUrl } from "./cloud-url.js";
import { managedModelReservationPoints, modelFitsAvailablePoints, modelReservationPoints } from "./managed-points.js";
import { availableModels } from "./model-catalog.js";
import { importProvider, removeProvider } from "./provider-command.js";
import type { CliRenderer } from "./render.js";

type SyncApi = Pick<JuggleWorkApiClient,
  "workspaceConfig" | "providerList" | "providerStatus" | "preflightProviderAuthority" |
  "upsertUserEnvironment" | "removeUserEnvironment" | "setCloudProviderMirror" | "removeCloudProviderMirror" | "setProviderAuth" | "removeProviderAuth" |
  "patchCloudProviderConfig" | "reloadEngine" | "getCloudProviderImport" | "setCloudProviderImport" | "removeCloudProviderImport"
>;

type SyncCloud = Pick<CloudClient, "organizationState" | "providers" | "providerConnection" | "catalog" | "tenantAccount">;
type SyncStore = Pick<CloudProfileStore, "get" | "rememberedOrganization" | "selectOrganization">;
type SyncRenderer = Pick<CliRenderer, "info" | "warn" | "registerSecretValues">;

export type CloudRuntimeSyncResult = {
  organizationId: string | null;
  autoModel: string | null;
  imported: string[];
  removed: string[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function importedCloudProviders(config: { jugglework?: Record<string, unknown> }): Record<string, CloudImportedProvider> {
  const root = record(record(config.jugglework)?.cloudImports);
  const entries = record(root?.providers);
  return Object.fromEntries(Object.entries(entries ?? {}).flatMap(([key, value]) => {
    const item = record(value);
    if (!item || item.cloudProviderId !== key || typeof item.providerId !== "string" ||
      typeof item.sourceProviderId !== "string" || !Array.isArray(item.modelIds) ||
      !item.modelIds.every((modelId) => typeof modelId === "string")) return [];
    if (!isCloudManagedProviderKey(item.providerId)) return [];
    return [[key, item as CloudImportedProvider]];
  }));
}

function recommendedModel(providers: CloudProvider[], statuses: Map<string, RuntimeProviderStatus>, selectable: Set<string>, availablePoints: number | null): string | null {
  for (const provider of providers) {
    const providerId = getCloudManagedProviderId(provider);
    const status = statuses.get(providerId);
    if (!status?.loaded || !status.authenticated || status.enabled === false) continue;
    for (const model of provider.models) {
      const id = `${providerId}/${model.id}`;
      if (selectable.has(id) && status.models.some((item) => item.id === model.id && item.enabled) &&
        modelFitsAvailablePoints(provider, model, availablePoints)) return id;
    }
  }
  return null;
}

export async function synchronizeCloudRuntime(input: {
  options: CliOptions;
  api: SyncApi;
  workspace: WorkspaceInfo;
  renderer: SyncRenderer;
  cloud?: SyncCloud;
  store?: SyncStore;
  ownedRuntime?: boolean;
}): Promise<CloudRuntimeSyncResult> {
  const { options, api, workspace, renderer } = input;
  const empty = { organizationId: null, autoModel: null, imported: [], removed: [] };
  // An environment token is intentionally temporary; never persist its credentials into a workspace.
  if (options.cloudToken) return empty;
  const urls = normalizeCloudUrl(options.cloudUrl);
  const store = input.store ?? new CloudProfileStore(cloudProfilePath(options.configPath));
  const profile = await store.get(urls.origin);
  if (!profile) {
    if (input.ownedRuntime === false) return empty;
    const removed = await removeImportedCloudRuntimeProviders(api, workspace);
    if (removed.length) renderer.info(`Removed ${removed.length} previously imported Cloud provider(s) after sign-out.`);
    return { ...empty, removed };
  }
  renderer.registerSecretValues([profile.token]);
  const cloud = input.cloud ?? new CloudClient(urls);
  const state = await cloud.organizationState(profile.token);
  const organization = resolveCloudOrganization(state, {
    explicit: options.cloudOrg,
    remembered: profile.user?.id ? await store.rememberedOrganization(urls.origin, profile.user.id) : null,
    current: profile.organizationId,
  });
  if (!organization) throw new Error("Cloud login has no available organization. Use 'jugglework org list' to check the account.");
  if (profile.organizationId !== organization.id) await store.selectOrganization(urls.origin, organization.id);

  const providers = filterImportableCloudOrgProviders(await cloud.providers(profile.token, organization.id));
  const hasManagedModels = providers.some((provider) => provider.source?.trim().toLowerCase() === "juggle_router" && provider.models.length > 0);
  const availablePoints = hasManagedModels ? (await cloud.tenantAccount(profile.token, organization.id)).availablePoints : null;
  const config = await api.workspaceConfig(workspace.id);
  const previous = importedCloudProviders(config);
  if (providers.length || Object.keys(previous).length) {
    try {
      await api.preflightProviderAuthority(workspace.id);
    } catch (error) {
      if (error instanceof JuggleWorkApiError && (error.status === 401 || error.status === 403)) {
        throw new Error("Organization provider sync needs runtime host authority. In connected mode, pass --host-token or set JUGGLEWORK_HOST_TOKEN.");
      }
      throw error;
    }
  }
  const liveIds = new Set(providers.map((provider) => provider.id));
  const removed: string[] = [];
  for (const old of Object.values(previous)) {
    if (liveIds.has(old.cloudProviderId)) continue;
    await removeProvider({ runtime: api, workspaceId: workspace.id, cloudProviderId: old.cloudProviderId });
    removed.push(old.cloudProviderId);
  }

  const statuses = new Map<string, RuntimeProviderStatus>();
  const imported: string[] = [];
  for (const provider of providers) {
    const providerId = getCloudManagedProviderId(provider);
    const baseline = previous[provider.id];
    const status = await api.providerStatus(workspace.id, providerId);
    const needsImport = !baseline || isCloudProviderOutOfSync(provider, baseline, organization.id) || !status.loaded || !status.authenticated || status.enabled === false;
    if (needsImport) {
      const updated = await importProvider({
        cloud, runtime: api, token: profile.token, organizationId: organization.id,
        workspaceId: workspace.id, cloudProviderId: provider.id,
        registerSecrets: (values) => renderer.registerSecretValues(values),
      });
      statuses.set(providerId, updated);
      imported.push(provider.id);
    } else {
      statuses.set(providerId, status);
    }
  }

  const selectable = providers.length
    ? new Set(availableModels(await api.providerList(workspace.id)).map((model) => model.id))
    : new Set<string>();
  const preferred = recommendedModel(providers, statuses, selectable, availablePoints);
  const preferredProvider = providers.find((provider) => getCloudManagedProviderId(provider) === preferred?.split("/")[0]);
  const preferredLabel = preferred && preferredProvider
    ? `${preferredProvider.name}/${preferred.slice(preferred.indexOf("/") + 1)}`
    : preferred;
  if (providers.some((provider) => provider.models.length > 0) && !preferred) {
    const managedRequirements = providers.flatMap((provider) => provider.models.flatMap((model) => {
      const required = managedModelReservationPoints(provider, model);
      return required === null ? [] : [required];
    }));
    if (availablePoints !== null && managedRequirements.length) {
      throw new Error(`Organization ${organization.name} has ${availablePoints} available points, but its least expensive managed model requires ${Math.min(...managedRequirements)} points for a safe request reservation.`);
    }
    throw new Error(`Organization ${organization.name} has published models, but none are connected and usable in this workspace. Run 'jugglework doctor'.`);
  }

  const configured = typeof config.opencode?.model === "string" ? config.opencode.model.trim() : "";
  const configuredProvider = configured.split("/")[0] ?? "";
  const selectedProvider = options.model?.split("/")[0] ?? "";
  const publishedModels = new Set(providers.flatMap((provider) => provider.models.map((model) => `${getCloudManagedProviderId(provider)}/${model.id}`)));
  const explicitStale = Boolean(options.model && isCloudManagedProviderKey(selectedProvider) && !publishedModels.has(options.model));
  const configuredStale = Boolean(configured && isCloudManagedProviderKey(configuredProvider) && !publishedModels.has(configured));
  const configuredRequiredPoints = configured ? modelReservationPoints(providers, configured) : null;
  const configuredUnaffordable = availablePoints !== null && configuredRequiredPoints !== null && configuredRequiredPoints > availablePoints;
  if ((explicitStale || configuredStale) && !preferred) {
    throw new Error(`The selected Cloud model no longer belongs to organization ${organization.name}, and no usable organization model is available. Choose an explicit model or use 'jugglework org list'.`);
  }
  if (explicitStale) renderer.warn(`The selected model belongs to a different organization; using ${preferredLabel ?? "the runtime default"} instead.`);
  if (configuredStale) renderer.warn(`The workspace default model belongs to a different organization; using ${preferredLabel ?? "the runtime default"} for this CLI session.`);
  if (configuredUnaffordable) renderer.warn(`The workspace default model requires at least ${configuredRequiredPoints} points, but organization ${organization.name} has ${availablePoints}; using ${preferredLabel ?? "the runtime default"} for this CLI session.`);
  if (explicitStale) options.model = null;
  const autoModel = (!options.model && (!configured || configuredStale || configuredUnaffordable || explicitStale)) ? preferred : null;

  if (imported.length || removed.length) renderer.info(`Organization ${organization.name}: ${imported.length} provider(s) synchronized, ${removed.length} stale provider(s) removed.`);
  if (autoModel) renderer.info(`Organization default model: ${preferredLabel}.`);
  else if (!providers.length) renderer.warn(`Organization ${organization.name} has no enabled model providers; the CLI will use its existing model configuration.`);
  return { organizationId: organization.id, autoModel, imported, removed };
}

export async function removeImportedCloudRuntimeProviders(api: SyncApi, workspace: WorkspaceInfo): Promise<string[]> {
  const existing = importedCloudProviders(await api.workspaceConfig(workspace.id));
  const removed: string[] = [];
  for (const item of Object.values(existing)) {
    await removeProvider({ runtime: api, workspaceId: workspace.id, cloudProviderId: item.cloudProviderId });
    removed.push(item.cloudProviderId);
  }
  return removed;
}
