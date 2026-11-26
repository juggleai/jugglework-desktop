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
  if (element.type === "stroke") {
    if (element.points.length < 4) return false;
    const x = element.points[0], y = element.points[1];
    for (let i = 2; i < element.points.length; i += 2) {
      if (Math.hypot((element.points[i] - x) * size.width, (element.points[i + 1] - y) * size.height) >= 3) return true;
    }
    return false;
  }
  const dx = (element.x2 - element.x1) * size.width, dy = (element.y2 - element.y1) * size.height;
  return element.kind === "arrow" ? Math.hypot(dx, dy) >= 3 : Math.abs(dx) >= 3 && Math.abs(dy) >= 3;
}

export function eraseElements(elements: AnnotationElement[], ids: Set<string>) {
  return elements.filter((element) => !ids.has(element.id));
}

function pointSegmentDistanceSquared(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
}

function pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const cross = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
    (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = cross(px, py, ax, ay, bx, by), d2 = cross(px, py, bx, by, cx, cy), d3 = cross(px, py, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Pure semantic eraser hit test in viewport pixels. It deliberately tests the
 * stored stroke polyline rather than Konva's tension-generated Bezier curve. */
export function annotationElementHitTest(element: AnnotationElement, point: NormalizedPoint, size: ScreenSize, tolerance = 6) {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0 ||
      !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(tolerance)) return false;
  const width = Math.min(size.width, 1_000_000), height = Math.min(size.height, 1_000_000);
  const px = point.x * width, py = point.y * height;
  const strokeWidth = Math.max(0, Math.min(1024, element.size * (element.type === "stroke" && element.highlight ? 4 : 1)));
  const radius = Math.max(0, Math.min(4096, tolerance)) + strokeWidth / 2;
  const hitSegment = (ax: number, ay: number, bx: number, by: number) => {
    if (px < Math.min(ax, bx) - radius || px > Math.max(ax, bx) + radius || py < Math.min(ay, by) - radius || py > Math.max(ay, by) + radius) return false;
    return pointSegmentDistanceSquared(px, py, ax, ay, bx, by) <= radius * radius;
  };
  if (element.type === "stroke") {
    for (let i = 2; i < element.points.length; i += 2) {
      if (hitSegment(element.points[i - 2] * width, element.points[i - 1] * height, element.points[i] * width, element.points[i + 1] * height)) return true;
    }
    return false;
  }
  const x1 = element.x1 * width, y1 = element.y1 * height, x2 = element.x2 * width, y2 = element.y2 * height;
  if (element.kind === "rectangle") {
    const left = Math.min(x1, x2), right = Math.max(x1, x2), top = Math.min(y1, y2), bottom = Math.max(y1, y2);
    return hitSegment(left, top, right, top) || hitSegment(right, top, right, bottom) ||
      hitSegment(right, bottom, left, bottom) || hitSegment(left, bottom, left, top);
  }
  if (element.kind === "ellipse") {
    const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2, cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    if (rx === 0 || ry === 0) return hitSegment(x1, y1, x2, y2);
    const dx = px - cx, dy = py - cy, distance = Math.hypot(dx, dy);
    if (distance === 0) return Math.min(rx, ry) <= radius;
    const boundaryScale = 1 / Math.sqrt((dx / distance / rx) ** 2 + (dy / distance / ry) ** 2);
    return Math.abs(distance - boundaryScale) <= radius;
  }
  const angle = Math.atan2(y2 - y1, x2 - x1), head = Math.max(12, strokeWidth * 3.5), half = head / 2;
  const lx = x2 - head * Math.cos(angle) - half * Math.sin(angle), ly = y2 - head * Math.sin(angle) + half * Math.cos(angle);
  const rx = x2 - head * Math.cos(angle) + half * Math.sin(angle), ry = y2 - head * Math.sin(angle) - half * Math.cos(angle);
  return hitSegment(x1, y1, x2, y2) || hitSegment(x2, y2, lx, ly) || hitSegment(x2, y2, rx, ry) ||
    pointInTriangle(px, py, x2, y2, lx, ly, rx, ry);
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
  return Math.max(0, Math.min(1, 1 - (now - releasedAt) / LASER_FADE_MS));
}
