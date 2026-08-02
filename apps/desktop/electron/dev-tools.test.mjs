import assert from "node:assert/strict";
import test from "node:test";

import { openDevelopmentDevTools } from "./dev-tools.mjs";

test("opens detached DevTools by default in development", () => {
  const calls = [];
  const webContents = {
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
    openDevTools: (options) => calls.push(options),
  };

  assert.equal(openDevelopmentDevTools(webContents, true), true);
  assert.deepEqual(calls, [{ mode: "detach", activate: true }]);
});

test("does not open DevTools in production or duplicate an open instance", () => {
  let callCount = 0;
  const productionWebContents = {
    openDevTools: () => { callCount += 1; },
  };
  const alreadyOpenWebContents = {
    isDevToolsOpened: () => true,
    openDevTools: () => { callCount += 1; },
  };

  assert.equal(openDevelopmentDevTools(productionWebContents, false), false);
  assert.equal(openDevelopmentDevTools(alreadyOpenWebContents, true), false);
  assert.equal(callCount, 0);
});
