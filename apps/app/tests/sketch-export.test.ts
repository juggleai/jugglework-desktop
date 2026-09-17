import { describe, expect, test } from "bun:test";

import { exportSketchFile, renderSketchToContext } from "../src/react-app/domains/session/surface/composer/sketch/sketch-export";
import { SKETCH_EXPORT_MAX_PX } from "../src/react-app/domains/session/surface/composer/sketch/sketch-model";
import type { SketchElement } from "../src/react-app/domains/session/surface/composer/sketch/sketch-model";

describe("sketch export renderer", () => {
  test("renders strokes, shapes, arrows, and multilingual text", () => {
    const calls: string[] = [];
    const context = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      scale: (x: number, y: number) => calls.push(`scale:${x}:${y}`),
      beginPath: () => calls.push("begin"),
      moveTo: () => calls.push("move"),
      lineTo: () => calls.push("line"),
      stroke: () => calls.push("stroke"),
      strokeRect: () => calls.push("rect"),
      ellipse: () => calls.push("ellipse"),
      fillText: (text: string) => calls.push(`text:${text}`),
      set lineCap(_value: string) {},
      set lineJoin(_value: string) {},
      set strokeStyle(_value: string) {},
      set fillStyle(_value: string) {},
      set lineWidth(_value: number) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const common = { x: 10, y: 10, color: "#111111", strokeWidth: 4 };
    const elements: SketchElement[] = [
      { ...common, id: "stroke", type: "stroke", points: [0, 0, 20, 20] },
      { ...common, id: "line", type: "line", points: [0, 0, 40, 40] },
      { ...common, id: "arrow", type: "arrow", points: [0, 0, 40, 40] },
      { ...common, id: "rect", type: "rectangle", width: 100, height: 60 },
      { ...common, id: "ellipse", type: "ellipse", width: 80, height: 40 },
      { ...common, id: "text", type: "text", text: "草图\nSketch", fontSize: 30, width: 300 },
    ];

    renderSketchToContext(context, elements, 0.5);

    expect(calls).toContain("scale:0.5:0.5");
    expect(calls).toContain("rect");
    expect(calls).toContain("ellipse");
    expect(calls).toContain("text:草图");
    expect(calls).toContain("text:Sketch");
    expect(calls.filter((call) => call === "stroke").length).toBeGreaterThanOrEqual(4);
    expect(calls.at(-1)).toBe("restore");
  });

  test("exports an opaque, bounded PNG with a safe name", async () => {
    const calls: string[] = [];
    const context = {
      fillRect: (x: number, y: number, width: number, height: number) => calls.push(`fill:${x}:${y}:${width}:${height}`),
      save: () => {},
      restore: () => {},
      scale: () => {},
      set lineCap(_value: string) {},
      set lineJoin(_value: string) {},
      set fillStyle(value: string) { calls.push(`color:${value}`); },
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" })),
    } as unknown as HTMLCanvasElement;

    const file = await exportSketchFile([], new Date(2026, 8, 17, 9, 5, 4), () => canvas);

    expect(canvas.width).toBeLessThanOrEqual(SKETCH_EXPORT_MAX_PX);
    expect(canvas.height).toBeLessThanOrEqual(SKETCH_EXPORT_MAX_PX);
    expect(calls).toContain("color:#ffffff");
    expect(calls).toContain(`fill:0:0:${canvas.width}:${canvas.height}`);
    expect(file.name).toBe("sketch-20260917-090504.png");
    expect(file.type).toBe("image/png");
  });

  test("rejects export without mutating the scene when encoding fails", async () => {
    const context = {
      fillRect: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      set lineCap(_value: string) {},
      set lineJoin(_value: string) {},
      set fillStyle(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) => callback(null),
    } as unknown as HTMLCanvasElement;

    await expect(exportSketchFile([], new Date(), () => canvas)).rejects.toThrow("could not be rendered");
  });
});
