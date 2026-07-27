import type { DesktopPolicyKey } from "@openwork/types/den/desktop-policies";
import type { DenDesktopConfig } from "../lib/den";
import type { ModelRef } from "../types";

export type DesktopAppRestrictionKey = DesktopPolicyKey;

export type DesktopAppRestrictionChecker = (input: {
  restriction: DesktopAppRestrictionKey;
}) => boolean;

export const DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID = "opencode";

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
  return /^lpr_/i.test(providerId) || providerId === "openwork";
}

function isAllowedByModelCatalog(input: {
  allowedModels: readonly string[] | undefined;
  providerId: string;
  modelId?: string;
}) {
  const allowedModels = input.allowedModels;
  if (!allowedModels || allowedModels.length === 0) return true;

  const providerId = input.providerId.trim();
  if (!providerId) return true;
  if (isCloudManagedProviderId(providerId)) return true;

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
}) {
  const providerId = input.providerId.trim().toLowerCase();
  if (!providerId) return false;

  if (providerId === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID) {
    if (input.checkRestriction({ restriction: "allowZenModel" })) return true;
  }

  return !isAllowedByModelCatalog({
    allowedModels: input.allowedModels,
    providerId: input.providerId,
  });
}

export function isDesktopModelBlocked(input: {
  model: ModelRef;
  checkRestriction: DesktopAppRestrictionChecker;
  allowedModels?: readonly string[];
}) {
  if (
    isDesktopProviderBlocked({
      providerId: input.model.providerID,
      checkRestriction: input.checkRestriction,
      allowedModels: input.allowedModels,
    })
  ) {
    return true;
  }

  return !isAllowedByModelCatalog({
    allowedModels: input.allowedModels,
    providerId: input.model.providerID,
    modelId: input.model.modelID,
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
