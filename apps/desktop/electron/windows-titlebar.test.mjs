import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WINDOWS_TITLE_BAR_CONTROLS_WIDTH,
  WINDOWS_TITLE_BAR_HEIGHT,
  windowsTitleBarOptions,
  windowsTitleBarOverlay,
} from "./windows-titlebar.mjs";

test("Windows title bar overlay matches the 44px application toolbar", () => {
  assert.equal(WINDOWS_TITLE_BAR_HEIGHT, 44);
  assert.equal(WINDOWS_TITLE_BAR_CONTROLS_WIDTH, 138);
  assert.deepEqual(windowsTitleBarOptions(false), {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f7f7f7",
      symbolColor: "#202124",
      height: 44,
    },
  });
});

test("Windows title bar overlay follows dark mode", () => {
  assert.deepEqual(windowsTitleBarOverlay(true), {
    color: "#18191b",
    symbolColor: "#f5f5f5",
    height: 44,
  });
});

test("main window enables the Windows overlay and refreshes it with the native theme", async () => {
  const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /Object\.assign\(windowAppearanceOptions, windowsTitleBarOptions\(nativeTheme\.shouldUseDarkColors\)\)/);
  assert.match(main, /mainWindow\?\.setTitleBarOverlay\(windowsTitleBarOverlay\(nativeTheme\.shouldUseDarkColors\)\)/);
});
