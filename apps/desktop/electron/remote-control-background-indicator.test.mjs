import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REMOTE_CONTROL_BACKGROUND_TOOLTIP, createRemoteControlBackgroundIndicator } from "./remote-control-background-indicator.mjs";

function harness({ unsupported = false, setupFails = false } = {}) {
  const trays = [];
  const menus = [];
  let restored = 0;
  let stopped = 0;
  const indicator = createRemoteControlBackgroundIndicator({
    createTray: () => {
      if (unsupported) throw new Error("unsupported");
      const tray = {
        listeners: {}, destroyed: 0, tooltip: null, menu: null,
        on(event, listener) { this.listeners[event] = listener; },
        setToolTip(value) { if (setupFails) throw new Error("setup failed"); this.tooltip = value; },
        setContextMenu(value) { this.menu = value; },
        destroy() { this.destroyed += 1; },
      };
      trays.push(tray);
      return tray;
    },
    buildMenu: (template) => { menus.push(template); return template; },
    restoreWindow: () => { restored += 1; },
    stopAll: () => { stopped += 1; },
  });
  return { indicator, trays, menus, get restored() { return restored; }, get stopped() { return stopped; } };
}

describe("remote-control background indicator", () => {
  it("exists only for both local opt-ins and uses fixed non-sensitive copy", async () => {
    const h = harness();
    assert.equal(h.indicator.update({ enabled: true, backgroundMode: false }), false);
    assert.equal(h.indicator.update({ enabled: true, backgroundMode: true }), true);
    assert.equal(h.indicator.update({ enabled: true, backgroundMode: true }), true);
    assert.equal(h.trays.length, 1);
    assert.equal(h.trays[0].tooltip, REMOTE_CONTROL_BACKGROUND_TOOLTIP);
    assert.deepEqual(h.menus[0].map((item) => item.label ?? item.type), ["Open JuggleWork", "separator", "Stop All"]);
    h.trays[0].listeners.click();
    h.menus[0][2].click();
    await Promise.resolve();
    assert.equal(h.restored, 1);
    assert.equal(h.stopped, 1);
  });

  it("disposes on disable and permanently on stop", () => {
    const h = harness();
    h.indicator.update({ enabled: true, backgroundMode: true });
    h.indicator.update({ enabled: false, backgroundMode: false });
    assert.equal(h.trays[0].destroyed, 1);
    h.indicator.update({ enabled: true, backgroundMode: true });
    h.indicator.stop();
    assert.equal(h.trays[1].destroyed, 1);
    assert.equal(h.indicator.update({ enabled: true, backgroundMode: true }), false);
  });

  it("fails closed when Tray is unsupported", () => {
    const h = harness({ unsupported: true });
    assert.equal(h.indicator.update({ enabled: true, backgroundMode: true }), false);
    assert.equal(h.indicator.active(), false);
  });

  it("destroys a partially created Tray when indicator setup fails", () => {
    const h = harness({ setupFails: true });
    assert.equal(h.indicator.update({ enabled: true, backgroundMode: true }), false);
    assert.equal(h.indicator.active(), false);
    assert.equal(h.trays[0].destroyed, 1);
  });
});
