// "JuggleWork Models" startup promo: one-shot dialog latch shown shortly after
// a workspace is ready when the user has no JuggleWork Models provider yet.
// Extracted verbatim from session-route.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { usePlatform } from "@/react-app/kernel/platform";
import { useShellConfig } from "@/react-app/shell/shell-config";
import { workspaceSettingsRoute } from "@/react-app/shell/workspace-routes";
import {
  getJuggleWorkModelsActionUrl,
  hasJuggleWorkModelsProvider,
  hideJuggleWorkModelsPromo,
  useJuggleWorkModelsPromoEligibility,
  isJuggleWorkModelsPromoHidden,
  markJuggleWorkModelsStartupPromoShown,
  juggleWorkModelsPromoChangedEvent,
  wasJuggleWorkModelsStartupPromoShown,
} from "./jugglework-models-promo";

export type UseJuggleWorkModelsStartupPromoInput = {
  /** True once the workspace's opencode client exists. */
  clientReady: boolean;
  workspaceId: string;
  providerConnectedIds: string[];
  /** Org member already has JuggleWork Models on Den — never upsell Subscribe. */
  juggleWorkModelsEntitled?: boolean;
};

export function useJuggleWorkModelsStartupPromo(input: UseJuggleWorkModelsStartupPromoInput) {
  const { clientReady, workspaceId, providerConnectedIds, juggleWorkModelsEntitled = false } = input;
  const navigate = useNavigate();
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const { config: shellConfig } = useShellConfig();
  const juggleWorkModelsPromoEligible = useJuggleWorkModelsPromoEligibility();

  const [open, setOpen] = useState(false);
  const [promoHidden, setPromoHidden] = useState(isJuggleWorkModelsPromoHidden);
  const scheduledRef = useRef(false);

  useEffect(() => {
    const handlePromoChanged = () => setPromoHidden(isJuggleWorkModelsPromoHidden());
    window.addEventListener(juggleWorkModelsPromoChangedEvent, handlePromoChanged);
    return () => window.removeEventListener(juggleWorkModelsPromoChangedEvent, handlePromoChanged);
  }, []);

  const hasJuggleWorkModels = useMemo(
    () => hasJuggleWorkModelsProvider(providerConnectedIds),
    [providerConnectedIds],
  );

  useEffect(() => {
    if (!juggleWorkModelsPromoEligible) {
      setOpen(false);
      return;
    }
    if (!shellConfig.cloudSignin || promoHidden || hasJuggleWorkModels || juggleWorkModelsEntitled) return;
    if (denAuth.status === "checking" || !clientReady || !workspaceId) return;
    if (wasJuggleWorkModelsStartupPromoShown() || scheduledRef.current) return;

    scheduledRef.current = true;
    const timeout = window.setTimeout(() => {
      markJuggleWorkModelsStartupPromoShown();
      setOpen(true);
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [clientReady, denAuth.status, hasJuggleWorkModels, juggleWorkModelsEntitled, juggleWorkModelsPromoEligible, promoHidden, shellConfig.cloudSignin, workspaceId]);

  const subscribe = useCallback(() => {
    setOpen(false);
    markJuggleWorkModelsStartupPromoShown();
    if (!denAuth.isSignedIn) {
      navigate(workspaceId ? workspaceSettingsRoute(workspaceId, "cloud-account") : "/settings/cloud-account");
    }
    window.setTimeout(() => {
      platform.openLink(getJuggleWorkModelsActionUrl(denAuth.isSignedIn));
    }, 0);
  }, [denAuth.isSignedIn, navigate, platform, workspaceId]);

  const continueWithout = useCallback(() => {
    setOpen(false);
    markJuggleWorkModelsStartupPromoShown();
    hideJuggleWorkModelsPromo();
    setPromoHidden(true);
  }, []);

  return { open, subscribe, continueWithout };
}
