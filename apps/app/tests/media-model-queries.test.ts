import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  imageModelQueryKey,
  invalidateMediaModelQueries,
  refreshMediaModelsAfterProviderListTransition,
  runProviderMutationWithMediaRefresh,
  videoModelQueryKey,
  withProviderMediaModelRefresh,
} from "../src/react-app/domains/connections/media-model-queries";

const scope = {
  endpoint: "http://127.0.0.1:17832/",
  workspaceId: "workspace-a",
  workspaceRoot: "/work/a",
};

describe("media model queries", () => {
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
      deleteProvider: async () => result,
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
      () => store.deleteProvider("provider"),
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
