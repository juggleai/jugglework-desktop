import { describe, expect, test } from "bun:test";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import type { JuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import type { ComposerDraft } from "../src/app/types";
import { invalidateManagedProviderScope, notifyManagedProviderCatalogChanged } from "../src/app/lib/managed-provider-scope";

import {
  imageModelQueryKey,
  imageModelsQueryOptions,
  generationDraftAvailableInCache,
  managedMediaScope,
  invalidateMediaModelQueries,
  refreshMediaModelsAfterProviderListTransition,
  runProviderMutationWithMediaRefresh,
  videoModelQueryKey,
  videoModelsQueryOptions,
  withProviderMediaModelRefresh,
} from "../src/react-app/domains/connections/media-model-queries";

const scope = {
  endpoint: "http://127.0.0.1:17832/",
  workspaceId: "workspace-a",
  workspaceRoot: "/work/a",
};

describe("media model queries", () => {
  const descriptors = [
    { ref: { providerID: "lpr_previous", modelID: "model" } },
    { ref: { providerID: "gateway-alias", modelID: "model" }, managed: true },
    { ref: { providerID: "explicit-local", modelID: "model" } },
  ];

  test.each([imageModelsQueryOptions, videoModelsQueryOptions])("late media queries drop managed models, including aliases, while retaining local models", async (options) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = { callExtensionAction: async ({ action }: { action: string }) => {
      if (action === "status") return { ok: true, result: { submissionEnabled: true } };
      await gate;
      return { ok: true, result: { models: descriptors } };
    } } as unknown as JuggleWorkServerClient;
    const old = options(client, scope);
    const pending = old.queryFn();
    invalidateManagedProviderScope();
    release();
    expect((await pending).map((model) => model.providerID)).toEqual(["explicit-local"]);
    const current = options(client, scope);
    expect(current.queryKey).not.toEqual(old.queryKey);
    notifyManagedProviderCatalogChanged();
    expect(options(client, scope).queryKey).not.toEqual(current.queryKey);
  });

  test("a new scope cannot drain old or unbound managed image/video drafts even when it has the same models", () => {
    const query = new QueryClient();
    const populate = () => {
      const models = descriptors.map(({ ref, managed }) => ({ ...ref, managed, modelName: "model", providerName: ref.providerID }));
      query.setQueryData(imageModelQueryKey(scope), models);
      query.setQueryData(videoModelQueryKey(scope), models);
    };
    const base: ComposerDraft = { mode: "prompt", text: "generate", attachments: [], parts: [] };
    const selection = { model: descriptors[1]!.ref, modelName: "model", providerName: "alias", aspectRatio: "auto" as const };
    const imageDraft: ComposerDraft = { ...base, imageGeneration: { ...selection, style: "auto", managedScope: managedMediaScope() } };
    const videoDraft: ComposerDraft = { ...base, videoGeneration: { ...selection, durationSeconds: 5, managedScope: managedMediaScope() } };
    populate();
    for (const draft of [imageDraft, videoDraft]) expect(generationDraftAvailableInCache(query, scope, draft)).toBe(true);
    invalidateManagedProviderScope();
    populate();
    for (const draft of [imageDraft, videoDraft]) expect(generationDraftAvailableInCache(query, scope, draft)).toBe(false);
    expect(generationDraftAvailableInCache(query, scope, { ...base, videoGeneration: { ...selection, durationSeconds: 5 } })).toBe(false);
    expect(generationDraftAvailableInCache(query, scope, { ...base, imageGeneration: { ...selection, model: descriptors[2]!.ref, style: "auto" } })).toBe(true);
    query.clear();
  });

  test("invalidates only image and video queries in the captured endpoint/workspace/root scope", async () => {
    const queryClient = new QueryClient();
    const otherScope = { ...scope, workspaceId: "workspace-b", workspaceRoot: "/work/b" };
    queryClient.setQueryData(imageModelQueryKey(scope), ["image-a"]);
    queryClient.setQueryData(videoModelQueryKey(scope), ["video-a"]);
    queryClient.setQueryData(imageModelQueryKey(otherScope), ["image-b"]);

    await invalidateMediaModelQueries(queryClient, scope);

    expect(queryClient.getQueryState(imageModelQueryKey(scope))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(videoModelQueryKey(scope))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(imageModelQueryKey(otherScope))?.isInvalidated).toBe(false);
  });

  test("captures scope at invocation and keeps a successful mutation successful when refresh fails", async () => {
    const calls: string[] = [];
    const queryClient = {
      cancelQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
        calls.push(`cancel:${queryKey.join("|")}`);
      },
      invalidateQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
        calls.push(`invalidate:${queryKey.join("|")}`);
        throw new Error("refresh failed");
      },
    } as unknown as QueryClient;
    const mutableScope = { ...scope };
    let refreshError = "";

    const promise = runProviderMutationWithMediaRefresh({
      mutation: async () => {
        mutableScope.workspaceId = "workspace-b";
        return "connected";
      },
      queryClient,
      scope: mutableScope,
      onRefreshError: (error) => { refreshError = String(error); },
    });

    await expect(promise).resolves.toBe("connected");
    expect(calls[0]).toContain("workspace-a");
    expect(calls[2]).toContain("workspace-a");
    expect(calls[0]?.startsWith("cancel:")).toBe(true);
    expect(calls[1]?.startsWith("cancel:")).toBe(true);
    expect(calls[2]?.startsWith("invalidate:")).toBe(true);
    expect(refreshError).toContain("refresh failed");
  });

  test("does not refresh after a failed mutation", async () => {
    let refreshed = false;
    const queryClient = {
      cancelQueries: async () => { refreshed = true; },
      invalidateQueries: async () => { refreshed = true; },
    } as unknown as QueryClient;

    await expect(runProviderMutationWithMediaRefresh({
      mutation: async () => { throw new Error("connect failed"); },
      queryClient,
      scope,
    })).rejects.toThrow("connect failed");
    expect(refreshed).toBe(false);
  });

  test("wraps every provider mutation path that can change media availability", async () => {
    const refreshed: string[] = [];
    const queryClient = {
      cancelQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
        refreshed.push(`cancel:${queryKey[1]}`);
      },
      invalidateQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
        refreshed.push(`invalidate:${queryKey[1]}`);
      },
    } as unknown as QueryClient;
    const result = "success";
    const base = {
      completeProviderAuthOAuth: async () => ({ connected: true }),
      submitProviderApiKey: async () => result,
      connectCustomProvider: async () => result,
      connectCloudProvider: async () => result,
      removeCloudProvider: async () => result,
      disconnectProvider: async () => result,
      refreshProviders: async () => null,
      runCloudProviderSync: async () => undefined,
      runCloudProviderSyncForReadiness: async () => true,
    };
    const store = withProviderMediaModelRefresh(base as never, { queryClient, scope: () => scope });
    const mutations = [
      () => store.completeProviderAuthOAuth("provider", 0),
      () => store.submitProviderApiKey("provider", "key"),
      () => store.connectCustomProvider({} as never),
      () => store.connectCloudProvider("cloud"),
      () => store.removeCloudProvider("cloud"),
      () => store.disconnectProvider("provider"),
      () => store.runCloudProviderSync("app_resume"),
      () => store.runCloudProviderSyncForReadiness("app_resume"),
    ];

    for (const mutation of mutations) {
      refreshed.length = 0;
      await mutation();
      expect(refreshed).toEqual([
        "cancel:image",
        "cancel:video",
        "invalidate:image",
        "invalidate:video",
      ]);
    }

    refreshed.length = 0;
    await store.refreshProviders();
    expect(refreshed).toEqual([]);
  });

  test("provider deletion completes while media model queries are still refreshing", async () => {
    let finishRefresh!: () => void;
    const pendingRefresh = new Promise<void>((resolve) => { finishRefresh = resolve; });
    const calls: QueryKey[] = [];
    const queryClient = {
      cancelQueries: async () => {},
      invalidateQueries: async ({ queryKey }: { queryKey: QueryKey }) => {
        calls.push(queryKey);
        await pendingRefresh;
      },
    } as unknown as QueryClient;
    const store = withProviderMediaModelRefresh({
      deleteProvider: async () => "deleted",
    } as never, { queryClient, scope: () => scope });

    try {
      await expect(store.deleteProvider("provider")).resolves.toBe("deleted");
      await Promise.resolve();
      expect(calls).toEqual([imageModelQueryKey(scope), videoModelQueryKey(scope)]);
    } finally {
      finishRefresh();
    }
  });

  test("does not refresh for OAuth or cloud-readiness attempts that did not connect", async () => {
    let refreshed = false;
    const queryClient = {
      cancelQueries: async () => { refreshed = true; },
      invalidateQueries: async () => { refreshed = true; },
    } as unknown as QueryClient;
    const base = {
      completeProviderAuthOAuth: async () => ({ connected: false, pending: true }),
      runCloudProviderSyncForReadiness: async () => false,
      refreshProviders: async () => ({ connected: ["provider"] }),
    };
    const store = withProviderMediaModelRefresh(base as never, { queryClient, scope: () => scope });

    await store.completeProviderAuthOAuth("provider", 0);
    await store.runCloudProviderSyncForReadiness("app_resume");
    expect(refreshed).toBe(false);
  });

  test("OAuth provider-list polling invalidates media only on a connection transition", async () => {
    const calls: string[] = [];
    const queryClient = {
      cancelQueries: async () => { calls.push("cancel"); },
      invalidateQueries: async () => { calls.push("invalidate"); },
    } as unknown as QueryClient;
    await refreshMediaModelsAfterProviderListTransition({
      refreshProviders: async () => ({ connected: ["pictest"] }),
      providerId: "PICTEST",
      connectedBefore: false,
      queryClient,
      scope,
    });
    expect(calls).toEqual(["cancel", "cancel", "invalidate", "invalidate"]);
    calls.length = 0;
    await refreshMediaModelsAfterProviderListTransition({
      refreshProviders: async () => ({ connected: ["pictest"] }),
      providerId: "pictest",
      connectedBefore: true,
      queryClient,
      scope,
    });
    expect(calls).toEqual([]);
  });
});
