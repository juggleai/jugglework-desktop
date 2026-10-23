import { describe, expect, test } from "bun:test";
import { ORG_MCP_SYNC_INTERVAL_MS, subscribeOrgMcpSync } from "../src/react-app/domains/connections/org-mcp-sync";

function setup(refresh: () => Promise<void>) {
  const host = new EventTarget();
  const page = new EventTarget();
  let visible = true;
  let tick = () => {};
  let cleared = false;
  const unsubscribe = subscribeOrgMcpSync({
    windowTarget: host,
    documentTarget: page,
    isVisible: () => visible,
    refresh,
    setInterval: (callback, delay) => {
      expect(delay).toBe(ORG_MCP_SYNC_INTERVAL_MS);
      tick = callback;
      return 1;
    },
    clearInterval: () => { cleared = true; },
  });
  return { host, page, tick: () => tick(), setVisible: (value: boolean) => { visible = value; }, unsubscribe, cleared: () => cleared };
}

describe("organization connector synchronization", () => {
  for (const event of ["focus", "online", "visibilitychange", "interval"]) {
    test(`removes a cloud-deleted connector on ${event} without manual refresh`, async () => {
      let rows = ["github"];
      const sync = setup(async () => { rows = []; });
      if (event === "interval") sync.tick();
      else (event === "visibilitychange" ? sync.page : sync.host).dispatchEvent(new Event(event));
      await Promise.resolve();
      expect(rows).toEqual([]);
      sync.unsubscribe();
    });
  }

  test("hidden windows wait until visible and overlapping resume events share a refresh", async () => {
    let calls = 0;
    let finish = () => {};
    const sync = setup(() => {
      calls += 1;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    sync.setVisible(false);
    sync.tick();
    sync.host.dispatchEvent(new Event("focus"));
    sync.page.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toBe(0);
    sync.setVisible(true);
    sync.page.dispatchEvent(new Event("visibilitychange"));
    sync.host.dispatchEvent(new Event("focus"));
    sync.tick();
    expect(calls).toBe(1);
    finish();
    await Promise.resolve();
    sync.tick();
    expect(calls).toBe(2);
    sync.unsubscribe();
    finish();
    await Promise.resolve();
    sync.host.dispatchEvent(new Event("focus"));
    sync.host.dispatchEvent(new Event("online"));
    sync.page.dispatchEvent(new Event("visibilitychange"));
    sync.tick();
    expect(calls).toBe(2);
    expect(sync.cleared()).toBe(true);
  });
});
