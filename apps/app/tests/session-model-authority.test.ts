import { expect, test } from "bun:test";
import { sessionModelReadIsCurrent, sessionModelSeed } from "../src/react-app/kernel/session-model-authority";
import type { JuggleWorkSessionModelPreference } from "../src/app/lib/jugglework-server";

const desktop = { providerID: "lpr_desktop", modelID: "desktop" };
const legacy = { providerID: "lpr_legacy", modelID: "legacy" };
const phone = { providerID: "lpr_phone", modelID: "phone" };
const initial: JuggleWorkSessionModelPreference = {
  workspaceId: "workspace", sessionId: "session", revision: 0,
  mode: "auto", model: null, updatedAt: 0,
};
test("publishes Desktop's effective default for an uninitialized session", () => {
  expect(sessionModelSeed(initial, undefined, desktop)).toEqual(desktop);
  expect(sessionModelSeed(initial, legacy, desktop)).toEqual(legacy);
  expect(sessionModelSeed(initial, undefined, undefined)).toBeNull();
});
test("phone preference is authoritative over stale Desktop local choices", () => {
  expect(sessionModelSeed({ ...initial, revision: 4, mode: "explicit", model: phone }, legacy, desktop)).toBeNull();
});
test("legacy persisted auto resolves the displayed default, not stale overrides", () => {
  expect(sessionModelSeed({ ...initial, revision: 2 }, legacy, desktop)).toEqual(desktop);
});
test("first read applies without a mutation; a later selection fences the read", () => {
  expect(sessionModelReadIsCurrent(undefined, 0)).toBe(true);
  expect(sessionModelReadIsCurrent(1, 0)).toBe(false);
  expect(sessionModelReadIsCurrent(2, 2)).toBe(true);
});
