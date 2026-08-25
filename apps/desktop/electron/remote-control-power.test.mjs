import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { createRemoteControlPowerMonitorController, createRemoteControlSleepController } from "./remote-control-power.mjs";

describe("remote-control execution sleep prevention", () => {
  it("keeps an authorized waiting device awake until the user opts out", () => {
    const starts = [];
    const stops = [];
    const controller = createRemoteControlSleepController({
      powerSaveBlocker: { start: (type) => { starts.push(type); return 5; }, stop: (id) => stops.push(id) },
    });
    controller.setPreventSleepWhileWaiting(true);
    controller.setAuthorized(true);
    assert.deepEqual(starts, ["prevent-app-suspension"]);
    controller.setPreventSleepWhileWaiting(false);
    assert.deepEqual(stops, [5]);
  });

  it("shares one blocker across authorized admitted runs and releases on the final run", () => {
    const starts = [];
    const stops = [];
    const controller = createRemoteControlSleepController({
      powerSaveBlocker: { start: (type) => { starts.push(type); return 7; }, stop: (id) => stops.push(id) },
    });
    controller.setActiveRunCount(2);
    assert.deepEqual(starts, []);
    controller.setAuthorized(true);
    controller.setActiveRunCount(1);
    assert.deepEqual(starts, ["prevent-app-suspension"]);
    controller.setActiveRunCount(0);
    assert.deepEqual(stops, [7]);
  });

  it("releases immediately on authorization loss and stop and tolerates unsupported APIs", () => {
    const stops = [];
    const controller = createRemoteControlSleepController({
      powerSaveBlocker: { start: () => 11, stop: (id) => stops.push(id) },
    });
    controller.setActiveRunCount(1);
    controller.setAuthorized(true);
    controller.setAuthorized(false);
    controller.setAuthorized(true);
    controller.stop();
    assert.deepEqual(stops, [11, 11]);
    const unsupported = createRemoteControlSleepController({
      powerSaveBlocker: { start() { throw new Error("unsupported"); }, stop() {} },
    });
    unsupported.setActiveRunCount(1);
    assert.doesNotThrow(() => unsupported.setAuthorized(true));
  });
});

describe("remote-control power monitor lifecycle", () => {
  it("registers once, fences on suspend, resumes through the agent, and disposes listeners", async () => {
    const monitor = new EventEmitter();
    const calls = [];
    const controller = createRemoteControlPowerMonitorController({
      powerMonitor: monitor,
      getAgent: () => ({ suspend: () => calls.push("suspend"), resume: () => calls.push("resume") }),
      onResume: () => calls.push("recover"),
    });
    controller.start();
    controller.start();
    monitor.emit("suspend");
    monitor.emit("resume");
    await Promise.resolve();
    assert.deepEqual(calls, ["suspend", "resume", "recover"]);
    assert.equal(monitor.listenerCount("suspend"), 1);
    assert.equal(monitor.listenerCount("resume"), 1);
    controller.stop();
    assert.equal(monitor.listenerCount("suspend"), 0);
    assert.equal(monitor.listenerCount("resume"), 0);
  });
});
