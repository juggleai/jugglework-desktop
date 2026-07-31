import { describe, expect, test } from "bun:test";

import { resolveSigninGateDecision } from "../src/react-app/shell/signin-gate";

const signedOut = {
  status: "signed_out" as const,
  isSignedIn: false,
  hasPreparedBootstrap: false,
};

const signedIn = {
  status: "signed_in" as const,
  isSignedIn: true,
  hasPreparedBootstrap: false,
};

describe("signed-out users", () => {
  test("are held at the sign-in page from any app route", () => {
    for (const path of ["/", "/session", "/session/abc", "/workspace/w1/settings/cloud", "/welcome"]) {
      expect(resolveSigninGateDecision({ ...signedOut, path })).toEqual({
        redirectTo: "/signin",
        render: "signin",
      });
    }
  });

  test("stay put once they are on the sign-in route", () => {
    expect(resolveSigninGateDecision({ ...signedOut, path: "/signin" })).toEqual({
      redirectTo: null,
      render: "children",
    });
  });

  test("cannot reach onboarding unless an agent-first install prepared it", () => {
    expect(resolveSigninGateDecision({ ...signedOut, path: "/onboarding" })).toEqual({
      redirectTo: "/signin",
      render: "signin",
    });
    expect(
      resolveSigninGateDecision({ ...signedOut, path: "/onboarding", hasPreparedBootstrap: true }),
    ).toEqual({ redirectTo: null, render: "children" });
  });

  test("are gated no matter how the path is cased", () => {
    expect(resolveSigninGateDecision({ ...signedOut, path: "/SESSION" }).render).toBe("signin");
    expect(resolveSigninGateDecision({ ...signedOut, path: "/SignIn" }).render).toBe("children");
  });
});

describe("in-flight session checks", () => {
  test("render nothing so the boot overlay stays up instead of flashing sign-in", () => {
    expect(
      resolveSigninGateDecision({
        status: "checking",
        isSignedIn: false,
        path: "/session",
        hasPreparedBootstrap: false,
      }),
    ).toEqual({ redirectTo: null, render: "pending" });
  });
});

describe("signed-in users", () => {
  test("get the app routes", () => {
    expect(resolveSigninGateDecision({ ...signedIn, path: "/session" })).toEqual({
      redirectTo: null,
      render: "children",
    });
  });

  test("are moved off the sign-in page to onboarding", () => {
    expect(resolveSigninGateDecision({ ...signedIn, path: "/signin" })).toEqual({
      redirectTo: "/onboarding",
      render: "children",
    });
  });

  test("keep working offline with a retained session", () => {
    expect(
      resolveSigninGateDecision({
        status: "unavailable",
        isSignedIn: true,
        path: "/session",
        hasPreparedBootstrap: false,
      }),
    ).toEqual({ redirectTo: null, render: "children" });
  });
});
