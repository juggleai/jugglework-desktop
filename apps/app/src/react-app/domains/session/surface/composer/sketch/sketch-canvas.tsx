/** @jsxImportSource react */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import Konva from "konva";
import {
  Arrow,
  Ellipse,
  Group,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer,
} from "react-konva";

import {
  SKETCH_LOGICAL_HEIGHT,
  SKETCH_LOGICAL_WIDTH,
  createSketchDrawElement,
  createSketchTextElement,
  isMeaningfulSketchElement,
  moveSketchElement,
  removeSketchElements,
  replaceSketchElement,
  resizeSketchElement,
  updateSketchDrawElement,
  type SketchElement,
  type SketchPoint,
  type SketchTool,
} from "./sketch-model";

type CanvasSize = { width: number; height: number };
type Point = SketchPoint;

export type SketchCanvasHandle = {
  focus: () => void;
};

type SketchCanvasProps = {
  elements: SketchElement[];
  tool: SketchTool;
  color: string;
  strokeWidth: number;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  onPreview: (elements: SketchElement[]) => void;
  onCommit: (elements: SketchElement[]) => void;
  onTextDraftDirtyChange: (dirty: boolean) => void;
  textPlaceholder: string;
  textCommitLabel: string;
};

type DrawGesture = {
  base: SketchElement[];
  start: Point;
  element: SketchElement;
};

type EraseGesture = {
  base: SketchElement[];
  removed: Set<string>;
};

type TextEditorState = {
  x: number;
  y: number;
  value: string;
};

function useElementSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState<CanvasSize>({ width: 1, height: 1 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      setSize({ width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function cursorForTool(tool: SketchTool) {
  if (tool === "select") return "default";
  if (tool === "text") return "text";
  if (tool === "eraser") return "cell";
  return "crosshair";
}

function isResizable(element: SketchElement | undefined) {
  return element?.type === "rectangle" || element?.type === "ellipse" || element?.type === "text";
}

export const SketchCanvas = forwardRef<SketchCanvasHandle, SketchCanvasProps>(function SketchCanvas(props, forwardedRef) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const nodeRefs = useRef(new Map<string, Konva.Node>());
  const elementsRef = useRef(props.elements);
  const drawGestureRef = useRef<DrawGesture | null>(null);
  const eraseGestureRef = useRef<EraseGesture | null>(null);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const size = useElementSize(hostRef);

  useEffect(() => {
    elementsRef.current = props.elements;
  }, [props.elements]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => stageRef.current?.container().focus(),
  }), []);

  const viewport = useMemo(() => {
    const scale = Math.min(size.width / SKETCH_LOGICAL_WIDTH, size.height / SKETCH_LOGICAL_HEIGHT);
    const width = SKETCH_LOGICAL_WIDTH * scale;
    const height = SKETCH_LOGICAL_HEIGHT * scale;
    return {
      scale,
      x: (size.width - width) / 2,
      y: (size.height - height) / 2,
      width,
      height,
    };
  }, [size.height, size.width]);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const selected = props.selectedId ? props.elements.find((element) => element.id === props.selectedId) : undefined;
    const node = props.selectedId ? nodeRefs.current.get(props.selectedId) : undefined;
    transformer.nodes(node && isResizable(selected) ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [props.elements, props.selectedId]);

  useEffect(() => {
    if (textEditor) window.requestAnimationFrame(() => textAreaRef.current?.focus());
  }, [textEditor]);

  useEffect(() => {
    props.onTextDraftDirtyChange(Boolean(textEditor?.value.trim()));
  }, [props.onTextDraftDirtyChange, textEditor?.value]);

  useEffect(() => () => props.onTextDraftDirtyChange(false), [props.onTextDraftDirtyChange]);

  const pointer = useCallback((): Point | null => {
    const stage = stageRef.current;
    const position = stage?.getPointerPosition();
    if (!position || viewport.scale <= 0) return null;
    return {
      x: Math.max(0, Math.min(SKETCH_LOGICAL_WIDTH, (position.x - viewport.x) / viewport.scale)),
      y: Math.max(0, Math.min(SKETCH_LOGICAL_HEIGHT, (position.y - viewport.y) / viewport.scale)),
    };
  }, [viewport.scale, viewport.x, viewport.y]);

  const hitElementId = useCallback(() => {
    const stage = stageRef.current;
    const position = stage?.getPointerPosition();
    if (!stage || !position) return null;
    const target = stage.getIntersection(position);
    const id = target?.getAttr("data-sketch-id");
    return typeof id === "string" && id ? id : null;
  }, []);

  const applyErase = useCallback(() => {
    const gesture = eraseGestureRef.current;
    if (!gesture) return;
    const id = hitElementId();
    if (!id || gesture.removed.has(id)) return;
    gesture.removed.add(id);
    props.onPreview(removeSketchElements(gesture.base, gesture.removed));
  }, [hitElementId, props]);

  const startDrawing = useCallback((point: Point) => {
    const base = elementsRef.current;
    const element = createSketchDrawElement(props.tool, point, props.color, props.strokeWidth);
    if (!element) return;
    drawGestureRef.current = { base, start: point, element };
    props.onPreview([...base, element]);
  }, [props]);

  const updateDrawing = useCallback((point: Point) => {
    const gesture = drawGestureRef.current;
    if (!gesture) return;
    const start = gesture.start;
    const next = updateSketchDrawElement(gesture.element, start, point);
    drawGestureRef.current = { ...gesture, element: next };
    props.onPreview([...gesture.base, next]);
  }, [props]);

  const finishGesture = useCallback(() => {
    if (drawGestureRef.current) {
      const { base, element } = drawGestureRef.current;
      drawGestureRef.current = null;
      if (isMeaningfulSketchElement(element)) props.onCommit([...base, element]);
      else props.onPreview(base);
    }
    if (eraseGestureRef.current) {
      const { base, removed } = eraseGestureRef.current;
      eraseGestureRef.current = null;
      const next = removeSketchElements(base, removed);
      if (removed.size) props.onCommit(next);
      else props.onPreview(base);
    }
  }, [props]);

  const handlePointerDown = useCallback((event: Konva.KonvaEventObject<PointerEvent>) => {
    if (event.evt.button !== 0) return;
    const point = pointer();
    if (!point) return;
    const targetId = (event.target as Konva.Node).getAttr("data-sketch-id");
    if (props.tool === "select") {
      props.onSelectedIdChange(typeof targetId === "string" ? targetId : null);
      return;
    }
    props.onSelectedIdChange(null);
    if (props.tool === "eraser") {
      eraseGestureRef.current = { base: elementsRef.current, removed: new Set<string>() };
      applyErase();
      return;
    }
    if (props.tool === "text") {
      setTextEditor({ x: point.x, y: point.y, value: "" });
      return;
    }
    startDrawing(point);
  }, [applyErase, pointer, props, startDrawing]);

  const handlePointerMove = useCallback(() => {
    if (eraseGestureRef.current) {
      applyErase();
      return;
    }
    const point = pointer();
    if (point) updateDrawing(point);
  }, [applyErase, pointer, updateDrawing]);

  const commitText = useCallback(() => {
    if (!textEditor) return;
    setTextEditor(null);
    const element = createSketchTextElement(textEditor, textEditor.value, props.color, props.strokeWidth);
    if (!element) return;
    props.onCommit([...elementsRef.current, element]);
  }, [props, textEditor]);

  const commitMove = useCallback((id: string, node: Konva.Node) => {
    props.onCommit(replaceSketchElement(elementsRef.current, id, (element) => moveSketchElement(element, node.x(), node.y())));
  }, [props]);

  const commitTransform = useCallback((id: string, node: Konva.Node) => {
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    props.onCommit(replaceSketchElement(elementsRef.current, id, (element) => (
      resizeSketchElement(element, node.x(), node.y(), scaleX, scaleY)
    )));
  }, [props]);

  const commonNodeProps = (element: SketchElement) => ({
    id: `sketch-node-${element.id}`,
    name: "sketch-element",
    "data-sketch-id": element.id,
    x: element.x,
    y: element.y,
    stroke: element.color,
    strokeWidth: element.strokeWidth,
    lineCap: "round" as const,
    lineJoin: "round" as const,
    draggable: props.tool === "select" && props.selectedId === element.id,
    onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => commitMove(element.id, event.target),
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => commitTransform(element.id, event.target),
    ref: (node: Konva.Node | null) => {
      if (node) nodeRefs.current.set(element.id, node);
      else nodeRefs.current.delete(element.id);
    },
  });

  return (
    <div
      ref={hostRef}
      className="relative h-full min-h-0 w-full overflow-hidden bg-white"
      data-testid="sketch-canvas"
      style={{ cursor: cursorForTool(props.tool) }}
    >
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        tabIndex={0}
        aria-label="Sketch canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishGesture}
        onPointerLeave={finishGesture}
      >
        <Layer>
          <Group
            x={viewport.x}
            y={viewport.y}
            scaleX={viewport.scale}
            scaleY={viewport.scale}
            clipX={0}
            clipY={0}
            clipWidth={SKETCH_LOGICAL_WIDTH}
            clipHeight={SKETCH_LOGICAL_HEIGHT}
          >
            <Rect width={SKETCH_LOGICAL_WIDTH} height={SKETCH_LOGICAL_HEIGHT} fill="#ffffff" />
            {props.elements.map((element) => {
              const common = commonNodeProps(element);
              if (element.type === "stroke") {
                return <Line key={element.id} {...common} points={element.points} tension={0.35} hitStrokeWidth={Math.max(18, element.strokeWidth + 8)} />;
              }
              if (element.type === "line") {
                return <Line key={element.id} {...common} points={element.points} hitStrokeWidth={Math.max(18, element.strokeWidth + 8)} />;
              }
              if (element.type === "arrow") {
                return <Arrow key={element.id} {...common} points={element.points} pointerLength={16} pointerWidth={14} hitStrokeWidth={Math.max(18, element.strokeWidth + 8)} />;
              }
              if (element.type === "rectangle") {
                return <Rect key={element.id} {...common} width={element.width} height={element.height} fill="transparent" />;
              }
              if (element.type === "ellipse") {
                return (
                  <Ellipse
                    key={element.id}
                    {...common}
                    x={element.x + element.width / 2}
                    y={element.y + element.height / 2}
                    radiusX={Math.abs(element.width / 2)}
                    radiusY={Math.abs(element.height / 2)}
                  />
                );
              }
              return (
                <Text
                  key={element.id}
                  {...common}
                  text={element.text}
                  width={element.width}
                  fontSize={element.fontSize}
                  fill={element.color}
                  strokeEnabled={false}
                  fontFamily="Geist Variable, IBM Plex Sans, sans-serif"
                  lineHeight={1.25}
                />
              );
            })}
            <Transformer
              ref={transformerRef}
              rotateEnabled={false}
              keepRatio={false}
              flipEnabled={false}
              anchorSize={10}
              borderStroke="#3b82f6"
              anchorFill="#ffffff"
              anchorStroke="#3b82f6"
              boundBoxFunc={(oldBox, newBox) => newBox.width < 5 || newBox.height < 5 ? oldBox : newBox}
            />
          </Group>
        </Layer>
      </Stage>

      {textEditor ? (
        <textarea
          ref={textAreaRef}
          aria-label={props.textCommitLabel}
          value={textEditor.value}
          placeholder={props.textPlaceholder}
          className="absolute z-10 min-h-24 resize-none rounded-xl border border-blue-8 bg-white px-3 py-2 text-base text-black shadow-lg outline-none ring-2 ring-blue-5/30"
          style={{
            left: viewport.x + textEditor.x * viewport.scale,
            top: viewport.y + textEditor.y * viewport.scale,
            width: Math.min(320, Math.max(180, size.width - (viewport.x + textEditor.x * viewport.scale) - 24)),
          }}
          onChange={(event) => setTextEditor((current) => current ? { ...current, value: event.currentTarget.value } : null)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key === "Process") return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setTextEditor(null);
              stageRef.current?.container().focus();
              return;
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commitText();
            }
          }}
        />
      ) : null}
    </div>
  );
});
