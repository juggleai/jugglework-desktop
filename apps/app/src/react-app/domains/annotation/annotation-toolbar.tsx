/** @jsxImportSource react */
// Content-protected toolbar for screen annotation, laid out like Feishu
// meetings: mouse, laser, drawing tools, colors, eraser, undo, clear, close.
// It only sends commands; the canvas owns the strokes and reports back
// whether undo and clear are available.
import { ArrowUpRight, Circle, Eraser, GripVertical, Highlighter, MousePointer2, Pencil, Square, Trash2, Undo2, X, Zap } from "lucide-react";
import { useRef, type ComponentType, type PointerEvent as ReactPointerEvent } from "react";
import { ANNOTATION_COLORS, type AnnotationState, type AnnotationTool } from "./annotation-model";

export type AnnotationCommand =
  | { type: "tool"; tool: AnnotationState["tool"] }
  | { type: "undo" } | { type: "clear" } | { type: "exit" } | { type: "escape" }
  | { type: "move"; dx: number; dy: number };

type ToolButton = { tool: AnnotationTool; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> };
const POINTER: ToolButton[] = [
  { tool: "pointer", label: "鼠标", icon: MousePointer2 },
  { tool: "laser", label: "激光", icon: Zap },
];
const DRAW: ToolButton[] = [
  { tool: "pen", label: "笔", icon: Pencil },
  { tool: "highlighter", label: "荧光笔", icon: Highlighter },
  { tool: "ellipse", label: "椭圆形", icon: Circle },
  { tool: "rectangle", label: "矩形", icon: Square },
  { tool: "arrow", label: "箭头", icon: ArrowUpRight },
];
const ERASER: ToolButton[] = [{ tool: "eraser", label: "橡皮擦", icon: Eraser }];
const COLOR_NAMES: Record<string, string> = { "#ef4444": "红", "#facc15": "黄", "#22c55e": "绿", "#3b82f6": "蓝", "#a855f7": "紫" };

export function AnnotationToolbar({ state, send }: { state: AnnotationState; send: (command: AnnotationCommand) => void }) {
  const drag = useRef<{ x: number; y: number } | null>(null);
  const setTool = (patch: Partial<AnnotationState["tool"]>) => send({ type: "tool", tool: { ...state.tool, ...patch } });
  const onGripDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.screenX, y: event.screenY };
  };
  const onGripMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start) return;
    const dx = event.screenX - start.x, dy = event.screenY - start.y;
    if (!dx && !dy) return;
    drag.current = { x: event.screenX, y: event.screenY };
    send({ type: "move", dx, dy });
  };
  const tools = (list: ToolButton[]) => list.map(({ tool, label, icon: Icon }) => (
    <button key={tool} type="button" role="radio" aria-checked={state.tool.tool === tool} aria-label={label} title={label}
      onClick={() => setTool({ tool })}>
      <Icon size={17} strokeWidth={1.8} />
    </button>
  ));
  return (
    <div className="annotation-toolbar" role="toolbar" aria-label="屏幕标注">
      <button type="button" className="grip" aria-label="拖动工具栏" title="拖动工具栏"
        onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={() => { drag.current = null; }}>
        <GripVertical size={16} />
      </button>
      <div className="tools" role="radiogroup" aria-label="工具">
        {tools(POINTER)}
        <span className="sep" />
        {tools(DRAW)}
      </div>
      <span className="sep" />
      <div className="colors" role="radiogroup" aria-label="颜色">
        {ANNOTATION_COLORS.map((color) => (
          <button key={color} type="button" role="radio" aria-checked={state.tool.color === color}
            aria-label={`颜色：${COLOR_NAMES[color]}`} title={COLOR_NAMES[color]}
            className="swatch" onClick={() => setTool({ color })}><span className="fill" style={{ background: color }} /></button>
        ))}
      </div>
      <span className="sep" />
      <div className="tools" role="radiogroup" aria-label="橡皮擦">{tools(ERASER)}</div>
      <button type="button" aria-label="撤销" title="撤销" disabled={!state.history.canUndo} onClick={() => send({ type: "undo" })}><Undo2 size={17} /></button>
      <button type="button" aria-label="清除" title="清除所有标注" disabled={!state.history.canClear} onClick={() => send({ type: "clear" })}><Trash2 size={17} /></button>
      <span className="sep" />
      <button type="button" className="close" aria-label="关闭标注" title="关闭标注" onClick={() => send({ type: "exit" })}><X size={17} /></button>
    </div>
  );
}
