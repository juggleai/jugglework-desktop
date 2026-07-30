import { INFERENCE_MODEL_ALIASES } from "@jugglework/types/den/inference";

import {
  buildDenAuthUrl,
  getDenInferenceUrl,
  HOSTED_DEFAULT_DEN_BASE_URL,
  readDenBootstrapConfig,
  readDenSettings,
} from "../../../app/lib/den";
import { isDefaultControlPlaneUrl } from "../settings/cloud/control-plane-url";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useSyncExternalStore } from "react";

export const JUGGLEWORK_MODELS_PROVIDER_ID = "jugglework";
export const JUGGLEWORK_MODELS_PROVIDER_NAME = "JuggleWork Models";
export const JUGGLEWORK_MODELS_PROMO_HIDDEN_KEY = "jugglework.juggleworkModelsPromo.hidden";
export const JUGGLEWORK_MODELS_PROMO_LAST_SHOWN_KEY = "jugglework.juggleworkModelsPromo.lastShownAt";
export const JUGGLEWORK_MODELS_STARTUP_PROMO_SHOWN_KEY = "jugglework.juggleworkModelsPromo.startupShown";
export const juggleWorkModelsPromoChangedEvent = "jugglework-jugglework-models-promo-changed";
export const JUGGLEWORK_MODELS_PROMO_SHOW_DELAY_MS = 4_000;
export const JUGGLEWORK_MODELS_PROMO_VISIBLE_MS = 14_000;
export const JUGGLEWORK_MODELS_PROMO_REPEAT_MS = 6 * 60 * 60 * 1000;

export function areJuggleWorkModelsPromosDisabled() {
  // JuggleWork Models is not part of the desktop distribution. All model
  // providers must be configured locally or supplied by the organization.
  return true;
}

export function isJuggleWorkModelsPromoEligibleForDenBaseUrl(baseUrl: string) {
  return !areJuggleWorkModelsPromosDisabled() && isDefaultControlPlaneUrl(baseUrl, HOSTED_DEFAULT_DEN_BASE_URL);
}

export function isJuggleWorkModelsPromoEligible() {
  return isJuggleWorkModelsPromoEligibleForDenBaseUrl(readDenSettings().baseUrl);
}

export function useJuggleWorkModelsPromoEligibility() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener(denSettingsChangedEvent, notify);
      return () => window.removeEventListener(denSettingsChangedEvent, notify);
    },
    isJuggleWorkModelsPromoEligible,
    isJuggleWorkModelsPromoEligible,
  );
}

export type JuggleWorkModelPreview = {
  id: string;
  title: string;
  subtitle: string;
};

export const JUGGLEWORK_MODEL_PREVIEWS: JuggleWorkModelPreview[] = Object.entries(
  INFERENCE_MODEL_ALIASES,
)
  .filter(([, model]) => model.enabled)
  .map(([id, model]) => ({
    id,
    title: model.displayName.replace(/^JuggleWork:\s*/, ""),
    subtitle: "JuggleWork hosted",
  }));

export function hasJuggleWorkModelsProvider(providerIds: readonly string[]) {
  return providerIds.some((id) => id.trim().toLowerCase() === JUGGLEWORK_MODELS_PROVIDER_ID);
}

/** Local engine has JuggleWork Models connected with at least one selectable model. */
export function hasJuggleWorkModelsAvailable(input: {
  providerConnectedIds: readonly string[];
  providers: ReadonlyArray<{ id: string; models?: Record<string, unknown> | null }>;
}) {
  if (!hasJuggleWorkModelsProvider(input.providerConnectedIds)) return false;
  const jugglework = input.providers.find(
    (provider) => provider.id.trim().toLowerCase() === JUGGLEWORK_MODELS_PROVIDER_ID,
  );
  return Object.keys(jugglework?.models ?? {}).length > 0;
}

export function getJuggleWorkModelsActionUrl(
  isSignedIn: boolean,
  authMode: "sign-in" | "sign-up" = "sign-in",
) {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl || readDenBootstrapConfig().baseUrl;
  // Signed-in users go straight to the JuggleWork Models page — the value-prop
  // + subscribe surface — never to a bare auth or billing page.
  return isSignedIn ? getDenInferenceUrl(baseUrl) : buildDenAuthUrl(baseUrl, authMode);
}

export function isJuggleWorkModelsPromoHidden() {
  if (areJuggleWorkModelsPromosDisabled()) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(JUGGLEWORK_MODELS_PROMO_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function hideJuggleWorkModelsPromo() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(JUGGLEWORK_MODELS_PROMO_HIDDEN_KEY, "1");
    window.dispatchEvent(new Event(juggleWorkModelsPromoChangedEvent));
  } catch {}
}

export function wasJuggleWorkModelsStartupPromoShown() {
  if (!isJuggleWorkModelsPromoEligible()) return true;
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(JUGGLEWORK_MODELS_STARTUP_PROMO_SHOWN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markJuggleWorkModelsStartupPromoShown() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(JUGGLEWORK_MODELS_STARTUP_PROMO_SHOWN_KEY, "1");
  } catch {}
}

export function shouldShowJuggleWorkModelsPromo(now = Date.now()) {
  if (!isJuggleWorkModelsPromoEligible() || typeof window === "undefined" || isJuggleWorkModelsPromoHidden()) return false;
  try {
    const lastShown = Number(window.localStorage.getItem(JUGGLEWORK_MODELS_PROMO_LAST_SHOWN_KEY) ?? "0");
    return !Number.isFinite(lastShown) || now - lastShown >= JUGGLEWORK_MODELS_PROMO_REPEAT_MS;
  } catch {
    return true;
  }
}

export function markJuggleWorkModelsPromoShown(now = Date.now()) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(JUGGLEWORK_MODELS_PROMO_LAST_SHOWN_KEY, String(now));
  } catch {}
}
