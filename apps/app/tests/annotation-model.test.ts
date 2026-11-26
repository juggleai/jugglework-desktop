import { expect, test } from "bun:test";
import {
  ANNOTATION_COLORS, ANNOTATION_HISTORY_LIMIT, LASER_FADE_MS, commitAnnotation, createAnnotationHistory, createDrawElement,
  annotationElementHitTest, eraseElements, isMeaningful, laserOpacity, toNormalized, toPixels, undoAnnotation, updateDrawElement,
} from "../src/react-app/domains/annotation/annotation-model";

const size = { width: 1000, height: 500 };

test("coordinates are stored as 0-1 ratios of the screen and survive a resize", () => {
  const p = toNormalized({ x: 250, y: 125 }, size);
  expect(p).toEqual({ x: 0.25, y: 0.25 });
  expect(toPixels(p, { width: 2000, height: 1000 })).toEqual({ x: 500, y: 250 });
  // Pointer outside the canvas is clamped to the screen edge.
  expect(toNormalized({ x: -5, y: 900 }, size)).toEqual({ x: 0, y: 1 });
});

test("pen, highlighter, and laser keep every point; shapes keep two corners", () => {
  const pen = createDrawElement("pen", { x: 0.1, y: 0.1 }, "#ef4444", 4)!;
  const moved = updateDrawElement(updateDrawElement(pen, { x: 0.2, y: 0.2 }), { x: 0.3, y: 0.25 });
  expect(moved.type === "stroke" && moved.points).toEqual([0.1, 0.1, 0.2, 0.2, 0.3, 0.25]);
  const highlighter = createDrawElement("highlighter", { x: 0, y: 0 }, "#facc15", 4)!;
  expect(highlighter.type === "stroke" && highlighter.highlight).toBe(true);
  const laser = updateDrawElement(createDrawElement("laser", { x: 0.2, y: 0.3 }, "#ef4444", 4)!, { x: 0.4, y: 0.6 });
  expect(laser).toMatchObject({ type: "stroke", highlight: false, points: [0.2, 0.3, 0.4, 0.6] });
  const rect = updateDrawElement(createDrawElement("rectangle", { x: 0.5, y: 0.5 }, "#000000", 2)!, { x: 0.2, y: 0.8 });
  expect(rect.type === "shape" && [rect.x1, rect.y1, rect.x2, rect.y2]).toEqual([0.5, 0.5, 0.2, 0.8]);
  const arrow = updateDrawElement(createDrawElement("arrow", { x: 0.1, y: 0.1 }, "#000000", 2)!, { x: 0.4, y: 0.1 });
  expect(arrow.type === "shape" && arrow.kind).toBe("arrow");
  const ellipse = createDrawElement("ellipse", { x: 0.1, y: 0.1 }, "#000000", 2)!;
  expect(ellipse.type === "shape" && ellipse.kind).toBe("ellipse");
  // The mouse and the eraser do not create elements.
  expect(createDrawElement("pointer", { x: 0, y: 0 }, "#000000", 2)).toBeNull();
  expect(createDrawElement("eraser", { x: 0, y: 0 }, "#000000", 2)).toBeNull();
});

test("the palette matches Feishu: red, yellow, green, blue, purple", () => {
  expect([...ANNOTATION_COLORS]).toEqual(["#ef4444", "#facc15", "#22c55e", "#3b82f6", "#a855f7"]);
});

test("a click or repeated sample without movement is not committed", () => {
  const dot = createDrawElement("arrow", { x: 0.5, y: 0.5 }, "#000000", 2)!;
  expect(isMeaningful(dot, size)).toBe(false);
  expect(isMeaningful(updateDrawElement(dot, { x: 0.51, y: 0.5 }), size)).toBe(true);
  const pen = createDrawElement("pen", { x: 0.5, y: 0.5 }, "#000000", 2)!;
  expect(isMeaningful(pen, size)).toBe(false);
  expect(isMeaningful(updateDrawElement(pen, { x: 0.5, y: 0.5 }), size)).toBe(false);
  expect(isMeaningful(updateDrawElement(pen, { x: 0.503, y: 0.5 }), size)).toBe(true);
});

test("undo and clear form one bounded history", () => {
  let h = createAnnotationHistory();
  const a = createDrawElement("pen", { x: 0, y: 0 }, "#000000", 2)!, b = createDrawElement("pen", { x: 1, y: 1 }, "#000000", 2)!;
  h = commitAnnotation(h, [a]); h = commitAnnotation(h, [a, b]);
  h = undoAnnotation(h); expect(h.present).toEqual([a]);
  h = commitAnnotation(h, [a, b]);
  // Clear is one step, so undo brings the strokes back.
  h = commitAnnotation(h, []); expect(h.present).toEqual([]);
  h = undoAnnotation(h); expect(h.present).toEqual([a, b]);
  // No-op commits do not create history entries.
  expect(commitAnnotation(h, [a, b])).toBe(h);
  for (let i = 0; i < ANNOTATION_HISTORY_LIMIT + 20; i++) h = commitAnnotation(h, [createDrawElement("pen", { x: 0, y: 0 }, "#000000", i + 1)!]);
  expect(h.past.length).toBe(ANNOTATION_HISTORY_LIMIT);
  expect(undoAnnotation(createAnnotationHistory())).toEqual(createAnnotationHistory());
});

test("eraser removes the hit elements only", () => {
  const rectangle = createDrawElement("rectangle", { x: 0, y: 0 }, "#000000", 2)!;
  const ellipse = createDrawElement("ellipse", { x: 0, y: 0 }, "#000000", 2)!;
  const arrow = createDrawElement("arrow", { x: 0, y: 0 }, "#000000", 2)!;
  expect(eraseElements([rectangle, ellipse, arrow], new Set([rectangle.id, arrow.id]))).toEqual([ellipse]);
  expect(createDrawElement("eraser", { x: 0, y: 0 }, "#000000", 2)).toBeNull();
});

test("semantic eraser hit vectors cover polyline, outline-only shapes, arrow fill and reversed geometry", () => {
  const stroke = { id: "s", type: "stroke", color: "#000000", size: 4, highlight: false, points: [.1, .1, .5, .1, .5, .5] } as const;
  const rectangle = { id: "r", type: "shape", kind: "rectangle", color: "#000000", size: 4, x1: .8, y1: .8, x2: .2, y2: .2 } as const;
  const ellipse = { id: "e", type: "shape", kind: "ellipse", color: "#000000", size: 4, x1: .8, y1: .8, x2: .2, y2: .2 } as const;
  const arrow = { id: "a", type: "shape", kind: "arrow", color: "#000000", size: 4, x1: .8, y1: .5, x2: .2, y2: .5 } as const;
  expect(annotationElementHitTest(stroke, { x: .3, y: .108 }, size, 2)).toBe(true);
  expect(annotationElementHitTest(stroke, { x: .3, y: .2 }, size, 2)).toBe(false);
  expect(annotationElementHitTest(rectangle, { x: .5, y: .2 }, size, 2)).toBe(true);
  expect(annotationElementHitTest(rectangle, { x: .5, y: .5 }, size, 2)).toBe(false);
  expect(annotationElementHitTest(ellipse, { x: .5, y: .2 }, size, 2)).toBe(true);
  expect(annotationElementHitTest(ellipse, { x: .5, y: .5 }, size, 2)).toBe(false);
  expect(annotationElementHitTest(arrow, { x: .5, y: .5 }, size, 2)).toBe(true);
  expect(annotationElementHitTest(arrow, { x: .205, y: .49 }, size, 4)).toBe(true);
});

test("semantic eraser hit test is bounded for degenerate and extreme inputs", () => {
  const degenerate = { id: "d", type: "shape", kind: "ellipse", color: "#000000", size: 32, x1: .5, y1: .1, x2: .5, y2: .9 } as const;
  expect(annotationElementHitTest(degenerate, { x: .5, y: .5 }, { width: 1e300, height: 1e300 }, 1e300)).toBe(true);
  expect(annotationElementHitTest(degenerate, { x: .5, y: .5 }, { width: 0, height: 100 }, 2)).toBe(false);
  expect(annotationElementHitTest(degenerate, { x: Number.NaN, y: .5 }, size, 2)).toBe(false);
});

test("laser trail is opaque while drawing and fades out after release", () => {
  expect(laserOpacity(null, 1000)).toBe(1);
  expect(laserOpacity(1000, 1000)).toBe(1);
  expect(laserOpacity(1000, 1000 + LASER_FADE_MS / 2)).toBeCloseTo(0.5, 5);
  expect(laserOpacity(1000, 1000 + LASER_FADE_MS + 1)).toBe(0);
});
