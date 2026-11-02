import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileWindowAppearance } from "./file-window-appearance.mjs";

test("appearance reads only applied DOM preferences and returns allowlisted fields", async () => {
  let source = "";
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false,
    executeJavaScript: async (script) => { source = script; return /** @type {any} */ ({ lang: "zh", theme: "dark", token: "synthetic-canary" }); } } };
  assert.deepEqual(await readFileWindowAppearance(window), { lang: "zh", theme: "dark" });
  assert.doesNotMatch(source, /localStorage|sessionStorage|cookie|bootstrap/);
  window.webContents.executeJavaScript = async () => ({ lang: "invalid", theme: "invalid" });
  assert.deepEqual(await readFileWindowAppearance(window), { lang: "en", theme: "light" });
  window.webContents.executeJavaScript = async () => { throw new Error("closed"); };
  assert.deepEqual(await readFileWindowAppearance(window, { lang: "en", theme: "dark" }), { lang: "en", theme: "dark" });
  assert.deepEqual(await readFileWindowAppearance(null), { lang: "en", theme: "light" });
});
