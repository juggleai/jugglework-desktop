import { describe, expect, test } from "bun:test";

import {
  ACTIVATION_CONFIG_ECHO_GRACE_MS,
  isActivationConfigEcho,
} from "../src/react-app/shell/use-engine-reload";

function event(reason: "config" | "skills", timestamp: number) {
  return { reason, timestamp };
}

describe("activation config echo suppression", () => {
  const completedAt = 1_000_000;

  test("config event inside the grace window is an echo", () => {
    expect(isActivationConfigEcho(event("config", completedAt), completedAt)).toBe(true);
    expect(isActivationConfigEcho(event("config", completedAt + ACTIVATION_CONFIG_ECHO_GRACE_MS - 1), completedAt)).toBe(true);
  });

  test("unconsumed config event from before the activation is also redundant", () => {
    // The activation's inline engine reload applied the current on-disk
    // state, so a config event that was never consumed pre-activation needs
    // no further reload either.
    expect(isActivationConfigEcho(event("config", completedAt - 1), completedAt)).toBe(true);
  });

  test("config event past the window is not an echo", () => {
    expect(isActivationConfigEcho(event("config", completedAt + ACTIVATION_CONFIG_ECHO_GRACE_MS + 1), completedAt)).toBe(false);
  });

  test("non-config mutations in the window are never suppressed", () => {
    expect(isActivationConfigEcho(event("skills", completedAt), completedAt)).toBe(false);
    expect(isActivationConfigEcho(event("skills", completedAt + 10), completedAt)).toBe(false);
  });

  test("no activation timestamp means no suppression", () => {
    expect(isActivationConfigEcho(event("config", Date.now()), null)).toBe(false);
    expect(isActivationConfigEcho(event("config", Date.now()), undefined)).toBe(false);
    expect(isActivationConfigEcho(event("config", 0), completedAt)).toBe(false);
  });
});
