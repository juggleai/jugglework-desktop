/** @jsxImportSource react */
// Transparent full-screen annotation canvas. It is captured by the whole-screen
// share, so only strokes are drawn (no background) and it redraws only when
// elements change, plus a short animation while a laser trail fades.
import Konva from "konva";
import { useCallback, useEffect, useRef, useState } from "react";
import { Arrow, Ellipse, Layer, Line, Rect, Stage, Text } from "react-konva";
import {
  annotationFontSize, commitAnnotation, createAnnotationHistory, createDrawElement, createTextElement, eraseElements, isMeaningful,
  laserOpacity, redoAnnotation, toNormalized, undoAnnotation, updateDrawElement,
  type AnnotationElement, type AnnotationHistory, type AnnotationState, type AnnotationStroke, type NormalizedPoint,
} from "./annotation-model";

export type AnnotationCanvasBridge = {
  onAction(callback: (action: "undo" | "redo" | "clear") => void): () => void;
  history(value: { canUndo: boolean; canRedo: boolean }): void;
  exit(): void;
};

type Laser = { stroke: AnnotationStroke; releasedAt: number | null };
const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function useViewport() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
}

export function AnnotationCanvas({ state, bridge }: { state: AnnotationState; bridge: AnnotationCanvasBridge }) {
  const size = useViewport();
  const [history, setHistory] = useState<AnnotationHistory>(createAnnotationHistory);
  const [draft, setDraft] = useState<AnnotationElement | null>(null);
  const [lasers, setLasers] = useState<Laser[]>([]);
  const [text, setText] = useState<{ point: NormalizedPoint; value: string } | null>(null);
  const [now, setNow] = useState(() => performance.now());
  // Re-render while erasing so hit elements disappear immediately.
  const [, setErased] = useState(0);
  const historyRef = useRef(history);
  historyRef.current = history;
  const draftRef = useRef<AnnotationElement | null>(null);
  const erasing = useRef<Set<string> | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const { tool, color, size: brush } = state.tool;

  useEffect(() => bridge.history({ canUndo: history.past.length > 0, canRedo: history.future.length > 0 }), [bridge, history]);
  useEffect(() => bridge.onAction((action) => {
    setHistory((current) => action === "undo" ? undoAnnotation(current) : action === "redo" ? redoAnnotation(current) : commitAnnotation(current, []));
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

  const commitText = useCallback(() => {
    setText((current) => {
      if (current) {
        const element = createTextElement(current.point, current.value, color, brush);
        if (element) setHistory((h) => commitAnnotation(h, [...h.present, element]));
      }
      return null;
    });
  }, [brush, color]);

  // Esc leaves annotation unless it is cancelling a text draft.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      if (textRef.current) { setText(null); return; }
      bridge.exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge]);
  useEffect(() => { if (text) requestAnimationFrame(() => textRef.current?.focus()); }, [text !== null]);
  // Switching tools commits an open text draft.
  useEffect(() => { if (tool !== "text") commitText(); }, [tool, commitText]);

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
    if (tool === "text") {
      if (textRef.current) { commitText(); return; }
      setText({ point, value: "" });
      return;
    }
    if (tool === "eraser") {
      erasing.current = new Set();
      const id = hitId(); if (id) erasing.current.add(id);
      setErased(erasing.current.size);
      return;
    }
    const element = createDrawElement(tool, point, color, brush);
    if (!element) return;
    if (tool === "laser" && element.type === "stroke") {
      setLasers((current) => [...current, { stroke: element, releasedAt: null }]);
      draftRef.current = element;
      return;
    }
    draftRef.current = element;
    setDraft(element);
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
  const cursor = state.mode !== "draw" ? "default" : tool === "text" ? "text" : tool === "eraser" ? "cell" : "crosshair";
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
            <Line key={stroke.id} points={stroke.points.map((value, i) => value * (i % 2 ? size.height : size.width))}
              stroke="#ff3b30" strokeWidth={Math.max(3, stroke.size)} lineCap="round" lineJoin="round" tension={0.4}
              shadowColor="#ff3b30" shadowBlur={14} shadowOpacity={0.9} opacity={laserOpacity(releasedAt, now)} />
          ))}
        </Layer>
      </Stage>
      {text ? (
        <textarea ref={textRef} className="annotation-text-editor" aria-label="标注文字" placeholder="输入文字，回车完成"
          value={text.value} rows={1}
          style={{ left: text.point.x * size.width, top: text.point.y * size.height, color,
            fontSize: annotationFontSize(brush) * size.height, fontFamily: FONT }}
          onChange={(event) => { const value = event.currentTarget.value; setText((current) => current ? { ...current, value } : null); }}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key === "Process") return;
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); commitText(); }
          }} />
      ) : null}
    </div>
  );
}

function AnnotationNode({ element, size }: { element: AnnotationElement; size: { width: number; height: number } }) {
  const common = { "data-annotation-id": element.id, stroke: element.color, lineCap: "round" as const, lineJoin: "round" as const };
  const px = (x: number) => x * size.width, py = (y: number) => y * size.height;
  if (element.type === "stroke") {
    return <Line {...common} points={element.points.map((value, i) => value * (i % 2 ? size.height : size.width))}
      strokeWidth={element.highlight ? element.size * 4 : element.size} tension={0.35}
      opacity={element.highlight ? 0.35 : 1} globalCompositeOperation={element.highlight ? "multiply" : "source-over"}
      hitStrokeWidth={Math.max(18, element.size * (element.highlight ? 4 : 1) + 8)} />;
  }
  if (element.type === "text") {
    return <Text {...common} x={px(element.x)} y={py(element.y)} text={element.text} fontSize={element.fontSize * size.height}
      fill={element.color} strokeEnabled={false} fontFamily={FONT} lineHeight={1.25} />;
  }
  const x1 = px(element.x1), y1 = py(element.y1), x2 = px(element.x2), y2 = py(element.y2);
  const strokeWidth = element.size, hit = Math.max(18, element.size + 8);
  if (element.kind === "line") return <Line {...common} points={[x1, y1, x2, y2]} strokeWidth={strokeWidth} hitStrokeWidth={hit} />;
  if (element.kind === "arrow") {
    const head = Math.max(12, element.size * 3.5);
    return <Arrow {...common} points={[x1, y1, x2, y2]} strokeWidth={strokeWidth} fill={element.color} pointerLength={head} pointerWidth={head} hitStrokeWidth={hit} />;
  }
  if (element.kind === "rectangle")
    return <Rect {...common} x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} strokeWidth={strokeWidth} hitStrokeWidth={hit} />;
  return <Ellipse {...common} x={(x1 + x2) / 2} y={(y1 + y2) / 2} radiusX={Math.abs(x2 - x1) / 2} radiusY={Math.abs(y2 - y1) / 2} strokeWidth={strokeWidth} hitStrokeWidth={hit} />;
}

