import type { DenAuthStatus } from "../domains/cloud/den-auth-provider";

export type SigninGateInput = {
  status: DenAuthStatus;
  isSignedIn: boolean;
  /** `location.pathname`; case is normalized here. */
  path: string;
  /** True when an agent-first install prepared this desktop. */
  hasPreparedBootstrap: boolean;
};

export type SigninGateDecision = {
  /** Route to replace-navigate to, or null to stay where we are. */
  redirectTo: "/signin" | "/onboarding" | null;
  /**
   * - `pending`: first session check still in flight; render nothing so the
   *   boot overlay stays up instead of flashing the sign-in page.
   * - `signin`: the full-screen sign-in gate.
   * - `children`: the app routes.
   */
  render: "pending" | "signin" | "children";
};

/**
 * Decides what the sign-in gate shows and where it sends the user.
 *
 * Sign-in is mandatory: no app route renders without a Den session, and
 * signing out drops the session, which lands the user back on `/signin`. The
 * only surface an anonymous user may reach is a sign-in one — `/signin`, or
 * `/onboarding` on an agent-first install, where that route renders the
 * prepared-workspace claim card (claim link + one-time code).
 */
export function resolveSigninGateDecision(input: SigninGateInput): SigninGateDecision {
  const path = input.path.toLowerCase();
  const onSignin = path === "/signin" || path.startsWith("/signin/");
  const onOnboarding = path === "/onboarding" || path.startsWith("/onboarding/");
  const onSigninSurface = onSignin || (onOnboarding && input.hasPreparedBootstrap);

  // Wait for the first auth check so we don't bounce the user between
  // `/session` and `/signin` every navigation while we figure out if their
  // cached token is still valid.
  if (input.status === "checking") return { redirectTo: null, render: "pending" };

  if (!input.isSignedIn) {
    return {
      redirectTo: onSigninSurface ? null : "/signin",
      // The redirect only lands on the next commit, and one frame of the
      // transcript is one frame too many.
      render: onSigninSurface ? "children" : "signin",
    };
  }

  // Signed in — route off the sign-in page to onboarding so the user sees
  // their org resources.
  return { redirectTo: onSignin ? "/onboarding" : null, render: "children" };
}
