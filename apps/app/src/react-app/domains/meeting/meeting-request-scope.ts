import { useSyncExternalStore } from "react";
import { denCredentialFingerprint, isPersonalDenOrganization, readDenSettings, readDenUserId } from "@/app/lib/den";
import { currentDenSessionClearGeneration, denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { useDenAuth } from "../cloud/den-auth-provider";

function requestScopeKey(organizationId: string, userId: string, baseUrl: string, token: string) {
  return JSON.stringify([organizationId, userId, baseUrl, denCredentialFingerprint(token), currentDenSessionClearGeneration()]);
}

function readMeetingRequestScope() {
  const { activeOrgId, baseUrl, authToken } = readDenSettings();
  const userId = readDenUserId();
  if (!activeOrgId || !userId || !baseUrl || !authToken?.trim()) return null;
  return requestScopeKey(activeOrgId, userId, baseUrl, authToken);
}

function subscribe(onChange: () => void) {
  window.addEventListener(denSettingsChangedEvent, onChange);
  window.addEventListener(denSessionUpdatedEvent, onChange);
  return () => {
    window.removeEventListener(denSettingsChangedEvent, onChange);
    window.removeEventListener(denSessionUpdatedEvent, onChange);
  };
}

export function useMeetingRequestScope() {
  const { isSignedIn, activeOrganization, user } = useDenAuth();
  const scope = useSyncExternalStore(subscribe, readMeetingRequestScope, () => null);
  if (!scope || !isSignedIn || !user?.id || activeOrganization?.kind !== "organization" || isPersonalDenOrganization(activeOrganization)) return null;
  // The account menu may show a fallback organization; only the confirmed
  // identity that will actually be sent on the request may enable polling.
  const settings = readDenSettings();
  return settings.activeOrgId === activeOrganization.id && readDenUserId() === user.id ? scope : null;
}

export function isMeetingRequestScopeCurrent(scope: string) {
  return scope === readMeetingRequestScope();
}
