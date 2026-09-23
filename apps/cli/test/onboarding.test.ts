import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/args.js";
import { isOnboardingEntry, nextOnboardingSelection, renderOnboarding } from "../src/onboarding.js";

test("onboarding appears only for a bare interactive local run", () => {
  assert.equal(isOnboardingEntry(parseCliArgs([]), true), true);
  assert.equal(isOnboardingEntry(parseCliArgs([]), false), false);
  assert.equal(isOnboardingEntry(parseCliArgs(["review this repository"]), true), false);
  assert.equal(isOnboardingEntry(parseCliArgs(["status"]), true), false);
  assert.equal(isOnboardingEntry(parseCliArgs(["exec", "review this repository"]), true), false);
  assert.equal(isOnboardingEntry(parseCliArgs(["--server", "http://127.0.0.1:9000"]), true), false);
});

test("onboarding menu follows the reference without advertising unsupported login methods", () => {
  const screen = renderOnboarding(0, false);
  assert.match(screen, /^Welcome to JuggleWork/);
  assert.match(screen, /> 1\. Sign in with JuggleWork Cloud/);
  assert.match(screen, /2\. Paste a one-time handoff/);
  assert.match(screen, /3\. Continue without Cloud/);
  assert.match(screen, /Press enter to continue/);
  assert.doesNotMatch(screen, /device code|API key/i);
  assert.equal(nextOnboardingSelection(0, "up"), 2);
  assert.equal(nextOnboardingSelection(2, "down"), 0);
  assert.match(renderOnboarding(1, false), /> 2\. Paste a one-time handoff/);
});
