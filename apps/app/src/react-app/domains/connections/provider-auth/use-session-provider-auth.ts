// Session-route wiring for the provider-auth store: a stable store instance
// fed by a latest-values ref, lifecycle (start/dispose), Zen-restriction sync,
// workspace-change resync, the post-onboarding auto-open latch, and cloud
// provider auto-sync. Extracted verbatim from session-route.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client, ProviderListItem, WorkspaceDisplay } from "@/app/types";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import {
  useCheckDesktopRestriction,
  useDesktopAllowedModels,
} from "@/react-app/domains/cloud/desktop-config-provider";
import { useCloudProviderAutoSync } from "@/react-app/domains/cloud/use-cloud-provider-auto-sync";
import { useReloadCoordinator } from "@/react-app/shell/reload-coordinator";
import { type RouteWorkspace, workspaceLabel } from "@/react-app/shell/route-workspaces";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "./store";
import { isCloudProviderSyncReady } from "./cloud-provider-readiness";

const emptyWorkspaceDisplay: WorkspaceDisplay = {
  id: "",
  name: "",
  path: "",
  preset: "default",
  workspaceType: "local",
};

export type UseSessionProviderAuthInput = {
  opencodeClient: Client | null;
  opencodeBaseUrl: string;
  providers: ProviderListItem[];
  providerDefaults: Record<string, string>;
  providerConnectedIds: string[];
  disabledProviderIds: string[];
  selectedWorkspace: RouteWorkspace | null | undefined;
  selectedWorkspaceEndpoint: ResolvedWorkspaceEndpoint | null;
  selectedWorkspaceRoot: string;
  selectedWorkspaceId: string;
  /** Changes after sign-in, sign-out, or organization settings updates. */
  cloudSessionVersion: number;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setDisabledProviderIds: (value: string[]) => void;
};

export function useSessionProviderAuth(input: UseSessionProviderAuthInput) {
  const {
    opencodeClient,
    opencodeBaseUrl,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
    selectedWorkspaceId,
    cloudSessionVersion,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setDisabledProviderIds,
  } = input;
  const checkDesktopRestriction = useCheckDesktopRestriction();
  // Read through a ref: the catalog arrives after the desktop-config fetch
  // resolves, and recreating the store would trigger a spurious cloud sync.
  const allowedModels = useDesktopAllowedModels();
  const allowedModelsRef = useRef(allowedModels);
  allowedModelsRef.current = allowedModels;
  const reloadCoordinator = useReloadCoordinator();
  const { markReloadRequired } = reloadCoordinator;
  const onboardingProviderAuthPendingRef = useRef(false);

  const stateRef = useRef({
    opencodeClient,
    opencodeBaseUrl,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
  });
  stateRef.current = {
    opencodeClient,
    opencodeBaseUrl,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
  };

  // Depend on the stable callback, not the coordinator object: the context
  // value identity changes on every reload flip, and recreating this store
  // triggers a spurious cloud provider sync pass that amplified the
  // dispose/create loop.
  const store = useMemo(
    () =>
      createProviderAuthStore({
        client: () => stateRef.current.opencodeClient,
        providers: () => stateRef.current.providers,
        providerDefaults: () => stateRef.current.providerDefaults,
        providerConnectedIds: () => stateRef.current.providerConnectedIds,
        disabledProviders: () => stateRef.current.disabledProviderIds,
        checkDesktopAppRestriction: checkDesktopRestriction,
        desktopAllowedModels: () => allowedModelsRef.current,
        providerBaseUrl: () => stateRef.current.opencodeBaseUrl,
        selectedWorkspaceDisplay: () =>
          stateRef.current.selectedWorkspace
            ? ({
                ...stateRef.current.selectedWorkspace,
                name: workspaceLabel(stateRef.current.selectedWorkspace),
              } as WorkspaceDisplay)
            : emptyWorkspaceDisplay,
        selectedWorkspaceRoot: () => stateRef.current.selectedWorkspaceRoot,
        runtimeWorkspaceId: () => stateRef.current.selectedWorkspaceEndpoint?.workspaceId ?? null,
        juggleworkServer: {
          getSnapshot: () => ({
            juggleworkServerStatus: stateRef.current.selectedWorkspaceEndpoint ? "connected" : "disconnected",
            juggleworkServerClient: stateRef.current.selectedWorkspaceEndpoint?.client ?? null,
            juggleworkServerCapabilities: stateRef.current.selectedWorkspaceEndpoint
              ? {
                  config: { read: true, write: true },
                }
              : null,
          }),
        },
        setProviders,
        setProviderDefaults,
        setProviderConnectedIds,
        setDisabledProviders: setDisabledProviderIds,
        markOpencodeConfigReloadRequired: () => {
          markReloadRequired("config", {
            type: "config",
            name: "opencode.json",
            action: "updated",
          });
        },
      }),
    [checkDesktopRestriction, markReloadRequired],
  );
  const cloudProviderSyncContext = useMemo(() => ({
    client: opencodeClient,
    workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
    workspaceRoot: selectedWorkspaceRoot,
    cloudSessionVersion,
  }), [cloudSessionVersion, opencodeClient, selectedWorkspaceEndpoint?.workspaceId, selectedWorkspaceRoot]);
  const cloudProviderReadinessAttemptRef = useRef<{
    context: typeof cloudProviderSyncContext;
    count: number;
  }>({ context: cloudProviderSyncContext, count: 0 });
  const cloudProviderReadinessRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cloudProviderSyncContextRef = useRef(cloudProviderSyncContext);
  cloudProviderSyncContextRef.current = cloudProviderSyncContext;
  const [completedCloudProviderSync, setCompletedCloudProviderSync] = useState<{
    context: typeof cloudProviderSyncContext;
    providerList: ProviderListResponse | null;
  } | null>(null);

  useEffect(() => {
    store.start();
    return () => {
      store.dispose();
    };
  }, [store]);

  useEffect(() => {
    if (!opencodeClient || !selectedWorkspaceId) return;
    // Org policy may force Zen off. Never force it back on — that races user Disconnect.
    if (!checkDesktopRestriction({ restriction: "allowZenModel" })) return;

    void store
      .ensureProjectProviderDisabledState("opencode", true)
      .catch((error) => {
        console.warn("[desktop-app-restrictions] failed to sync Zen restriction", error);
      });
  }, [checkDesktopRestriction, opencodeClient, selectedWorkspaceId, selectedWorkspaceRoot, store]);

  useEffect(() => {
    store.syncFromOptions();
  }, [
    opencodeClient,
    selectedWorkspace?.id,
    selectedWorkspace?.workspaceType,
    selectedWorkspaceEndpoint?.workspaceId,
    selectedWorkspaceRoot,
    store,
  ]);

  const refreshCloudProviderReadiness = useCallback(async (
    reason: "app_launch" | "model_picker_open" = "model_picker_open",
  ) => {
    if (!cloudProviderSyncContext.client || !cloudProviderSyncContext.workspaceId) return null;
    const context = cloudProviderSyncContext;
    if (reason === "model_picker_open") {
      // Explicit user refresh starts a fresh bounded retry budget.
      cloudProviderReadinessAttemptRef.current = { context, count: 0 };
      if (cloudProviderReadinessRetryRef.current) {
        clearTimeout(cloudProviderReadinessRetryRef.current);
        cloudProviderReadinessRetryRef.current = null;
      }
    } else if (cloudProviderReadinessAttemptRef.current.context !== context) {
      cloudProviderReadinessAttemptRef.current = { context, count: 0 };
    }
    const attempt = ++cloudProviderReadinessAttemptRef.current.count;
    let providerList: ProviderListResponse | null = null;
    try {
      const syncSucceeded = await store.runCloudProviderSyncForReadiness(reason);
      if (syncSucceeded) {
        providerList = await store.refreshProviders({ force: true });
      }
    } catch (error) {
      console.warn(`[cloud-provider-readiness] ${reason} refresh failed`, error);
    }
    setCompletedCloudProviderSync((current) => {
      // A newer workspace/session refresh owns readiness now. Ignore this
      // stale result instead of making the wrong context sendable.
      if (
        cloudProviderSyncContextRef.current !== context ||
        cloudProviderReadinessAttemptRef.current.context !== context ||
        cloudProviderReadinessAttemptRef.current.count !== attempt
      ) return current;
      return { context, providerList };
    });
    if (
      !providerList &&
      cloudProviderSyncContextRef.current === context &&
      attempt < 3
    ) {
      if (cloudProviderReadinessRetryRef.current) clearTimeout(cloudProviderReadinessRetryRef.current);
      cloudProviderReadinessRetryRef.current = setTimeout(() => {
        cloudProviderReadinessRetryRef.current = null;
        void refreshCloudProviderReadiness("app_launch");
      }, 2_000);
    }
    return providerList;
  }, [cloudProviderSyncContext, store]);

  useEffect(() => {
    if (!cloudProviderSyncContext.client || !cloudProviderSyncContext.workspaceId) return;
    if (cloudProviderReadinessRetryRef.current) {
      clearTimeout(cloudProviderReadinessRetryRef.current);
      cloudProviderReadinessRetryRef.current = null;
    }
    void refreshCloudProviderReadiness("app_launch");
  }, [cloudProviderSyncContext, refreshCloudProviderReadiness]);

  useEffect(() => () => {
    if (cloudProviderReadinessRetryRef.current) clearTimeout(cloudProviderReadinessRetryRef.current);
  }, []);

  // After onboarding, auto-open the provider modal if no providers are connected.
  // The welcome route appends ?onboarding=1 to the session URL after workspace creation.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("onboarding=1")) return;
    // Strip the param so it doesn't re-trigger.
    window.location.hash = hash.replace(/[?&]onboarding=1/, "");
    onboardingProviderAuthPendingRef.current = true;
  }, []);

  useEffect(() => {
    if (!onboardingProviderAuthPendingRef.current) return;
    if (!selectedWorkspaceEndpoint) return;
    onboardingProviderAuthPendingRef.current = false;
    store.openProviderAuthModal({ returnFocusTarget: "composer" });
  }, [selectedWorkspaceEndpoint, store]);

  // Session is where forced sign-in lands. Keep org-managed cloud providers in
  // sync here so sign-in applies opencode.json changes before Settings opens.
  useCloudProviderAutoSync(store.runCloudProviderSync);
  const snapshot = useProviderAuthStoreSnapshot(store);
  const currentCloudProviderSync =
    completedCloudProviderSync?.context === cloudProviderSyncContext
      ? completedCloudProviderSync
      : null;
  // A completed attempt is not readiness when the authoritative provider list
  // failed to load. Keep managed models gated until sync actually succeeds.
  const cloudProviderSyncReady = isCloudProviderSyncReady(currentCloudProviderSync?.providerList ?? null);

  return {
    store,
    snapshot,
    cloudProviderSyncReady,
    cloudProviderList: currentCloudProviderSync?.providerList ?? null,
    refreshCloudProviderReadiness,
  };
}
