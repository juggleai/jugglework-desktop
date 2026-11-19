import { expect, test } from "bun:test";
import {
  ANNOTATION_HISTORY_LIMIT, LASER_FADE_MS, commitAnnotation, createAnnotationHistory, createDrawElement, createTextElement,
  eraseElements, isMeaningful, laserOpacity, redoAnnotation, toNormalized, toPixels, undoAnnotation, updateDrawElement,
} from "../src/react-app/domains/annotation/annotation-model";

const size = { width: 1000, height: 500 };

test("coordinates are stored as 0-1 ratios of the screen and survive a resize", () => {
  const p = toNormalized({ x: 250, y: 125 }, size);
  expect(p).toEqual({ x: 0.25, y: 0.25 });
  expect(toPixels(p, { width: 2000, height: 1000 })).toEqual({ x: 500, y: 250 });
  // Pointer outside the canvas is clamped to the screen edge.
  expect(toNormalized({ x: -5, y: 900 }, size)).toEqual({ x: 0, y: 1 });
});

test("pen and highlighter keep every point; shapes keep two corners", () => {
  const pen = createDrawElement("pen", { x: 0.1, y: 0.1 }, "#ef4444", 4)!;
  const moved = updateDrawElement(updateDrawElement(pen, { x: 0.2, y: 0.2 }), { x: 0.3, y: 0.25 });
  expect(moved.type === "stroke" && moved.points).toEqual([0.1, 0.1, 0.2, 0.2, 0.3, 0.25]);
  const highlighter = createDrawElement("highlighter", { x: 0, y: 0 }, "#facc15", 4)!;
  expect(highlighter.type === "stroke" && highlighter.highlight).toBe(true);
  const rect = updateDrawElement(createDrawElement("rectangle", { x: 0.5, y: 0.5 }, "#000000", 2)!, { x: 0.2, y: 0.8 });
  expect(rect.type === "shape" && [rect.x1, rect.y1, rect.x2, rect.y2]).toEqual([0.5, 0.5, 0.2, 0.8]);
  const arrow = updateDrawElement(createDrawElement("arrow", { x: 0.1, y: 0.1 }, "#000000", 2)!, { x: 0.4, y: 0.1 });
  expect(arrow.type === "shape" && arrow.kind).toBe("arrow");
  expect(createDrawElement("text", { x: 0, y: 0 }, "#000000", 2)).toBeNull();
  expect(createDrawElement("eraser", { x: 0, y: 0 }, "#000000", 2)).toBeNull();
});

test("a click without movement is not committed", () => {
  const dot = createDrawElement("arrow", { x: 0.5, y: 0.5 }, "#000000", 2)!;
  expect(isMeaningful(dot, size)).toBe(false);
  expect(isMeaningful(updateDrawElement(dot, { x: 0.51, y: 0.5 }), size)).toBe(true);
  const pen = createDrawElement("pen", { x: 0.5, y: 0.5 }, "#000000", 2)!;
  expect(isMeaningful(pen, size)).toBe(false);
  expect(isMeaningful(updateDrawElement(pen, { x: 0.5, y: 0.5 }), size)).toBe(true);
});

test("text keeps its content, trims empty input and scales with the screen", () => {
  expect(createTextElement({ x: 0.2, y: 0.3 }, "   ", "#000000", 4)).toBeNull();
  const text = createTextElement({ x: 0.2, y: 0.3 }, " 重点  ", "#ef4444", 4)!;
  expect(text.text).toBe("重点");
  expect(text.fontSize).toBeGreaterThan(0);
  expect(text.fontSize).toBeLessThan(0.2);
});

test("undo, redo and clear form one bounded history", () => {
  let h = createAnnotationHistory();
  const a = createDrawElement("pen", { x: 0, y: 0 }, "#000000", 2)!, b = createDrawElement("pen", { x: 1, y: 1 }, "#000000", 2)!;
  h = commitAnnotation(h, [a]); h = commitAnnotation(h, [a, b]);
  h = undoAnnotation(h); expect(h.present).toEqual([a]);
  h = redoAnnotation(h); expect(h.present).toEqual([a, b]);
  h = commitAnnotation(h, []); expect(h.present).toEqual([]);
  h = undoAnnotation(h); expect(h.present).toEqual([a, b]);
  // A new edit drops the redo branch.
  h = commitAnnotation(undoAnnotation(h), [b]); expect(h.future).toEqual([]);
  // No-op commits do not create history entries.
  expect(commitAnnotation(h, [b])).toBe(h);
  for (let i = 0; i < ANNOTATION_HISTORY_LIMIT + 20; i++) h = commitAnnotation(h, [createDrawElement("pen", { x: 0, y: 0 }, "#000000", i + 1)!]);
  expect(h.past.length).toBe(ANNOTATION_HISTORY_LIMIT);
  expect(undoAnnotation(createAnnotationHistory())).toEqual(createAnnotationHistory());
});

test("eraser removes the hit elements only", () => {
  const a = createDrawElement("pen", { x: 0, y: 0 }, "#000000", 2)!, b = createDrawElement("pen", { x: 0, y: 0 }, "#000000", 2)!;
  expect(eraseElements([a, b], new Set([a.id]))).toEqual([b]);
});

test("laser trail is opaque while drawing and fades out after release", () => {
  expect(laserOpacity(null, 1000)).toBe(1);
  expect(laserOpacity(1000, 1000)).toBe(1);
  expect(laserOpacity(1000, 1000 + LASER_FADE_MS / 2)).toBeCloseTo(0.5, 5);
  expect(laserOpacity(1000, 1000 + LASER_FADE_MS + 1)).toBe(0);
});
