import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const dialogPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/sketch/sketch-dialog.tsx", import.meta.url),
);
const canvasPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/sketch/sketch-canvas.tsx", import.meta.url),
);
const desktopMainPath = fileURLToPath(new URL("../../desktop/electron/main.mjs", import.meta.url));

describe("sketch dialog component contract", () => {
  test("keeps focus, labels, shortcuts, IME handling, and theme states explicit", () => {
    const dialog = readFileSync(dialogPath, "utf8");
    const canvas = readFileSync(canvasPath, "utf8");

    expect(dialog).toContain("<DialogTitle className=\"sr-only\"");
    expect(dialog).toContain('aria-describedby="sketch-dialog-description"');
    expect(dialog).toContain("focus-visible:ring-2");
    expect(dialog).toContain("dark:bg-gray-2/95");
    expect(dialog).toContain('event.key.toLowerCase() !== "z"');
    expect(dialog).toContain("if (event.shiftKey) redo()");
    expect(canvas).toContain('className="relative h-full min-h-0 w-full overflow-hidden bg-white"');
    expect(canvas).toContain("event.nativeEvent.isComposing");
    expect(canvas).toContain('event.key === "Process"');
  });

  test("blocks empty and duplicate completion and preserves recoverable failures", () => {
    const dialog = readFileSync(dialogPath, "utf8");

    expect(dialog).toContain("if (isSketchEmpty(elements) || exporting) return");
    expect(dialog).toContain("disabled={isSketchEmpty(elements) || exporting}");
    expect(dialog).toContain("setExporting(true)");
    expect(dialog).toContain("setError(t(\"sketch.export_error\"))");
    expect(dialog).not.toContain("setElements([])");
  });

  test("prompts for drawn or pending text content and can return to the unchanged editor", () => {
    const dialog = readFileSync(dialogPath, "utf8");

    expect(dialog).toContain("if (isSketchEmpty(elements) && !textDraftDirty)");
    expect(dialog).toContain("setDiscardOpen(true)");
    expect(dialog).toContain("<AlertDialog open={discardOpen}");
    expect(dialog).toContain("window.requestAnimationFrame(() => canvasRef.current?.focus())");
    expect(dialog).toContain("props.onOpenChange(false)");
  });

  test("uses an inset desktop canvas, a compact bottom sheet, and a bounded app window", () => {
    const dialog = readFileSync(dialogPath, "utf8");
    const desktopMain = readFileSync(desktopMainPath, "utf8");

    expect(dialog).toContain("h-[calc(100dvh-10rem)]");
    expect(dialog).toContain("sm:h-[min(48rem,calc(100dvh-5rem))]");
    expect(dialog).toContain("sm:w-[min(52rem,calc(100%-4rem))]");
    expect(dialog).toContain("sm:max-w-[52rem]");
    expect(desktopMain).toContain("minWidth: 480");
    expect(desktopMain).toContain("minHeight: 600");
  });
});
