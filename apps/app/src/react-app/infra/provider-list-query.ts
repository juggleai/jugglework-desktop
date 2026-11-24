import { useMemo } from "react";
import { isManagedProvider } from "@jugglework/types/provider-credentials";
import { managedProviderEpoch, managedProviderSwitchPending, useManagedProviderEpoch } from "../../app/lib/managed-provider-scope";
import { readDenSettings, readDenUserId } from "../../app/lib/den";
import { skipToken, useQuery, type QueryClient } from "@tanstack/react-query";

import type { Client, ModelRef, ProviderListItem } from "../../app/types";
import { unwrap } from "../../app/lib/opencode";
import { dispatchNewProviders } from "../../app/lib/provider-events";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import { isChatSelectableProviderModel } from "@jugglework/types/media-generation";
export { isChatSelectableProviderModel } from "@jugglework/types/media-generation";

export const PROVIDER_LIST_CACHE_MS = 5 * 60 * 1000;
const PROVIDER_LIST_QUERY_ROOT = ["opencode-provider-list"] as const;

export type ConnectedProviderSnapshot = Array<{
  id: string;
  name: string;
  source: ProviderListItem["source"];
  models: Record<string, ProviderListItem["models"][string]>;
}>;

export type ConnectedProviderSnapshotChange = {
  changed: boolean;
  previous: ConnectedProviderSnapshot | null;
  next: ConnectedProviderSnapshot;
};

const connectedProviderSnapshots = new Map<string, ConnectedProviderSnapshot>();
const connectedProviderSnapshotChanges = new Map<string, ConnectedProviderSnapshotChange>();
const deletedProvidersByWorkspace = new Map<string, Set<string>>();

function providerListEndpoint(baseUrl?: string | null) {
  return baseUrl?.trim().replace(/\/+$/, "") ?? "";
}

function providerListHost(endpoint: string) {
  return endpoint.replace(/\/workspace\/[^/]+\/opencode$/, "/opencode");
}

function withoutProviders(value: ProviderListResponse, hidden: Set<string>): ProviderListResponse {
  return {
    ...value,
    all: value.all.filter(({ id }) => !hidden.has(id)),
    connected: value.connected.filter((id) => !hidden.has(id)),
    default: Object.fromEntries(Object.entries(value.default ?? {}).filter(([id]) => !hidden.has(id))),
  };
}

export function providerListQueryKey(input: {
  baseUrl?: string | null;
  directory?: string | null;
  scopeEpoch?: number;
}) {
  return [
    ...PROVIDER_LIST_QUERY_ROOT,
    input.baseUrl?.trim() ?? "",
    input.directory?.trim() ?? "",
    input.scopeEpoch ?? managedProviderEpoch(),
  ] as const;
}

export async function refreshProviderListQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT });
  await queryClient.refetchQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT, type: "active" });
}

export async function removeDeletedProviderFromQueries(
  queryClient: QueryClient,
  baseUrl: string,
  providerId: string,
) {
  const endpoint = providerListEndpoint(baseUrl);
  if (!endpoint) return;
  const removed = deletedProvidersByWorkspace.get(endpoint) ?? new Set<string>();
  removed.add(providerId);
  deletedProvidersByWorkspace.set(endpoint, removed);
  const filters = {
    queryKey: PROVIDER_LIST_QUERY_ROOT,
    predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
      typeof queryKey[1] === "string" && providerListHost(providerListEndpoint(queryKey[1])) === providerListHost(endpoint),
  };
  // A request started before the config write can still carry the deleted entry.
  await queryClient.cancelQueries(filters);
  queryClient.setQueriesData<ProviderListResponse>({
    queryKey: PROVIDER_LIST_QUERY_ROOT,
    predicate: ({ queryKey }) => typeof queryKey[1] === "string" && providerListEndpoint(queryKey[1]) === endpoint,
  }, (value) => value && withoutProviders(value, removed));
  // Other workspaces can still have a project definition for the same ID.
  void queryClient.invalidateQueries(filters);
}

export function restoreRecreatedProvider(baseUrl: string, providerId: string) {
  const host = providerListHost(providerListEndpoint(baseUrl));
  for (const [endpoint, removed] of deletedProvidersByWorkspace) {
    if (providerListHost(endpoint) !== host) continue;
    removed.delete(providerId);
    if (!removed.size) deletedProvidersByWorkspace.delete(endpoint);
  }
}

export async function fetchProviderList(input: {
  client: Client;
  baseUrl?: string | null;
  directory?: string | null;
  scopeEpoch?: number;
}): Promise<ProviderListResponse> {
  const epoch = input.scopeEpoch ?? managedProviderEpoch();
  const value = unwrap(
    await input.client.provider.list({
      directory: input.directory?.trim() || undefined,
    }),
  );
  const hosted = /\/opencode(?:\/|$)/.test(input.baseUrl ?? "");
  const all = hosted && epoch === managedProviderEpoch() && !managedProviderSwitchPending() ? value.all : value.all.filter((item) => !isManagedProvider(item.id, item));
  const ids = new Set(all.map((item) => item.id));
  let filtered = { ...value, all, connected: value.connected.filter((id) => ids.has(id)), default: Object.fromEntries(Object.entries(value.default ?? {}).filter(([id]) => ids.has(id))) };
  const endpoint = providerListEndpoint(input.baseUrl);
  const removed = deletedProvidersByWorkspace.get(endpoint);
  if (removed?.size) {
    const stillReported = new Set(value.all.filter(({ id, source }) => source === "config" && removed.has(id)).map(({ id }) => id));
    if (epoch === managedProviderEpoch()) {
      if (stillReported.size) deletedProvidersByWorkspace.set(endpoint, stillReported);
      else deletedProvidersByWorkspace.delete(endpoint);
    }
    if (stillReported.size) filtered = withoutProviders(filtered, stillReported);
  }
  if (epoch === managedProviderEpoch()) recordConnectedProviderSnapshot(input, filtered);
  return filtered;
}

export function getConnectedProviderItems(value: ProviderListResponse | null | undefined) {
  const connected = new Set(value?.connected ?? []);
  return (value?.all ?? []).filter(
    (provider) =>
      connected.has(provider.id) &&
      (provider.source !== "custom" || provider.id === "opencode" || Object.keys(provider.models ?? {}).length > 0),
  );
}

// The engine can still report retired groups until a safe instance reload.
export function cloudGroupCatalogKey() {
  const settings = readDenSettings();
  return ["enabled-cloud-groups", settings.baseUrl, settings.activeOrgId, readDenUserId(), managedProviderEpoch()] as const;
}

export function usePickerProviderItems(value: ProviderListResponse | null | undefined, options?: { fileWindow?: boolean }) {
  const scopeEpoch = useManagedProviderEpoch();
  const scopeCurrent = scopeEpoch === managedProviderEpoch() && !managedProviderSwitchPending();
  const catalog = useQuery<string[]>({ queryKey: cloudGroupCatalogKey(), queryFn: skipToken });
  // The isolated file renderer has no Den authority store. Its workspace
  // proxy already checks readiness, and Main invalidates its query on changes.
  const fileWindow = options?.fileWindow === true;
  return useMemo(() => {
    const enabled = catalog.data && new Set(catalog.data);
    return getConnectedProviderItems(value).filter((provider) => !isManagedProvider(provider.id, provider) || (scopeCurrent && (fileWindow || enabled?.has(provider.id))));
  }, [catalog.data, fileWindow, scopeCurrent, value]);
}

export function getConnectedProviderSnapshot(value: ProviderListResponse | null | undefined): ConnectedProviderSnapshot {
  return getConnectedProviderItems(value)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: provider.source,
      models: Object.fromEntries(
        Object.entries(provider.models ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Engine-reported source of one provider in a provider-list response
 * ("config" when the user declared it in an OpenCode config file). Returns
 * undefined when the response does not carry that provider.
 */
export function getProviderSource(
  value: ProviderListResponse | null | undefined,
  providerId: string | null | undefined,
): ProviderListItem["source"] | undefined {
  const id = providerId?.trim();
  if (!id) return undefined;
  return (value?.all ?? []).find((provider) => provider.id === id)?.source;
}

export function isModelAvailableInConnectedProviders(
  value: ProviderListResponse | null | undefined,
  model: ModelRef | null | undefined,
) {
  if (!model?.providerID || !model.modelID) return true;
  return getConnectedProviderItems(value).some(
    (provider) =>
      provider.id === model.providerID &&
      Boolean(provider.models?.[model.modelID]) &&
      isChatSelectableProviderModel(provider.models?.[model.modelID]),
  );
}

export function getChatSelectableModelEntries<T>(
  models: Record<string, T> | null | undefined,
): Array<[string, T]> {
  return Object.entries(models ?? {}).filter(([, model]) => isChatSelectableProviderModel(model));
}

/**
 * Keep a remembered model when it still exists, otherwise choose the first
 * model of the first connected provider that exposes an allowed model. Both
 * provider and model order are the engine's insertion order.
 */
export function resolveConnectedProviderModel(
  value: ProviderListResponse | null | undefined,
  preferred: ModelRef | null | undefined,
  options?: {
    preferSameModelID?: boolean;
    isAllowed?: (input: { provider: ProviderListItem; model: ModelRef }) => boolean;
  },
): ModelRef | null {
  const providers = getConnectedProviderItems(value);
  const isAllowed = options?.isAllowed ?? (() => true);
  if (preferred) {
    const provider = providers.find((item) => item.id === preferred.providerID);
    if (
      provider?.models?.[preferred.modelID] &&
      isChatSelectableProviderModel(provider.models[preferred.modelID]) &&
      isAllowed({ provider, model: preferred })
    ) {
      return preferred;
    }
  }
  if (preferred && options?.preferSameModelID) {
    for (const provider of providers) {
      const model = { providerID: provider.id, modelID: preferred.modelID };
      const entry = provider.models?.[model.modelID];
      if (entry && isChatSelectableProviderModel(entry) && isAllowed({ provider, model })) return model;
    }
  }
  for (const provider of providers) {
    for (const modelID of Object.keys(provider.models ?? {})) {
      const model = { providerID: provider.id, modelID };
      if (
        modelID.trim() &&
        isChatSelectableProviderModel(provider.models?.[modelID]) &&
        isAllowed({ provider, model })
      ) return model;
    }
  }
  return null;
}

export function getConnectedProviderSnapshotChange(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return connectedProviderSnapshotChanges.get(connectedProviderSnapshotKey(input)) ?? null;
}

function recordConnectedProviderSnapshot(
  input: {
    baseUrl?: string | null;
    directory?: string | null;
    scopeEpoch?: number;
  },
  value: ProviderListResponse,
) {
  const key = connectedProviderSnapshotKey(input);
  const previous = connectedProviderSnapshots.get(key) ?? null;
  const next = getConnectedProviderSnapshot(value);
  const changed = previous !== null && JSON.stringify(previous) !== JSON.stringify(next);
  connectedProviderSnapshots.set(key, next);
  connectedProviderSnapshotChanges.set(key, { changed, previous, next });
  if (changed) {
    dispatchConnectedProviderChanges(previous, next);
  }
}

function connectedProviderSnapshotKey(input: {
  baseUrl?: string | null;
  directory?: string | null;
  scopeEpoch?: number;
}) {
  return JSON.stringify(providerListQueryKey(input).slice(0, -1));
}

function dispatchConnectedProviderChanges(
  previous: ConnectedProviderSnapshot | null,
  next: ConnectedProviderSnapshot,
) {
  if (!previous) return;
  const previousById = new Map(previous.map((provider) => [provider.id, provider]));
  const newProviders = next.filter((provider) => !previousById.has(provider.id));
  const changedProviders = new Map<string, ConnectedProviderSnapshot[number]>();
  let newModelCount = 0;

  for (const provider of next) {
    const before = previousById.get(provider.id);
    if (!before) {
      newModelCount += Object.keys(provider.models).length;
      changedProviders.set(provider.id, provider);
      continue;
    }
    for (const [id, model] of Object.entries(provider.models)) {
      if (JSON.stringify(before.models[id]) !== JSON.stringify(model)) {
        newModelCount += 1;
        changedProviders.set(provider.id, provider);
      }
    }
  }

  if (newProviders.length === 0 && newModelCount === 0) return;

  dispatchNewProviders({
    providers: [...changedProviders.values()].map((provider) => {
      const firstModelId = Object.keys(provider.models)[0];
      return {
        id: provider.id,
        name: provider.name,
        providerId: provider.id,
        firstModelId,
        firstModelName: firstModelId ? provider.models[firstModelId]?.name ?? firstModelId : undefined,
      };
    }),
    newProviderCount: newProviders.length,
    newModelCount,
    source: "models_refresh",
  });
}

export function ensureProviderListQuery(
  queryClient: QueryClient,
  input: {
    client: Client;
    baseUrl?: string | null;
    directory?: string | null;
    scopeEpoch?: number;
    force?: boolean;
  },
) {
  const scopeEpoch = input.scopeEpoch ?? managedProviderEpoch();
  const options = {
    queryKey: providerListQueryKey({ ...input, scopeEpoch }),
    queryFn: () => fetchProviderList({ ...input, scopeEpoch }),
    gcTime: PROVIDER_LIST_CACHE_MS,
  };
  if (input.force) {
    return queryClient.fetchQuery({
      ...options,
      staleTime: 0,
    });
  }
  return queryClient.fetchQuery({
    ...options,
    staleTime: PROVIDER_LIST_CACHE_MS,
  });
}

export function useProviderListQuery(input: {
  client: Client | null;
  baseUrl?: string | null;
  directory?: string | null;
  enabled?: boolean;
}) {
  const scopeEpoch = useManagedProviderEpoch();
  return useQuery({
    queryKey: providerListQueryKey({ ...input, scopeEpoch }),
    enabled: Boolean(input.client) && (input.enabled ?? true),
    staleTime: PROVIDER_LIST_CACHE_MS,
    gcTime: PROVIDER_LIST_CACHE_MS,
    queryFn: () => {
      if (!input.client) {
        return {
          all: [] as ProviderListItem[],
          connected: [],
          default: {},
        } satisfies ProviderListResponse;
      }
      return fetchProviderList({
        client: input.client,
        baseUrl: input.baseUrl,
        directory: input.directory,
        scopeEpoch,
      });
    },
  });
}
