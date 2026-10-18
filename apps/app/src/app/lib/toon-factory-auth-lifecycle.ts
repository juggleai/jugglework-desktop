import { toonFactoryCloseAndClearGrants } from "./desktop";
import type { DenSessionUpdatedDetail } from "./den-session-events";
import { isDesktopRuntime } from "./runtime-env";

export function isDenCredentialAuthorityChange(
  detail: DenSessionUpdatedDetail | null | undefined,
): boolean {
  return detail?.reason === "account_switched"
    || detail?.reason === "organization_switched"
    || detail?.reason === "signed_out";
}

export function createToonFactoryDenSessionCloser(input: {
  isDesktop: () => boolean;
  close: () => Promise<unknown>;
  closeTimeoutMs?: number;
}) {
  let lastAuthEpoch: number | null = null;
  let lastClose: Promise<void> | null = null;

  return (detail: DenSessionUpdatedDetail | null | undefined): Promise<void> => {
    if (!input.isDesktop() || !isDenCredentialAuthorityChange(detail)) {
      return Promise.resolve();
    }

    const authEpoch = detail?.authEpoch ?? null;
    if (authEpoch !== null && authEpoch === lastAuthEpoch && lastClose) {
      return lastClose;
    }

    lastAuthEpoch = authEpoch;
    const closeAttempt = Promise.resolve().then(input.close).then(() => undefined, () => undefined);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    lastClose = Promise.race([
      closeAttempt,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, input.closeTimeoutMs ?? 2_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    return lastClose;
  };
}

export const closeToonFactoryForDenSession = createToonFactoryDenSessionCloser({
  isDesktop: isDesktopRuntime,
  close: toonFactoryCloseAndClearGrants,
});
