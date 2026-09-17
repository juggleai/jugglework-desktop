export const SKETCH_LOGICAL_WIDTH = 1600;
export const SKETCH_LOGICAL_HEIGHT = 1000;
export const SKETCH_HISTORY_LIMIT = 80;
export const SKETCH_EXPORT_MAX_PX = 2048;
export const SKETCH_TEXT_WIDTH = 420;
export const SKETCH_TEXT_MIN_FONT_SIZE = 24;

export type SketchTool =
  | "select"
  | "pen"
  | "text"
  | "line"
  | "arrow"
  | "rectangle"
  | "ellipse"
  | "eraser";

type SketchElementBase = {
  id: string;
  x: number;
  y: number;
  color: string;
  strokeWidth: number;
};

export type SketchStrokeElement = SketchElementBase & {
  type: "stroke";
  points: number[];
};

export type SketchTextElement = SketchElementBase & {
  type: "text";
  text: string;
  fontSize: number;
  width: number;
};

export type SketchLineElement = SketchElementBase & {
  type: "line";
  points: [number, number, number, number];
};

export type SketchArrowElement = SketchElementBase & {
  type: "arrow";
  points: [number, number, number, number];
};

export type SketchShapeElement = SketchElementBase & {
  type: "rectangle";
  width: number;
  height: number;
};

export type SketchEllipseElement = SketchElementBase & {
  type: "ellipse";
  width: number;
  height: number;
};

export type SketchElement =
  | SketchStrokeElement
  | SketchTextElement
  | SketchLineElement
  | SketchArrowElement
  | SketchShapeElement
  | SketchEllipseElement;

export type SketchPoint = { x: number; y: number };

export type SketchHistory = {
  past: SketchElement[][];
  present: SketchElement[];
  future: SketchElement[][];
};

export function createSketchId(prefix = "sketch") {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function cloneSketchElements(elements: SketchElement[]): SketchElement[] {
  return elements.map((element) => {
    if (element.type === "stroke" || element.type === "line" || element.type === "arrow") {
      return { ...element, points: [...element.points] } as SketchElement;
    }
    return { ...element };
  });
}

function sketchElementsEqual(left: SketchElement[], right: SketchElement[]) {
  if (left.length !== right.length) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createSketchHistory(elements: SketchElement[] = []): SketchHistory {
  return { past: [], present: cloneSketchElements(elements), future: [] };
}

export function commitSketchHistory(
  history: SketchHistory,
  elements: SketchElement[],
  limit = SKETCH_HISTORY_LIMIT,
): SketchHistory {
  if (sketchElementsEqual(history.present, elements)) return history;
  const past = [...history.past, cloneSketchElements(history.present)];
  const boundedPast = past.slice(Math.max(0, past.length - Math.max(1, limit)));
  return {
    past: boundedPast,
    present: cloneSketchElements(elements),
    future: [],
  };
}

export function undoSketchHistory(history: SketchHistory): SketchHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: cloneSketchElements(previous),
    future: [cloneSketchElements(history.present), ...history.future],
  };
}

export function redoSketchHistory(history: SketchHistory): SketchHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, cloneSketchElements(history.present)].slice(-SKETCH_HISTORY_LIMIT),
    present: cloneSketchElements(next),
    future: history.future.slice(1),
  };
}

export function replaceSketchElement(
  elements: SketchElement[],
  id: string,
  update: (element: SketchElement) => SketchElement,
) {
  return elements.map((element) => element.id === id ? update(element) : element);
}

export function removeSketchElements(elements: SketchElement[], ids: Iterable<string>) {
  const removed = new Set(ids);
  return elements.filter((element) => !removed.has(element.id));
}

export function isSketchEmpty(elements: SketchElement[]) {
  return elements.length === 0;
}

export function normalizeShapeBounds(startX: number, startY: number, endX: number, endY: number) {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function createSketchDrawElement(
  tool: SketchTool,
  point: SketchPoint,
  color: string,
  strokeWidth: number,
): SketchElement | null {
  const common = {
    id: createSketchId(tool),
    x: point.x,
    y: point.y,
    color,
    strokeWidth,
  };
  if (tool === "pen") return { ...common, type: "stroke", points: [0, 0, 0, 0] };
  if (tool === "line" || tool === "arrow") return { ...common, type: tool, points: [0, 0, 0, 0] };
  if (tool === "rectangle" || tool === "ellipse") return { ...common, type: tool, width: 0, height: 0 };
  return null;
}

export function updateSketchDrawElement(
  element: SketchElement,
  start: SketchPoint,
  point: SketchPoint,
): SketchElement {
  if (element.type === "stroke") {
    return { ...element, points: [...element.points, point.x - start.x, point.y - start.y] };
  }
  if (element.type === "line" || element.type === "arrow") {
    return { ...element, points: [0, 0, point.x - start.x, point.y - start.y] };
  }
  if (element.type === "rectangle" || element.type === "ellipse") {
    return { ...element, ...normalizeShapeBounds(start.x, start.y, point.x, point.y) };
  }
  return element;
}

export function createSketchTextElement(
  point: SketchPoint,
  text: string,
  color: string,
  strokeWidth: number,
): SketchTextElement | null {
  const value = text.trim();
  if (!value) return null;
  return {
    id: createSketchId("text"),
    type: "text",
    x: point.x,
    y: point.y,
    text: value,
    fontSize: Math.max(SKETCH_TEXT_MIN_FONT_SIZE, strokeWidth * 6),
    width: SKETCH_TEXT_WIDTH,
    color,
    strokeWidth,
  };
}

export function isMeaningfulSketchElement(element: SketchElement) {
  if (element.type === "stroke") return element.points.length >= 4;
  if (element.type === "line" || element.type === "arrow") {
    const [x1, y1, x2, y2] = element.points;
    return Math.hypot(x2 - x1, y2 - y1) >= 3;
  }
  if (element.type === "rectangle" || element.type === "ellipse") {
    return element.width >= 3 && element.height >= 3;
  }
  return element.text.trim().length > 0;
}

export function moveSketchElement(element: SketchElement, x: number, y: number): SketchElement {
  if (element.type === "ellipse") {
    return { ...element, x: x - element.width / 2, y: y - element.height / 2 };
  }
  return { ...element, x, y };
}

export function resizeSketchElement(
  element: SketchElement,
  x: number,
  y: number,
  scaleX: number,
  scaleY: number,
): SketchElement {
  if (element.type === "ellipse") {
    return {
      ...element,
      x: x - (element.width * scaleX) / 2,
      y: y - (element.height * scaleY) / 2,
      width: Math.max(5, element.width * scaleX),
      height: Math.max(5, element.height * scaleY),
    };
  }
  if (element.type === "rectangle") {
    return {
      ...element,
      x,
      y,
      width: Math.max(5, element.width * scaleX),
      height: Math.max(5, element.height * scaleY),
    };
  }
  if (element.type === "text") {
    return {
      ...element,
      x,
      y,
      width: Math.max(80, element.width * scaleX),
      fontSize: Math.max(12, element.fontSize * scaleY),
    };
  }
  return element;
}

export function sketchExportDimensions(width = SKETCH_LOGICAL_WIDTH, height = SKETCH_LOGICAL_HEIGHT) {
  const maxDimension = Math.max(width, height);
  const scale = maxDimension > SKETCH_EXPORT_MAX_PX ? SKETCH_EXPORT_MAX_PX / maxDimension : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

export function sketchFilename(date = new Date()) {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `sketch-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`;
}
