import type { DenIMLoginBootstrap, DenSettings, DenUser } from "./den-types";

export const denSessionUpdatedEvent = "jugglework-den-session-updated";
export const denSettingsChangedEvent = "jugglework-den-settings-changed";
export const denSessionRevokedEvent = "jugglework-den-session-revoked";

export type DenSessionUpdatedDetail = {
  status?: "success" | "error" | "signed_out";
  baseUrl?: string | null;
  token?: string | null;
  user?: DenUser | null;
  im?: DenIMLoginBootstrap | null;
  email?: string | null;
  message?: string | null;
};

export function dispatchDenSessionUpdated(detail: DenSessionUpdatedDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DenSessionUpdatedDetail>(denSessionUpdatedEvent, {
      detail,
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
