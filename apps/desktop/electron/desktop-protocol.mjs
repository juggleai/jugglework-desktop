// Decides which custom URL scheme this Electron process should claim with the OS.
//
// Packaged releases own `jugglework://`. Source dev builds must never claim it,
// otherwise browser sign-in callbacks get routed away from (or into) an installed
// release. A dev build may instead claim an isolated scheme such as
// `jugglework-dev://` via JUGGLEWORK_DESKTOP_AUTH_SCHEME.

export const RELEASE_PROTOCOL_SCHEME = "jugglework";
const DEV_SCHEME_PATTERN = /^jugglework(?:-[a-z0-9]+)+$/;

/**
 * @param {{ isPackaged: boolean, env: Record<string, string | undefined> }} input
 * @returns {{ scheme: string } | null}
 */
export function resolveDesktopProtocolRegistration({ isPackaged, env }) {
  if (isPackaged) {
    return env.JUGGLEWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION === "1"
      ? null
      : { scheme: RELEASE_PROTOCOL_SCHEME };
  }
  const devScheme = env.JUGGLEWORK_DESKTOP_AUTH_SCHEME?.trim() ?? "";
  return DEV_SCHEME_PATTERN.test(devScheme) ? { scheme: devScheme } : null;
}
