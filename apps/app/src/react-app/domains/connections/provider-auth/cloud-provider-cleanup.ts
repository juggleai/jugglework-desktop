export type CloudCleanupFailure = {
  stage: string;
  status?: number;
  code?: string;
};

export class CloudCleanupError extends Error {
  constructor(message: string, readonly failures: readonly CloudCleanupFailure[]) {
    super(message);
  }
}

const SAFE_CLEANUP_CODES = new Set([
  "approval_required", "cloud_provider_mirror_unowned", "env_not_found", "forbidden",
  "internal_error", "mcp_config_changed", "mcp_not_found", "not_found", "opencode_request_failed",
  "opencode_runtime_config_refresh_failed", "read_only", "route_not_found", "unauthorized",
  "workspace_not_found",
]);

export function describeCloudCleanupFailure(stage: string, error: unknown): CloudCleanupFailure[] {
  if (error instanceof CloudCleanupError) return [...error.failures];
  const { status, code, name, message } = (error ?? {}) as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
  return [{
    stage,
    ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
    // Never log error messages, bodies, headers, URLs, or arbitrary SDK strings.
    ...(typeof code === "string" && SAFE_CLEANUP_CODES.has(code) ? { code }
      : name === "AbortError" || name === "TimeoutError" || message === "Request timed out." ? { code: "transport_timeout_or_abort" }
      : name === "TypeError" ? { code: "transport_or_type_error" } : {}),
  }];
}

export type CloudProviderCleanupSteps = {
  mirror: () => Promise<void>;
  auth: () => Promise<void>;
  runtime: () => Promise<void>;
};

export async function cleanupCloudProviderIndependently(steps: CloudProviderCleanupSteps): Promise<void> {
  const results = await Promise.allSettled([steps.mirror, steps.auth, steps.runtime].map((step) => Promise.resolve().then(step)));
  const names = ["mirror", "auth", "runtime"];
  const failed = results.flatMap((result, index) => result.status === "rejected" ? [names[index]!] : []);
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? describeCloudCleanupFailure(`provider_${names[index]}`, result.reason) : []);
  if (failed.length) throw new CloudCleanupError(`cloud_provider_cleanup_incomplete:${failed.join(",")}`, failures);
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
        describeCloudCleanupFailure("organization_cleanup", error),
      );
    }
  }
}
