// Screen annotation model. Every coordinate is a 0-1 ratio of the annotated
// screen, so strokes stay in place when the display is resized or the window
// is rebuilt (and phase two can apply remote strokes directly).
// The tool set follows Feishu meetings: mouse, laser, pen, highlighter,
// ellipse, rectangle, arrow, eraser; five colors; undo and clear.

export const ANNOTATION_HISTORY_LIMIT = 80;
export const LASER_FADE_MS = 1200;
/** Feishu has no thickness picker; every stroke uses one width. */
export const ANNOTATION_STROKE_SIZE = 4;
/** Feishu: red, yellow, green, blue, purple. */
export const ANNOTATION_COLORS = ["#ef4444", "#facc15", "#22c55e", "#3b82f6", "#a855f7"] as const;

export type AnnotationTool = "pointer" | "laser" | "pen" | "highlighter" | "ellipse" | "rectangle" | "arrow" | "eraser";
/** Derived from the tool: "pointer" passes the mouse through to the apps below. */
export type AnnotationMode = "draw" | "pointer";
export type AnnotationToolState = { tool: AnnotationTool; color: string; size: number };
export type AnnotationHistoryState = { canUndo: boolean; canClear: boolean };
export type AnnotationState = { mode: AnnotationMode; tool: AnnotationToolState; history: AnnotationHistoryState };

export type NormalizedPoint = { x: number; y: number };
export type ScreenSize = { width: number; height: number };

type Base = { id: string; color: string; size: number };
export type AnnotationStroke = Base & { type: "stroke"; highlight: boolean; points: number[] };
export type AnnotationShape = Base & { type: "shape"; kind: "arrow" | "rectangle" | "ellipse"; x1: number; y1: number; x2: number; y2: number };
export type AnnotationElement = AnnotationStroke | AnnotationShape;

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
  if (tool === "arrow" || tool === "rectangle" || tool === "ellipse")
    return { id: createAnnotationId(tool), type: "shape", kind: tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color, size };
  return null;
}

export function updateDrawElement(element: AnnotationElement, point: NormalizedPoint): AnnotationElement {
  if (element.type === "stroke") return { ...element, points: [...element.points, point.x, point.y] };
  return { ...element, x2: point.x, y2: point.y };
}

/** Clicks and zero-length drags are dropped instead of committed. */
export function isMeaningful(element: AnnotationElement, size: ScreenSize) {
  if (element.type === "stroke") return element.points.length >= 4;
  const dx = (element.x2 - element.x1) * size.width, dy = (element.y2 - element.y1) * size.height;
  return element.kind === "arrow" ? Math.hypot(dx, dy) >= 3 : Math.abs(dx) >= 3 && Math.abs(dy) >= 3;
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

/** Laser trails stay opaque while drawn (releasedAt null), then fade linearly. */
export function laserOpacity(releasedAt: number | null, now: number) {
  if (releasedAt === null) return 1;
  return Math.max(0, 1 - (now - releasedAt) / LASER_FADE_MS);
}
