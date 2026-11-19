// Screen annotation model. Every coordinate is a 0-1 ratio of the annotated
// screen, so strokes stay in place when the display is resized or the window
// is rebuilt (and phase two can apply remote strokes directly).

export const ANNOTATION_HISTORY_LIMIT = 80;
export const LASER_FADE_MS = 1200;

export type AnnotationTool = "pen" | "highlighter" | "laser" | "line" | "arrow" | "rectangle" | "ellipse" | "text" | "eraser";
export type AnnotationMode = "draw" | "pointer";
export type AnnotationToolState = { tool: AnnotationTool; color: string; size: number };
export type AnnotationState = { mode: AnnotationMode; tool: AnnotationToolState; history: { canUndo: boolean; canRedo: boolean } };

export type NormalizedPoint = { x: number; y: number };
export type ScreenSize = { width: number; height: number };

type Base = { id: string; color: string; size: number };
export type AnnotationStroke = Base & { type: "stroke"; highlight: boolean; points: number[] };
export type AnnotationShape = Base & { type: "shape"; kind: "line" | "arrow" | "rectangle" | "ellipse"; x1: number; y1: number; x2: number; y2: number };
/** fontSize is a ratio of the screen height. */
export type AnnotationText = Base & { type: "text"; x: number; y: number; text: string; fontSize: number };
export type AnnotationElement = AnnotationStroke | AnnotationShape | AnnotationText;

export type AnnotationHistory = { past: AnnotationElement[][]; present: AnnotationElement[]; future: AnnotationElement[][] };

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function createAnnotationId(prefix: string) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

export function toNormalized(point: { x: number; y: number }, size: ScreenSize): NormalizedPoint {
  return { x: clamp01(point.x / Math.max(1, size.width)), y: clamp01(point.y / Math.max(1, size.height)) };
}

export function toPixels(point: NormalizedPoint, size: ScreenSize) {
  return { x: point.x * size.width, y: point.y * size.height };
}

export function createDrawElement(tool: AnnotationTool, point: NormalizedPoint, color: string, size: number): AnnotationElement | null {
  if (tool === "pen" || tool === "highlighter" || tool === "laser")
    return { id: createAnnotationId(tool), type: "stroke", highlight: tool === "highlighter", points: [point.x, point.y], color, size };
  if (tool === "line" || tool === "arrow" || tool === "rectangle" || tool === "ellipse")
    return { id: createAnnotationId(tool), type: "shape", kind: tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color, size };
  return null;
}

export function updateDrawElement(element: AnnotationElement, point: NormalizedPoint): AnnotationElement {
  if (element.type === "stroke") return { ...element, points: [...element.points, point.x, point.y] };
  if (element.type === "shape") return { ...element, x2: point.x, y2: point.y };
  return element;
}

/** Clicks and zero-length drags are dropped instead of committed. */
export function isMeaningful(element: AnnotationElement, size: ScreenSize) {
  if (element.type === "stroke") return element.points.length >= 4;
  if (element.type === "shape") {
    const dx = (element.x2 - element.x1) * size.width, dy = (element.y2 - element.y1) * size.height;
    return element.kind === "line" || element.kind === "arrow" ? Math.hypot(dx, dy) >= 3 : Math.abs(dx) >= 3 && Math.abs(dy) >= 3;
  }
  return element.text.length > 0;
}

/** Brush size maps to a font size of roughly 2-3.5% of the screen height. */
export function annotationFontSize(size: number) {
  return Math.min(0.08, 0.018 + size * 0.0018);
}

export function createTextElement(point: NormalizedPoint, text: string, color: string, size: number): AnnotationText | null {
  const value = text.trim();
  if (!value) return null;
  const fontSize = annotationFontSize(size);
  return { id: createAnnotationId("text"), type: "text", x: point.x, y: point.y, text: value, fontSize, color, size };
}

export function eraseElements(elements: AnnotationElement[], ids: Set<string>) {
  return elements.filter((element) => !ids.has(element.id));
}

export function createAnnotationHistory(): AnnotationHistory {
  return { past: [], present: [], future: [] };
}

export function commitAnnotation(history: AnnotationHistory, elements: AnnotationElement[], limit = ANNOTATION_HISTORY_LIMIT): AnnotationHistory {
  if (elements === history.present || JSON.stringify(elements) === JSON.stringify(history.present)) return history;
  const past = [...history.past, history.present];
  return { past: past.slice(Math.max(0, past.length - limit)), present: elements, future: [] };
}

export function undoAnnotation(history: AnnotationHistory): AnnotationHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redoAnnotation(history: AnnotationHistory): AnnotationHistory {
  const next = history.future[0];
  if (!next) return history;
  return { past: [...history.past, history.present].slice(-ANNOTATION_HISTORY_LIMIT), present: next, future: history.future.slice(1) };
}

/** Laser trails stay opaque while drawn (releasedAt null), then fade linearly. */
export function laserOpacity(releasedAt: number | null, now: number) {
  if (releasedAt === null) return 1;
  return Math.max(0, 1 - (now - releasedAt) / LASER_FADE_MS);
}
