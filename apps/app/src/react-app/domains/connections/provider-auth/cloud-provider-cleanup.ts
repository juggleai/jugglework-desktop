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

type OrganizationCleanup = () => Promise<void>;
const organizationCleanupHandlers = new Set<OrganizationCleanup>();

export function registerOrganizationCleanup(handler: OrganizationCleanup): () => void {
  organizationCleanupHandlers.add(handler);
  return () => organizationCleanupHandlers.delete(handler);
}

export async function requireOrganizationCleanup(): Promise<void> {
  for (const handler of organizationCleanupHandlers) {
    try {
      await handler();
    } catch {
      throw new Error("Could not clean up the current organization's local provider state. Retry before switching organizations.");
    }
  }
}
