/** @jsxImportSource react */
// Transparent full-screen annotation canvas. It is captured by the whole-screen
// share, so only strokes are drawn (no background) and it redraws only when
// elements change, plus a short animation while a laser trail fades.
import Konva from "konva";
import { useEffect, useRef, useState } from "react";
import { Arrow, Ellipse, Layer, Line, Rect, Stage } from "react-konva";
import {
  annotationArrowHeadSize, annotationInkStyle, annotationLaserStyle, annotationStrokePoints, type WindowAnnotationScene,
} from "../meeting/window-annotation-events";
import {
  commitAnnotation, createAnnotationHistory, createDrawElement, eraseElements, isMeaningful, laserOpacity, toNormalized, undoAnnotation,
  updateDrawElement,
  type AnnotationElement, type AnnotationHistory, type AnnotationHistoryState, type AnnotationState, type AnnotationStroke, type NormalizedPoint,
} from "./annotation-model";

export type AnnotationCanvasBridge = {
  onAction(callback: (action: "undo" | "clear") => void): () => void;
  history(value: AnnotationHistoryState): void;
  /** Esc: back to the mouse tool, strokes stay. */
  escape(): void;
};

type Laser = { stroke: AnnotationStroke; releasedAt: number | null };

function useViewport() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
}

export function AnnotationCanvas({ state, bridge, onScene }: { state: AnnotationState; bridge: AnnotationCanvasBridge; onScene?: (value: WindowAnnotationScene) => void }) {
  const size = useViewport();
  const [history, setHistory] = useState<AnnotationHistory>(createAnnotationHistory);
  const [draft, setDraft] = useState<AnnotationElement | null>(null);
  const [lasers, setLasers] = useState<Laser[]>([]);
  const [now, setNow] = useState(() => performance.now());
  // Re-render while erasing so hit elements disappear immediately.
  const [, setErased] = useState(0);
  const draftRef = useRef<AnnotationElement | null>(null);
  const erasing = useRef<Set<string> | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const { tool, color, size: brush } = state.tool;

  useEffect(() => bridge.history({ canUndo: history.past.length > 0, canClear: history.present.length > 0 }), [bridge, history]);
  useEffect(() => bridge.onAction((action) => {
    setHistory((current) => action === "undo" ? undoAnnotation(current) : commitAnnotation(current, []));
    if (action === "clear") setLasers([]);
  }), [bridge]);

  // Fade released laser trails; the loop stops as soon as none are visible.
  useEffect(() => {
    if (!lasers.some((laser) => laser.releasedAt !== null)) return;
    let frame = 0;
    const tick = () => {
      const t = performance.now();
      setNow(t);
      setLasers((current) => {
        const next = current.filter((laser) => laserOpacity(laser.releasedAt, t) > 0);
        return next.length === current.length ? current : next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [lasers]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      bridge.escape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge]);

  const pointer = (): NormalizedPoint | null => {
    const position = stageRef.current?.getPointerPosition();
    return position ? toNormalized(position, size) : null;
  };
  const hitId = () => {
    const stage = stageRef.current, position = stage?.getPointerPosition();
    const id = position ? stage!.getIntersection(position)?.getAttr("data-annotation-id") : null;
    return typeof id === "string" ? id : null;
  };

  const onDown = (event: Konva.KonvaEventObject<PointerEvent>) => {
    if (event.evt.button !== 0 || state.mode !== "draw") return;
    const point = pointer();
    if (!point) return;
    if (tool === "eraser") {
      erasing.current = new Set();
      const id = hitId(); if (id) erasing.current.add(id);
      setErased(erasing.current.size);
      return;
    }
    const element = createDrawElement(tool, point, color, brush);
    if (!element) return;
    draftRef.current = element;
    if (tool === "laser" && element.type === "stroke") setLasers((current) => [...current, { stroke: element, releasedAt: null }]);
    else setDraft(element);
  };
  const onMove = () => {
    if (erasing.current) {
      const id = hitId();
      if (id && !erasing.current.has(id)) { erasing.current.add(id); setErased(erasing.current.size); }
      return;
    }
    const current = draftRef.current, point = pointer();
    if (!current || !point) return;
    const next = updateDrawElement(current, point);
    draftRef.current = next;
    if (tool === "laser" && next.type === "stroke") setLasers((list) => list.map((laser) => laser.stroke.id === next.id ? { ...laser, stroke: next } : laser));
    else setDraft(next);
  };
  const onUp = () => {
    if (erasing.current) {
      const removed = erasing.current;
      erasing.current = null;
      setErased(0);
      if (removed.size) setHistory((h) => commitAnnotation(h, eraseElements(h.present, removed)));
      return;
    }
    const current = draftRef.current;
    draftRef.current = null;
    if (!current) return;
    if (tool === "laser") {
      // Laser trails never enter the undo history.
      const t = performance.now();
      setLasers((list) => list.map((laser) => laser.stroke.id === current.id ? { ...laser, releasedAt: t } : laser));
      return;
    }
    setDraft(null);
    if (isMeaningful(current, size)) setHistory((h) => commitAnnotation(h, [...h.present, current]));
  };

  const hidden = erasing.current;
  const visible = history.present.filter((element) => !hidden?.has(element.id));
  useEffect(() => {
    if (!onScene) return;
    const frame = requestAnimationFrame(() => onScene({ size, elements: draft ? [...visible, draft] : visible,
      lasers: lasers.map(({ stroke, releasedAt }) => ({ stroke, opacity: laserOpacity(releasedAt, now) })) }));
    return () => cancelAnimationFrame(frame);
  });
  const cursor = state.mode !== "draw" ? "default" : tool === "eraser" ? "cell" : "crosshair";
  // Konva renders at devicePixelRatio by default, so strokes stay sharp on Retina captures.
  return (
    <div className="annotation-canvas" style={{ cursor }}>
      <Stage ref={stageRef} width={size.width} height={size.height}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        <Layer listening>
          {visible.map((element) => <AnnotationNode key={element.id} element={element} size={size} />)}
          {draft ? <AnnotationNode element={draft} size={size} /> : null}
        </Layer>
        <Layer listening={false}>
          {lasers.map(({ stroke, releasedAt }) => (
            <Line key={stroke.id} points={annotationStrokePoints(stroke, size)} lineCap="round" lineJoin="round"
              {...annotationLaserStyle(stroke, laserOpacity(releasedAt, now))} />
          ))}
        </Layer>
      </Stage>
    </div>
  );
}

function AnnotationNode({ element, size }: { element: AnnotationElement; size: { width: number; height: number } }) {
  const common = { "data-annotation-id": element.id, stroke: element.color, lineCap: "round" as const, lineJoin: "round" as const };
  if (element.type === "stroke") {
    const style = annotationInkStyle(element);
    return <Line {...common} {...style} points={annotationStrokePoints(element, size)}
      hitStrokeWidth={Math.max(18, style.strokeWidth + 8)} />;
  }
  const x1 = element.x1 * size.width, y1 = element.y1 * size.height, x2 = element.x2 * size.width, y2 = element.y2 * size.height;
  const strokeWidth = element.size, hit = Math.max(18, element.size + 8);
  if (element.kind === "arrow") {
    const head = annotationArrowHeadSize(strokeWidth);
    return <Arrow {...common} points={[x1, y1, x2, y2]} strokeWidth={strokeWidth} fill={element.color} pointerLength={head} pointerWidth={head} hitStrokeWidth={hit} />;
  }
  if (element.kind === "rectangle")
    return <Rect {...common} x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} strokeWidth={strokeWidth} hitStrokeWidth={hit} />;
  return <Ellipse {...common} x={(x1 + x2) / 2} y={(y1 + y2) / 2} radiusX={Math.abs(x2 - x1) / 2} radiusY={Math.abs(y2 - y1) / 2} strokeWidth={strokeWidth} hitStrokeWidth={hit} />;
}
