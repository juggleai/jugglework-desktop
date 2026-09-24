import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

type ManagedModelRef = {
  providerID: string;
  modelID: string;
};

/** A failed/empty refresh attempt must not make managed providers sendable. */
export function isCloudProviderSyncReady(providerList: ProviderListResponse | null): boolean {
  return providerList !== null;
}

/**
 * A background Cloud reconciliation is not the only authoritative proof that
 * a managed model is usable. The target workspace's own `/provider` response
 * already proves that the engine loaded the provider, connected it, and
 * exposes the selected model. This fallback prevents a transient config-sync
 * startup failure from permanently disabling an otherwise sendable composer.
 */
export function isManagedModelSubmissionReady(input: {
  cloudProviderSyncReady: boolean;
  providerList: ProviderListResponse | null | undefined;
  model: ManagedModelRef | null;
}): boolean {
  if (!input.model) return true;
  if (input.cloudProviderSyncReady) return true;
  const providerId = input.model.providerID.trim();
  const modelId = input.model.modelID.trim();
  if (!providerId || !modelId) return false;
  if (!input.providerList?.connected?.some((id) => id.trim() === providerId)) return false;
  const provider = input.providerList.all?.find((item) => item.id.trim() === providerId);
  return Boolean(provider?.models?.[modelId]);
}
