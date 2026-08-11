import assert from "node:assert/strict";
import { it } from "node:test";

import { applyPersistedRemoteControlLocalEffects, reconcilePersistedRemoteControlSettings, stopAllRemoteControl } from "./remote-control-settings-lifecycle.mjs";

it("applies persisted local effects before reporting managed-runtime sync failure", async () => {
  const settings = { enabled: true, backgroundMode: true, launchAtLogin: true };
  const calls = [];
  await assert.rejects(reconcilePersistedRemoteControlSettings({
    settings,
    applyLaunchAtLogin: (value) => { calls.push(["login", value]); return true; },
    updateBackgroundIndicator: (value) => { calls.push(["indicator", value]); return true; },
    refreshLocalSettings: async () => { calls.push(["agent"]); },
    synchronizePendingPolicy: async () => { calls.push(["policy"]); throw new Error("managed runtime unavailable"); },
  }), /managed runtime unavailable/);
  assert.deepEqual(calls, [
    ["login", settings],
    ["indicator", settings],
    ["agent"],
    ["policy"],
  ]);
});

it("returns the durable settings after all reconciliation succeeds", async () => {
  const settings = { enabled: false, backgroundMode: false, launchAtLogin: false };
  const result = await reconcilePersistedRemoteControlSettings({
    settings,
    applyLaunchAtLogin: () => false,
    updateBackgroundIndicator: () => false,
    refreshLocalSettings: async () => {},
    synchronizePendingPolicy: async () => {},
  });
  assert.equal(result, settings);
});

it("still fences managed pending policy when local agent refresh fails", async () => {
  const calls = [];
  await assert.rejects(reconcilePersistedRemoteControlSettings({
    settings: { enabled: false, backgroundMode: false, launchAtLogin: false },
    applyLaunchAtLogin: () => true,
    updateBackgroundIndicator: () => false,
    refreshLocalSettings: async () => { calls.push("agent"); throw new Error("agent refresh failed"); },
    synchronizePendingPolicy: async () => { calls.push("policy"); },
  }), /agent refresh failed/);
  assert.deepEqual(calls, ["agent", "policy"]);
});

it("Stop All unregisters launch-at-login immediately after durable disable", async () => {
  const calls = [];
  await stopAllRemoteControl({
    disableSettings: async () => {
      calls.push(["persist"]);
      return { enabled: false, backgroundMode: false, launchAtLogin: false };
    },
    applyLocalEffects: (settings) => applyPersistedRemoteControlLocalEffects({
      settings,
      applyLaunchAtLogin: (value) => { calls.push(["login", value.launchAtLogin]); return true; },
      updateBackgroundIndicator: (value) => { calls.push(["indicator", value.backgroundMode]); return false; },
    }),
    stopRemote: async () => { calls.push(["remote"]); },
  });
  assert.deepEqual(calls, [["persist"], ["login", false], ["indicator", false], ["remote"]]);
});
