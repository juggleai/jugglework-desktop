import type { DesktopPolicyKey } from "@jugglework/types/den/desktop-policies";
import type { DenDesktopConfig } from "../lib/den";
import type { ModelRef } from "../types";

export type DesktopAppRestrictionKey = DesktopPolicyKey;

export type DesktopAppRestrictionChecker = (input: {
  restriction: DesktopAppRestrictionKey;
}) => boolean;

export const DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID = "opencode";

/** The built-in cloud provider. Arrives with the account, never hand-connected. */
const JUGGLEWORK_CLOUD_PROVIDER_ID = "jugglework";

/**
 * Providers the desktop never offers as a manual connection.
 *
 * - `jugglework`: pushed down by the cloud with the account, so there is
 *   nothing for the user to connect.
 * - `opencode` (OpenCode Zen): the desktop does not offer it. Distinct from the
 *   `allowZenModel` policy, which an org uses to block Zen where it would
 *   otherwise be available — this is the product-level decision not to present
 *   it at all, so it holds regardless of org policy.
 *
 * Applies to the connect UI only. It does not disable an already-configured
 * provider; `runDesktopAppRestrictionSyncEffects` owns that.
 */
export function isProviderHiddenFromConnectUi(providerId: string): boolean {
  const resolved = providerId.trim().toLowerCase();
  return (
    resolved === JUGGLEWORK_CLOUD_PROVIDER_ID ||
    resolved === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID
  );
}

/**
 * Where the engine says a provider came from, as reported by the provider list
 * endpoint. `config` means the user declared it themselves in an OpenCode
 * config file (`~/.config/opencode/opencode.json`, a project `opencode.json`,
 * or the app's runtime config).
 */
export type DesktopProviderSource = "env" | "api" | "config" | "custom";

/**
 * Providers the user wrote into an OpenCode config file hold the user's own
 * credentials, so a cloud deployment's catalog can never list them. They are
 * governed by the `allowCustomProviders` policy instead of `allowedModels`.
 */
function isLocallyConfiguredProviderSource(source: DesktopProviderSource | undefined) {
  return source === "config";
}

/**
 * `<providerId>/<modelId>` entries the connected cloud supports, from the
 * `allowedModels` desktop policy. A private cloud serves the catalog it can
 * actually configure providers for, which is narrower than the public
 * models.dev list the engine reports. An empty list means "not restricted" —
 * a deployment that sends nothing must not lock every model out.
 */
export function readDesktopAllowedModels(
  config: DenDesktopConfig | null | undefined,
): readonly string[] {
  return config?.allowedModels ?? [];
}

/**
 * Mirrors `isCloudManagedProviderKey` in
 * `react-app/domains/connections/provider-auth/cloud-provider-config.ts`
 * (duplicated because this module sits below `react-app/`). Org-managed
 * providers are pushed down by the cloud itself, so the catalog allowlist must
 * never hide them — an admin can publish a provider that the catalog does not
 * list, and it stays legitimate.
 */
function isCloudManagedProviderId(providerId: string) {
  return /^lpr_/i.test(providerId) || providerId === "jugglework";
}

function isAllowedByModelCatalog(input: {
  allowedModels: readonly string[] | undefined;
  providerId: string;
  modelId?: string;
  providerSource?: DesktopProviderSource;
}) {
  const allowedModels = input.allowedModels;
  if (!allowedModels || allowedModels.length === 0) return true;

  const providerId = input.providerId.trim();
  if (!providerId) return true;
  if (isCloudManagedProviderId(providerId)) return true;
  if (isLocallyConfiguredProviderSource(input.providerSource)) return true;

  const modelId = input.modelId?.trim();
  if (modelId) return allowedModels.includes(`${providerId}/${modelId}`);

  const prefix = `${providerId}/`;
  return allowedModels.some((entry) => entry.startsWith(prefix));
}

export function checkDesktopAppRestriction(input: {
  config: DenDesktopConfig | null | undefined;
  restriction: DesktopAppRestrictionKey;
}) {
  return input.config?.[input.restriction] === false;
}

export function isDesktopProviderBlocked(input: {
  providerId: string;
  checkRestriction: DesktopAppRestrictionChecker;
  allowedModels?: readonly string[];
  /**
   * Engine-reported provider source. Pass it whenever it is known — without it
   * a locally configured provider is judged against the cloud catalog, which
   * can never list it.
   */
  providerSource?: DesktopProviderSource;
}) {
  const providerId = input.providerId.trim().toLowerCase();
  if (!providerId) return false;

  if (providerId === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID) {
    if (input.checkRestriction({ restriction: "allowZenModel" })) return true;
  }

  // A provider the user configured locally is exactly what `allowCustomProviders`
  // governs, so gate it on that policy rather than on the catalog allowlist.
  // Org-published providers stay exempt — an admin can push one down that the
  // catalog does not list.
  if (
    isLocallyConfiguredProviderSource(input.providerSource) &&
    !isCloudManagedProviderId(input.providerId.trim())
  ) {
    return input.checkRestriction({ restriction: "allowCustomProviders" });
  }

  return !isAllowedByModelCatalog({
    allowedModels: input.allowedModels,
    providerId: input.providerId,
    providerSource: input.providerSource,
  });
}

export function isDesktopModelBlocked(input: {
  model: ModelRef;
  checkRestriction: DesktopAppRestrictionChecker;
  allowedModels?: readonly string[];
  /** @see isDesktopProviderBlocked */
  providerSource?: DesktopProviderSource;
}) {
  if (
    isDesktopProviderBlocked({
      providerId: input.model.providerID,
      checkRestriction: input.checkRestriction,
      allowedModels: input.allowedModels,
      providerSource: input.providerSource,
    })
  ) {
    return true;
  }

  return !isAllowedByModelCatalog({
    allowedModels: input.allowedModels,
    providerId: input.model.providerID,
    modelId: input.model.modelID,
    providerSource: input.providerSource,
  });
}

type DesktopAppRestrictionSyncContext = {
  checkRestriction: DesktopAppRestrictionChecker;
  reconcileRestrictedModels?: () => void;
  ensureProjectProviderDisabledState?: (providerId: string, disabled: boolean) => Promise<unknown>;
  onError?: (error: Error, details: {
    restriction: DesktopAppRestrictionKey;
    action: string;
    providerId?: string;
  }) => void;
};

export async function runDesktopAppRestrictionSyncEffects(
  input: DesktopAppRestrictionSyncContext,
) {
  // Only force-disable OpenCode Zen when org policy blocks it. When Zen is
  // allowed, do not force-enable — that would undo a user Disconnect that
  // wrote `opencode` into runtime disabled_providers.
  const shouldDisableOpencodeProvider = input.checkRestriction({ restriction: "allowZenModel" });

  input.reconcileRestrictedModels?.();

  if (shouldDisableOpencodeProvider && input.ensureProjectProviderDisabledState) {
    try {
      await input.ensureProjectProviderDisabledState(
        DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID,
        true,
      );
    } catch (error) {
      input.onError?.(
        error instanceof Error ? error : new Error(String(error ?? "Desktop restriction effect failed.")),
        {
          restriction: "allowZenModel",
          action: "ensureProjectProviderDisabledState",
          providerId: DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID,
        },
      );
    }
  }
}
