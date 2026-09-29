import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { ProviderAuthStore } from "./provider-auth/store";

export const MEDIA_MODEL_QUERY_ROOT = ["composer-media-generation-models"] as const;

export type MediaModelQueryScope = {
  endpoint: string;
  workspaceId: string;
  workspaceRoot: string;
};

export type MediaRefreshProviderAuthStore = ProviderAuthStore & {
  refreshProvidersForConnectionTransition: (
    transition: { providerId: string; connectedBefore: boolean },
  ) => ReturnType<ProviderAuthStore["refreshProviders"]>;
};

export function mediaModelQueryScope(input: MediaModelQueryScope): MediaModelQueryScope {
  return {
    endpoint: input.endpoint.trim().replace(/\/+$/, ""),
    workspaceId: input.workspaceId.trim(),
    workspaceRoot: input.workspaceRoot.trim(),
  };
}

function mediaModelQueryKey(kind: "image" | "video", scope: MediaModelQueryScope): QueryKey {
  const normalized = mediaModelQueryScope(scope);
  return [
    ...MEDIA_MODEL_QUERY_ROOT,
    kind,
    normalized.endpoint,
    normalized.workspaceId,
    normalized.workspaceRoot,
  ] as const;
}

export const imageModelQueryKey = (scope: MediaModelQueryScope) => mediaModelQueryKey("image", scope);
export const videoModelQueryKey = (scope: MediaModelQueryScope) => mediaModelQueryKey("video", scope);

export async function invalidateMediaModelQueries(
  queryClient: QueryClient,
  scope: MediaModelQueryScope,
): Promise<void> {
  const queryKeys = [imageModelQueryKey(scope), videoModelQueryKey(scope)];
  await Promise.all(queryKeys.map((queryKey) => queryClient.cancelQueries({ queryKey, exact: true })));
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" })));
}

export async function refreshMediaModelsAfterProviderListTransition(input: {
  refreshProviders: () => ReturnType<ProviderAuthStore["refreshProviders"]>;
  providerId: string;
  connectedBefore: boolean;
  queryClient: QueryClient;
  scope: MediaModelQueryScope;
  onRefreshError?: (error: unknown) => void;
}): ReturnType<ProviderAuthStore["refreshProviders"]> {
  const capturedScope = mediaModelQueryScope(input.scope);
  const result = await input.refreshProviders();
  const connectedAfter = Boolean(result?.connected?.some(
    (providerId) => providerId.trim().toLowerCase() === input.providerId.trim().toLowerCase(),
  ));
  if (connectedAfter === input.connectedBefore) return result;
  try {
    await invalidateMediaModelQueries(input.queryClient, capturedScope);
  } catch (error) {
    input.onRefreshError?.(error);
  }
  return result;
}

export async function runProviderMutationWithMediaRefresh<T>(input: {
  mutation: () => Promise<T>;
  queryClient: QueryClient;
  scope: MediaModelQueryScope;
  onRefreshError?: (error: unknown) => void;
}): Promise<T> {
  const capturedScope = mediaModelQueryScope(input.scope);
  const result = await input.mutation();
  try {
    await invalidateMediaModelQueries(input.queryClient, capturedScope);
  } catch (error) {
    input.onRefreshError?.(error);
  }
  return result;
}

export function withProviderMediaModelRefresh(
  store: ProviderAuthStore,
  input: {
    queryClient: QueryClient;
    scope: () => MediaModelQueryScope;
    onRefreshError?: (error: unknown) => void;
  },
): MediaRefreshProviderAuthStore {
  const wrap = <Args extends unknown[], Result>(
    mutation: (...args: Args) => Promise<Result>,
    shouldRefresh: (result: Result) => boolean = () => true,
  ) => async (...args: Args) => {
    const capturedScope = mediaModelQueryScope(input.scope());
    const result = await mutation(...args);
    if (!shouldRefresh(result)) return result;
    try {
      await invalidateMediaModelQueries(input.queryClient, capturedScope);
    } catch (error) {
      input.onRefreshError?.(error);
    }
    return result;
  };
  const refreshProvidersForConnectionTransition = async (transition: { providerId: string; connectedBefore: boolean }) => {
    return refreshMediaModelsAfterProviderListTransition({
      refreshProviders: () => store.refreshProviders(),
      providerId: transition.providerId,
      connectedBefore: transition.connectedBefore,
      queryClient: input.queryClient,
      scope: input.scope(),
      onRefreshError: input.onRefreshError,
    });
  };

  return {
    ...store,
    refreshProvidersForConnectionTransition,
    completeProviderAuthOAuth: wrap(store.completeProviderAuthOAuth, (result) => result.connected),
    submitProviderApiKey: wrap(store.submitProviderApiKey),
    connectCustomProvider: wrap(store.connectCustomProvider),
    connectCloudProvider: wrap(store.connectCloudProvider),
    removeCloudProvider: wrap(store.removeCloudProvider),
    disconnectProvider: wrap(store.disconnectProvider),
    deleteProvider: wrap(store.deleteProvider),
    runCloudProviderSync: wrap(store.runCloudProviderSync),
    runCloudProviderSyncForReadiness: wrap(store.runCloudProviderSyncForReadiness, Boolean),
  };
}
