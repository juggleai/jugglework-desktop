import type { DenSettings, DenUser } from "./den-types";

export const denSessionUpdatedEvent = "jugglework-den-session-updated";
export const denSettingsChangedEvent = "jugglework-den-settings-changed";
export const denSessionRevokedEvent = "jugglework-den-session-revoked";

export type DenCredentialAuthorityChangeReason =
  | "session_established"
  | "account_switched"
  | "organization_switched"
  | "signed_out";

export type DenSessionUpdatedDetail = {
  status?: "success" | "error" | "signed_out" | "authority_changed";
  /** Non-secret generation for deduplicating credential-authority cleanup. */
  authEpoch?: number;
  reason?: DenCredentialAuthorityChangeReason;
  baseUrl?: string | null;
  user?: DenUser | null;
  email?: string | null;
  message?: string | null;
};

let credentialAuthorityEpoch = Date.now();

export function createDenCredentialAuthorityChange(
  reason: DenCredentialAuthorityChangeReason,
): Pick<DenSessionUpdatedDetail, "authEpoch" | "reason"> {
  credentialAuthorityEpoch += 1;
  return { authEpoch: credentialAuthorityEpoch, reason };
}

export function dispatchDenSessionUpdated(detail: DenSessionUpdatedDetail) {
  if (typeof window === "undefined") {
    return;
  }

  const normalizedDetail = detail.reason && detail.authEpoch
    ? detail
    : detail.status === "signed_out"
      ? { ...detail, ...createDenCredentialAuthorityChange("signed_out") }
      : detail;

  window.dispatchEvent(
    new CustomEvent<DenSessionUpdatedDetail>(denSessionUpdatedEvent, {
      detail: normalizedDetail,
    }),
  );
}

export type DenSessionRevokedDetail = {
  /** Non-secret fingerprint used to ignore a late 401 from an older session. */
  authFingerprint: string;
  status: 401;
  code: string;
  message: string;
};

export function dispatchDenSessionRevoked(detail: DenSessionRevokedDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DenSessionRevokedDetail>(denSessionRevokedEvent, {
      detail,
    }),
  );
}

export type DenSettingsChangedDetail = {
  settings: DenSettings;
};

export function dispatchDenSettingsChanged(detail: DenSettingsChangedDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DenSettingsChangedDetail>(denSettingsChangedEvent, {
      detail,
    }),
  );
}
