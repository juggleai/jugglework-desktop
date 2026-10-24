import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import type { ComposerDraft } from "@/app/types";
import { parseComposerImageModels, imageModelKey, type ComposerImageModelOption } from "../session/surface/composer/image-generation";
import { parseComposerVideoModels, videoModelKey, type ComposerVideoModelOption } from "../session/surface/composer/video-generation";
import { generationDraftAvailable } from "../session/surface/composer/generation-model-reconciliation";
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

/** 主输入栏及后台队列共用image模型发现，使用目标工作区的服务与目录。 */
export function imageModelsQueryOptions(client: JuggleWorkServerClient, scope: MediaModelQueryScope) {
  return { queryKey: imageModelQueryKey(scope),
    queryFn: async () => {
      const response = await client.callExtensionAction({
        extensionId: "openai-image-generation",
        action: "image_models_list",
        args: { mode: "text-to-image" },
        context: {
          workspaceId: scope.workspaceId,
          directory: scope.workspaceRoot,
        },
      });
      if (!response.ok) throw new Error(response.message);
      return parseComposerImageModels(response.result);
    },
    staleTime: 30_000, retry: 1,
  };
}

/** 主输入栏及后台队列共用video模型发现，使用目标工作区的服务与目录。 */
export function videoModelsQueryOptions(client: JuggleWorkServerClient, scope: MediaModelQueryScope) {
  return { queryKey: videoModelQueryKey(scope),
    queryFn: async () => {
      const context = {
        workspaceId: scope.workspaceId,
        directory: scope.workspaceRoot,
      };
      const [modelsResponse, statusResponse] = await Promise.all([
        client.callExtensionAction({
          extensionId: "media-generation",
          action: "video_models_list",
          args: { mode: "text-to-video" },
          context,
        }),
        client.callExtensionAction({
          extensionId: "media-generation",
          action: "status",
          args: {},
          context,
        }),
      ]);
      if (!modelsResponse.ok) throw new Error(modelsResponse.message);
      if (!statusResponse.ok) throw new Error(statusResponse.message);
      const status = statusResponse.result && typeof statusResponse.result === "object"
        ? statusResponse.result as Record<string, unknown>
        : null;
      if (status?.submissionEnabled !== true) return [];
      return parseComposerVideoModels(modelsResponse.result);
    },
    staleTime: 30_000, retry: 1,
  };
}

/** 在异步准备后复查原目标的生成模型；无生成选项时不发起额外探测。 */
export function generationDraftAvailableInCache(query: QueryClient, scope: MediaModelQueryScope, draft: ComposerDraft) {
  const imageKey = imageModelQueryKey(scope), videoKey = videoModelQueryKey(scope);
  const unavailable = (key: QueryKey) => { const state = query.getQueryState(key); return !state || state.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated; };
  return generationDraftAvailable({ selection: draft.imageGeneration, models: query.getQueryData<ComposerImageModelOption[]>(imageKey) ?? [], unavailable: unavailable(imageKey), modelKey: imageModelKey })
    && generationDraftAvailable({ selection: draft.videoGeneration, models: query.getQueryData<ComposerVideoModelOption[]>(videoKey) ?? [], unavailable: unavailable(videoKey), modelKey: videoModelKey });
}
