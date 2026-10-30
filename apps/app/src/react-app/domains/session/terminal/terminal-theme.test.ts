import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { opaqueTerminalColor, resolveTerminalTheme } from "./terminal-theme";

describe("terminal theme", () => {
  it("uses safe, contrasting defaults for absent or fully transparent tokens in both modes", () => {
    for (const read of [() => null, () => [0, 0, 0, 0] as const]) {
      const light = resolveTerminalTheme(read, false);
      const dark = resolveTerminalTheme(read, true);
      assert.equal(light.background, "#ffffff");
      assert.equal(light.foreground, "#1c2024");
      assert.equal(dark.background, "#111113");
      assert.equal(dark.foreground, "#edeef0");
      for (const theme of [light, dark]) {
        assert.equal(theme.cursor, theme.foreground);
        assert.equal(theme.cursorAccent, theme.background);
        for (const color of Object.values(theme)) assert.match(color, /^#[0-9a-f]{6}$/);
      }
    }
  });

  it("composites translucent colors rather than giving xterm a transparent surface", () => {
    assert.equal(opaqueTerminalColor([0, 0, 0, 128], "#ffffff"), "#7f7f7f");
    assert.equal(opaqueTerminalColor([255, 0, 0, 128], "#ffffff", "#000000"), "#800000");
    assert.equal(opaqueTerminalColor([0, 0, 0, 0], "#ffffff", "#000000"), "#ffffff");
  });

  it("maps app and brand tokens to foreground, cursor and both selection states", () => {
    const colors: Record<string, readonly [number, number, number, number]> = {
      "--background": [16, 32, 48, 255],
      "--foreground": [240, 241, 242, 255],
      "--dls-accent": [0, 128, 255, 255],
      "--dls-accent-fg": [255, 255, 255, 255],
    };
    assert.deepEqual(resolveTerminalTheme((token) => colors[token] ?? null, true), {
      background: "#102030", foreground: "#f0f1f2", cursor: "#f0f1f2", cursorAccent: "#102030",
      selectionBackground: "#0080ff", selectionForeground: "#ffffff", selectionInactiveBackground: "#0080ff",
    });
  });
});
