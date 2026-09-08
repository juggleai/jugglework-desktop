import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const composer = readFileSync(new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url), "utf8");
const stopHandlerIndex = composer.indexOf("onClick={props.onStop}");
const buttonStart = composer.lastIndexOf("<button", stopHandlerIndex);
const stopButton = composer.slice(buttonStart, composer.indexOf("</button>", stopHandlerIndex));
const classes = stopButton.match(/className="([^"]+)"/)?.[1].split(/\s+/) ?? [];

describe("running task stop button", () => {
  test("uses black/white colors in light mode and inverts them in dark mode", () => {
    for (const token of ["bg-black", "text-white", "dark:bg-white", "dark:text-black", "hover:bg-black/90", "dark:hover:bg-white/90"]) {
      expect(classes).toContain(token);
    }
    for (const token of ["bg-transparent", "text-gray-11", "hover:bg-gray-3", "border-dls-border"]) {
      expect(classes).not.toContain(token);
    }
  });

  test("preserves the circular size, filled square, stop action and queued count", () => {
    for (const token of ["h-9", "w-9", "rounded-full"]) expect(classes).toContain(token);
    expect(stopButton).toContain('type="button"');
    expect(stopButton).toContain("onClick={props.onStop}");
    expect(stopButton).toContain('<Square size={12} fill="currentColor" />');
    expect(stopButton).toContain("{props.queuedCount}");
  });

  test("dark utilities respond to both supported theme selectors", () => {
    const css = readFileSync(new URL("../src/app/index.css", import.meta.url), "utf8");
    expect(css).toContain('@custom-variant dark (&:is(.dark, .dark *, [data-theme="dark"], [data-theme="dark"] *));');
  });
});
