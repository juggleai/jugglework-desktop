declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { classifyAccountTransition } from "./den-account-switch";

describe("classifyAccountTransition", () => {
  test("recognises the same account signing in again", () => {
    expect(classifyAccountTransition("usr_a", "usr_a")).toBe("same");
    expect(classifyAccountTransition(" usr_a ", "usr_a")).toBe("same");
  });

  test("recognises the first sign-in this machine has recorded", () => {
    // Nothing to attribute to a previous account, so nothing to purge.
    expect(classifyAccountTransition(null, "usr_a")).toBe("first-known");
    expect(classifyAccountTransition("", "usr_a")).toBe("first-known");
  });

  test("recognises a different account on the same machine", () => {
    expect(classifyAccountTransition("usr_a", "usr_b")).toBe("switched");
  });

  test("treats a missing incoming identity as no change", () => {
    // A session refresh that could not resolve a user must never be read as a
    // switch — that would purge the signed-in account's own state.
    expect(classifyAccountTransition("usr_a", null)).toBe("same");
    expect(classifyAccountTransition("usr_a", "   ")).toBe("same");
    expect(classifyAccountTransition(null, null)).toBe("same");
  });
});
