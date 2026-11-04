import { DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID, type DesktopAppRestrictionChecker, type DesktopAppRestrictionKey } from "@jugglework/types/den/desktop-policies";
export {
  DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID, isProviderHiddenFromConnectUi, readDesktopAllowedModels,
  checkDesktopAppRestriction, isDesktopProviderBlocked, isDesktopModelBlocked,
  type DesktopAppRestrictionKey, type DesktopAppRestrictionChecker, type DesktopProviderSource,
} from "@jugglework/types/den/desktop-policies";

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
