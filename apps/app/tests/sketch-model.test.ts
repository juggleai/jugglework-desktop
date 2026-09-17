import { describe, expect, test } from "bun:test";

import {
  SKETCH_EXPORT_MAX_PX,
  cloneSketchElements,
  commitSketchHistory,
  createSketchDrawElement,
  createSketchHistory,
  createSketchTextElement,
  isSketchEmpty,
  isMeaningfulSketchElement,
  moveSketchElement,
  normalizeShapeBounds,
  redoSketchHistory,
  removeSketchElements,
  resizeSketchElement,
  sketchExportDimensions,
  sketchFilename,
  undoSketchHistory,
  updateSketchDrawElement,
  type SketchElement,
} from "../src/react-app/domains/session/surface/composer/sketch/sketch-model";

const stroke = (id: string): SketchElement => ({
  id,
  type: "stroke",
  x: 10,
  y: 20,
  color: "#111111",
  strokeWidth: 5,
  points: [0, 0, 20, 10],
});

describe("sketch model", () => {
  test("commits, undoes, redoes, and clears a stale redo branch", () => {
    const initial = createSketchHistory();
    const first = commitSketchHistory(initial, [stroke("one")]);
    const second = commitSketchHistory(first, [stroke("one"), stroke("two")]);

    const undone = undoSketchHistory(second);
    expect(undone.present.map((item) => item.id)).toEqual(["one"]);
    expect(undone.future).toHaveLength(1);

    const redone = redoSketchHistory(undone);
    expect(redone.present.map((item) => item.id)).toEqual(["one", "two"]);

    const branched = commitSketchHistory(undone, [stroke("three")]);
    expect(branched.present.map((item) => item.id)).toEqual(["three"]);
    expect(branched.future).toEqual([]);
  });

  test("bounds retained history and does not commit identical content", () => {
    let history = createSketchHistory();
    for (let index = 0; index < 6; index += 1) {
      history = commitSketchHistory(history, [stroke(String(index))], 3);
    }
    expect(history.past).toHaveLength(3);
    expect(commitSketchHistory(history, cloneSketchElements(history.present), 3)).toBe(history);
  });

  test("clones point arrays and removes complete hit objects", () => {
    const original = [stroke("one"), stroke("two")];
    const cloned = cloneSketchElements(original);
    (cloned[0] as Extract<SketchElement, { type: "stroke" }>).points.push(30, 40);

    expect((original[0] as Extract<SketchElement, { type: "stroke" }>).points).toEqual([0, 0, 20, 10]);
    expect(removeSketchElements(original, ["one"]).map((item) => item.id)).toEqual(["two"]);
    expect(isSketchEmpty([])).toBe(true);
    expect(isSketchEmpty(original)).toBe(false);
  });

  test("normalizes reverse drag bounds", () => {
    expect(normalizeShapeBounds(100, 80, 20, 30)).toEqual({
      x: 20,
      y: 30,
      width: 80,
      height: 50,
    });
  });

  test("creates and updates every drawing tool from a stable gesture origin", () => {
    const start = { x: 100, y: 80 };
    for (const tool of ["pen", "line", "arrow", "rectangle", "ellipse"] as const) {
      const created = createSketchDrawElement(tool, start, "#dc2626", 7);
      expect(created).not.toBeNull();
      const updated = updateSketchDrawElement(created!, start, { x: 20, y: 30 });
      expect(updated.color).toBe("#dc2626");
      expect(updated.strokeWidth).toBe(7);
      expect(isMeaningfulSketchElement(updated)).toBe(true);
      if (updated.type === "rectangle" || updated.type === "ellipse") {
        expect({ x: updated.x, y: updated.y, width: updated.width, height: updated.height }).toEqual({
          x: 20,
          y: 30,
          width: 80,
          height: 50,
        });
      }
    }
    expect(createSketchDrawElement("select", start, "#111111", 5)).toBeNull();
  });

  test("commits multilingual text and ignores an empty text edit", () => {
    const text = createSketchTextElement({ x: 12, y: 24 }, "  中文草图 🎨  ", "#111111", 5);
    expect(text?.text).toBe("中文草图 🎨");
    expect(text?.fontSize).toBeGreaterThanOrEqual(24);
    expect(isMeaningfulSketchElement(text!)).toBe(true);
    expect(createSketchTextElement({ x: 0, y: 0 }, "   ", "#111111", 5)).toBeNull();
  });

  test("commits move and resize transforms without changing unsupported geometry", () => {
    const rectangle = createSketchDrawElement("rectangle", { x: 10, y: 20 }, "#111111", 5)!;
    const sized = updateSketchDrawElement(rectangle, { x: 10, y: 20 }, { x: 110, y: 70 });
    const moved = moveSketchElement(sized, 40, 50);
    const resized = resizeSketchElement(moved, 40, 50, 1.5, 2);
    expect(resized).toMatchObject({ type: "rectangle", x: 40, y: 50, width: 150, height: 100 });

    const ellipse = updateSketchDrawElement(
      createSketchDrawElement("ellipse", { x: 0, y: 0 }, "#111111", 5)!,
      { x: 0, y: 0 },
      { x: 80, y: 40 },
    );
    expect(moveSketchElement(ellipse, 100, 100)).toMatchObject({ x: 60, y: 80 });
    expect(resizeSketchElement(ellipse, 100, 100, 2, 2)).toMatchObject({ x: 20, y: 60, width: 160, height: 80 });

    const line = updateSketchDrawElement(
      createSketchDrawElement("line", { x: 0, y: 0 }, "#111111", 5)!,
      { x: 0, y: 0 },
      { x: 40, y: 40 },
    );
    expect(resizeSketchElement(line, 20, 20, 2, 2)).toEqual(line);
  });

  test("caps export dimensions and creates stable timestamped names", () => {
    const dimensions = sketchExportDimensions(4096, 2048);
    expect(dimensions.width).toBe(SKETCH_EXPORT_MAX_PX);
    expect(dimensions.height).toBe(SKETCH_EXPORT_MAX_PX / 2);
    expect(sketchFilename(new Date(2026, 8, 17, 9, 5, 4))).toBe("sketch-20260917-090504.png");
  });
});
