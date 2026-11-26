import {
  ANNOTATION_COLORS,
  ANNOTATION_STROKE_SIZE,
  LASER_FADE_MS,
  annotationElementHitTest,
  commitAnnotation,
  createAnnotationHistory,
  createDrawElement,
  eraseElements,
  isMeaningful,
  undoAnnotation,
  updateDrawElement,
  type AnnotationElement,
  type AnnotationHistory,
  type AnnotationToolState,
  type AnnotationStroke,
  type NormalizedPoint,
  type ScreenSize,
} from "../annotation/annotation-model";
import type { WindowAnnotationScene } from "./window-annotation-events";

export const SEMANTIC_ANNOTATION_LIMITS = { elements: 128, lasers: 32, pointsPerStroke: 256, scenePoints: 4096, batchPoints: 64, protocolBytes: 65536 } as const;
export const SEMANTIC_ANNOTATION_TOOLS = ["laser", "pen", "highlighter", "rectangle", "ellipse", "arrow", "eraser"] as const;

export type SemanticPointerBatch = {
  sessionId: string;
  epoch: number;
  inputSeq: number;
  phase: "down" | "move" | "up" | "cancel";
  points: NormalizedPoint[];
};

export type SemanticAnnotationOverlay = {
  sessionId: string;
  onInput(callback: (batch: SemanticPointerBatch) => void): () => void;
  setMode(mode: "pointer" | "draw", style?: { tool: SupportedTool; color: string; size: number; highlight: boolean }): Promise<{ ok: boolean; reason?: string }>;
  abort(): Promise<{ ok: boolean; reason?: string }>;
};

export type SemanticAnimationScheduler = {
  now(): number;
  request(callback: () => void): unknown;
  cancel(handle: unknown): void;
};

const defaultAnimationScheduler: SemanticAnimationScheduler = {
  now: () => performance.now(),
  request(callback) {
    return typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : setTimeout(callback, 16);
  },
  cancel(handle) {
    if (typeof cancelAnimationFrame === "function" && typeof handle === "number") cancelAnimationFrame(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

type SupportedTool = (typeof SEMANTIC_ANNOTATION_TOOLS)[number];

function supportedTool(value: AnnotationToolState): value is AnnotationToolState & { tool: SupportedTool } {
  return SEMANTIC_ANNOTATION_TOOLS.includes(value.tool as SupportedTool) && ANNOTATION_COLORS.includes(value.color as typeof ANNOTATION_COLORS[number]) &&
    Number.isFinite(value.size) && value.size > 0 && value.size <= 32;
}

function validBatch(batch: SemanticPointerBatch, sessionId: string) {
  return batch?.sessionId === sessionId && Number.isSafeInteger(batch.epoch) && batch.epoch >= 0 &&
    Number.isSafeInteger(batch.inputSeq) && batch.inputSeq > 0 && ["down", "move", "up", "cancel"].includes(batch.phase) &&
    Array.isArray(batch.points) && batch.points.length <= SEMANTIC_ANNOTATION_LIMITS.batchPoints &&
    batch.points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1) &&
    (batch.phase === "cancel" ? batch.points.length === 0 : batch.points.length > 0);
}

function nativeScene(elements: AnnotationElement[]) {
  let complexity = 0;
  const ids = new Set<string>();
  const output = [];
  for (const element of elements) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(element.id) || ids.has(element.id) || !ANNOTATION_COLORS.includes(element.color as typeof ANNOTATION_COLORS[number]) ||
        !Number.isFinite(element.size) || element.size <= 0 || element.size > 32) return null;
    ids.add(element.id);
    if (element.type === "stroke") {
      if (element.points.length < 4 || element.points.length % 2 || element.points.length / 2 > SEMANTIC_ANNOTATION_LIMITS.pointsPerStroke ||
          element.points.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return null;
      complexity += element.points.length / 2;
      const points: number[][] = [];
      for (let i = 0; i < element.points.length; i += 2) points.push([element.points[i], element.points[i + 1]]);
      output.push({ type: "stroke", id: element.id, color: element.color, size: element.size, highlight: element.highlight, points });
    } else {
      if (![element.x1, element.y1, element.x2, element.y2].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return null;
      complexity += 2;
      output.push({ type: "shape", id: element.id, kind: element.kind, color: element.color, size: element.size,
        x1: element.x1, y1: element.y1, x2: element.x2, y2: element.y2 });
    }
    if (complexity > SEMANTIC_ANNOTATION_LIMITS.scenePoints) return null;
  }
  if (output.length > SEMANTIC_ANNOTATION_LIMITS.elements) return null;
  const value = { elements: output };
  const worstCaseEnvelope = { version: 1, sessionId: "x".repeat(64), seq: Number.MAX_SAFE_INTEGER,
    expectedEpoch: 2147483647, command: "scene", ...value };
  return new TextEncoder().encode(JSON.stringify(worstCaseEnvelope)).byteLength <= SEMANTIC_ANNOTATION_LIMITS.protocolBytes ? value : null;
}

export function createMeetingSemanticAnnotationSession({ overlay, size, onScene, onFailure = () => {}, animation = defaultAnimationScheduler }: {
  overlay: SemanticAnnotationOverlay;
  size: ScreenSize;
  onScene(scene: WindowAnnotationScene, committed: boolean, preview?: { hiddenElementIds: string[]; epoch: number }, laserEpoch?: number): void;
  onFailure?(reason: string): void;
  animation?: SemanticAnimationScheduler;
}) {
  let history: AnnotationHistory = createAnnotationHistory();
  let draft: AnnotationElement | null = null;
  let erasedIds = new Set<string>();
  let lasers: { stroke: AnnotationStroke; releasedAt: number | null }[] = [];
  let laserFrame: unknown;
  let tool: AnnotationToolState = { tool: "pen", color: ANNOTATION_COLORS[0], size: ANNOTATION_STROKE_SIZE };
  let epoch = -1, inputSeq = 0, disposed = false, failure: string | null = null;
  let writes = Promise.resolve<{ ok: boolean; reason?: string }>({ ok: true });

  const elements = () => draft ? [...history.present, draft] : erasedIds.size ? eraseElements(history.present, erasedIds) : history.present;
  const reportFailure = (reason: string) => {
    failure = reason;
    try { onFailure(reason); } catch { /* observers cannot break protocol serialization */ }
  };
  const visibleLasers = (now = animation.now()) => lasers.map(({ stroke, releasedAt }) => ({ stroke, opacity: releasedAt === null ? 1 : Math.max(0, 1 - (now - releasedAt) / LASER_FADE_MS) }));
  const notify = (committed = false, preview?: { hiddenElementIds: string[]; epoch: number }, laserEpoch?: number) => { try {
    onScene({ size, elements: elements(), lasers: visibleLasers() }, committed, preview ?? (!committed && erasedIds.size ? { hiddenElementIds: [...erasedIds], epoch } : undefined), laserEpoch);
  } catch { /* listener isolation */ } };
  const stopLaserFrame = () => { if (laserFrame !== undefined) animation.cancel(laserFrame); laserFrame = undefined; };
  const clearLasers = (notifyChange = true, atEpoch = epoch) => {
    stopLaserFrame();
    if (!lasers.length) return false;
    lasers = [];
    if (notifyChange) notify(false, undefined, atEpoch);
    return true;
  };
  const animateLasers = (boundEpoch: number) => {
    stopLaserFrame();
    const tick = () => {
      laserFrame = undefined;
      if (disposed || boundEpoch !== epoch) return;
      const now = animation.now();
      lasers = lasers.filter(laser => laser.releasedAt === null || now - laser.releasedAt < LASER_FADE_MS);
      notify(false, undefined, boundEpoch);
      if (lasers.some(laser => laser.releasedAt !== null)) laserFrame = animation.request(tick);
    };
    laserFrame = animation.request(tick);
  };
  const enqueue = (write: () => Promise<{ ok: boolean; reason?: string }>) => {
    writes = writes.then(async () => {
      if (disposed) return { ok: false, reason: "disposed" };
      try {
        const result = await write();
        if (!result.ok) reportFailure(result.reason ?? "native-unavailable");
        return result;
      } catch { reportFailure("native-write-failed"); return { ok: false, reason: "native-write-failed" }; }
    });
    return writes;
  };
  const abort = () => enqueue(() => overlay.abort());
  const publishCommitted = (next: AnnotationHistory) => {
    if (next === history) { notify(true); return true; }
    const scene = nativeScene(next.present);
    if (!scene) { reportFailure("scene-limit"); return false; }
    history = next;
    notify(true);
    return true;
  };
  const cancel = (sendAbort = false) => {
    if (draft || erasedIds.size) { const restoring = erasedIds.size > 0; draft = null; erasedIds = new Set(); notify(false, restoring ? { hiddenElementIds: [], epoch } : undefined); }
    clearLasers(true);
    if (sendAbort) abort();
  };
  const eraseAt = (points: NormalizedPoint[]) => {
    let changed = false;
    for (const point of points) for (const element of history.present) {
      if (!erasedIds.has(element.id) && annotationElementHitTest(element, point, size)) { erasedIds.add(element.id); changed = true; }
    }
    return changed;
  };
  const append = (points: NormalizedPoint[]) => {
    for (const point of points) {
      if (!draft || (draft.type === "stroke" && draft.points.length / 2 >= SEMANTIC_ANNOTATION_LIMITS.pointsPerStroke)) return false;
      draft = updateDrawElement(draft, point);
    }
    return true;
  };
  const receive = (batch: SemanticPointerBatch) => {
    if (disposed || !validBatch(batch, overlay.sessionId) || batch.epoch < epoch) return;
    if (inputSeq && batch.inputSeq !== inputSeq + 1) { inputSeq = batch.inputSeq; cancel(true); epoch = Math.max(epoch, batch.epoch); return; }
    if (batch.inputSeq <= inputSeq) return;
    inputSeq = batch.inputSeq;
    if (batch.epoch > epoch) { cancel(); epoch = batch.epoch; }
    if (batch.phase === "cancel") { cancel(); return; }
    if (batch.phase === "down") {
      if (tool.tool === "laser") {
        draft = null; erasedIds = new Set();
      } else cancel();
      if (!supportedTool(tool) || (tool.tool !== "eraser" && tool.tool !== "laser" && history.present.length >= SEMANTIC_ANNOTATION_LIMITS.elements)) return;
      if (tool.tool === "eraser") { eraseAt(batch.points); notify(); return; }
      draft = createDrawElement(tool.tool, batch.points[0], tool.color, tool.size);
      if (!draft || !append(batch.points.slice(1))) { cancel(); return; }
      if (tool.tool === "laser" && draft.type === "stroke") {
        lasers = [...lasers.slice(-(SEMANTIC_ANNOTATION_LIMITS.lasers - 1)), { stroke: draft, releasedAt: null }];
        draft = null;
        notify(false, undefined, epoch);
      } else notify();
      return;
    }
    if (tool.tool === "laser") {
      const active = lasers.at(-1);
      if (!active || active.releasedAt !== null) { cancel(true); return; }
      draft = active.stroke;
      if (!append(batch.points) || draft.type !== "stroke") { draft = null; cancel(true); return; }
      active.stroke = draft; draft = null;
      if (batch.phase === "move") { notify(false, undefined, epoch); return; }
      active.releasedAt = animation.now();
      notify(false, undefined, epoch);
      animateLasers(epoch);
      return;
    }
    if (tool.tool === "eraser") {
      const changed = eraseAt(batch.points);
      if (batch.phase === "move") { if (changed) notify(); return; }
      const hidden = erasedIds;
      erasedIds = new Set();
      if (hidden.size) publishCommitted(commitAnnotation(history, eraseElements(history.present, hidden)));
      else notify();
      return;
    }
    if (!draft || !append(batch.points)) { cancel(true); return; }
    if (batch.phase === "move") { notify(); return; }
    const completed = draft;
    draft = null;
    if (!isMeaningful(completed, size)) { notify(); return; }
    publishCommitted(commitAnnotation(history, [...history.present, completed]));
  };
  const unsubscribe = overlay.onInput(receive);

  return {
    supportedTools: SEMANTIC_ANNOTATION_TOOLS,
    getScene: (): WindowAnnotationScene => ({ size, elements: elements(), lasers: visibleLasers() }),
    getHistory: () => ({ canUndo: history.past.length > 0, canClear: history.present.length > 0 }),
    async setTool(next: AnnotationToolState) {
      if (!supportedTool(next)) return { ok: false, reason: "unsupported-tool" as const };
      cancel(true); tool = next;
      const result = await enqueue(() => overlay.setMode("draw", { tool: next.tool, color: next.color, size: next.size, highlight: next.tool === "highlighter" }));
      return result.ok ? { ok: true as const } : { ok: false as const, reason: "native-unavailable" as const };
    },
    async setPointer() { cancel(true); return enqueue(() => overlay.setMode("pointer")); },
    undo() { publishCommitted(undoAnnotation(history)); },
    clear() { cancel(true); publishCommitted(commitAnnotation(history, [])); },
    clearTransient(nextEpoch = epoch) { if (nextEpoch > epoch) epoch = nextEpoch; clearLasers(true, epoch); },
    async flush() { await writes; return failure ? { ok: false as const, reason: failure } : { ok: true as const }; },
    dispose() {
      if (disposed) return;
      draft = null; lasers = []; stopLaserFrame(); disposed = true; unsubscribe();
      writes = writes.then(async () => {
        try { const result = await overlay.abort(); if (!result.ok) reportFailure(result.reason ?? "native-unavailable"); return result; }
        catch { reportFailure("native-write-failed"); return { ok: false, reason: "native-write-failed" }; }
      });
    },
  };
}
