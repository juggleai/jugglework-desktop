export type CloudProviderCleanupSteps = {
  mirror: () => Promise<void>;
  auth: () => Promise<void>;
  runtime: () => Promise<void>;
};

export async function cleanupCloudProviderIndependently(steps: CloudProviderCleanupSteps): Promise<void> {
  const results = await Promise.allSettled([steps.mirror(), steps.auth(), steps.runtime()]);
  const names = ["mirror", "auth", "runtime"];
  const failed = results.flatMap((result, index) => result.status === "rejected" ? [names[index]!] : []);
  if (failed.length) throw new Error(`cloud_provider_cleanup_incomplete:${failed.join(",")}`);
}

type OrganizationCloudCleanup = () => Promise<void>;
const organizationCloudCleanupHandlers = new Set<OrganizationCloudCleanup>();

export function registerOrganizationCloudCleanup(
  handler: OrganizationCloudCleanup,
): () => void {
  organizationCloudCleanupHandlers.add(handler);
  return () => organizationCloudCleanupHandlers.delete(handler);
}

/**
 * Best-effort cleanup of providers imported from the active organization.
 *
 * Organization activation must not depend on local workspace/runtime health:
 * a disconnected engine or an unavailable workspace server may prevent an
 * imported cloud provider from being removed immediately, but it must never
 * trap the user in the previous organization. The provider sync for the newly
 * active organization will retry ownership cleanup before importing its
 * providers.
 */
export async function runOrganizationCloudCleanup(): Promise<void> {
  for (const handler of organizationCloudCleanupHandlers) {
    try {
      await handler();
    } catch (error) {
      console.warn(
        "[cloud-provider-sync:organization-switch] Cloud provider cleanup will be retried after switching organizations.",
        error,
      );
    }
  }
}
