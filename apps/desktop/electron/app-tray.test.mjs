import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_TRAY_TOOLTIP, REMOTE_CONTROL_BACKGROUND_TOOLTIP, createAppTrayIndicator } from "./app-tray.mjs";

function harness({ unsupported = false, setupFails = false } = {}) {
  const trays = [];
  const menus = [];
  let restored = 0;
  let quit = 0;
  let stoppedAll = 0;
  const indicator = createAppTrayIndicator({
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
    quitApp: () => { quit += 1; },
  });
  return {
    indicator, trays, menus,
    stopAll: () => { stoppedAll += 1; },
    get restored() { return restored; },
    get quit() { return quit; },
    get stoppedAll() { return stoppedAll; },
  };
}

function labels(template) {
  return template.map((item) => item.label ?? item.type);
}

describe("app tray indicator", () => {
  it("starts an always-on tray with open/quit entries and fixed non-sensitive copy", async () => {
    const h = harness();
    assert.equal(h.indicator.start(), true);
    assert.equal(h.indicator.start(), true); // idempotent
    assert.equal(h.trays.length, 1);
    assert.equal(h.trays[0].tooltip, APP_TRAY_TOOLTIP);
    assert.deepEqual(labels(h.menus[0]), ["Open JuggleWork", "separator", "Quit JuggleWork"]);
    h.trays[0].listeners.click();
    h.menus[0][0].click();
    h.menus[0][2].click();
    await Promise.resolve();
    assert.equal(h.restored, 2);
    assert.equal(h.quit, 1);
  });

  it("appends Stop All and switches tooltip while remote-control background mode is on", async () => {
    const h = harness();
    h.indicator.start();
    h.indicator.updateRemoteControl({ backgroundRequested: true, stopAll: h.stopAll });
    assert.equal(h.trays[0].tooltip, REMOTE_CONTROL_BACKGROUND_TOOLTIP);
    assert.deepEqual(labels(h.menus[1]), ["Open JuggleWork", "separator", "Stop All", "separator", "Quit JuggleWork"]);
    h.menus[1][2].click();
    await Promise.resolve();
    assert.equal(h.stoppedAll, 1);

    h.indicator.updateRemoteControl({ backgroundRequested: false });
    assert.equal(h.trays[0].tooltip, APP_TRAY_TOOLTIP);
    assert.deepEqual(labels(h.menus[2]), ["Open JuggleWork", "separator", "Quit JuggleWork"]);
  });

  it("applies remote-control state recorded before the tray starts", async () => {
    const h = harness();
    h.indicator.updateRemoteControl({ backgroundRequested: true, stopAll: () => {} });
    assert.equal(h.indicator.start(), true);
    assert.equal(h.trays[0].tooltip, REMOTE_CONTROL_BACKGROUND_TOOLTIP);
    assert.deepEqual(labels(h.menus[0]), ["Open JuggleWork", "separator", "Stop All", "separator", "Quit JuggleWork"]);
  });

  it("destroys the tray permanently on stop", () => {
    const h = harness();
    h.indicator.start();
    h.indicator.stop();
    assert.equal(h.trays[0].destroyed, 1);
    assert.equal(h.indicator.active(), false);
    assert.equal(h.indicator.start(), false);
  });

  it("fails closed when Tray is unsupported", () => {
    const h = harness({ unsupported: true });
    assert.equal(h.indicator.start(), false);
    assert.equal(h.indicator.active(), false);
  });

  it("destroys a partially created Tray when indicator setup fails", () => {
    const h = harness({ setupFails: true });
    assert.equal(h.indicator.start(), false);
    assert.equal(h.indicator.active(), false);
    assert.equal(h.trays[0].destroyed, 1);
  });
});
