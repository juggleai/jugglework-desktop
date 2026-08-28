import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

/** A failed/empty refresh attempt must not make managed providers sendable. */
export function isCloudProviderSyncReady(providerList: ProviderListResponse | null): boolean {
  return providerList !== null;
}
