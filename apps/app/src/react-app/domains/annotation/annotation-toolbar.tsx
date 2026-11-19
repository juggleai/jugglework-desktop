/** @jsxImportSource react */
// Content-protected toolbar for screen annotation. It only sends commands; the
// canvas owns the strokes and reports undo/redo availability back.
import {
  ArrowUpRight, Circle, Eraser, GripVertical, Highlighter, LogOut, Minus, MousePointer2, Pencil, Redo2, Square, Trash2, Type, Undo2, Zap,
} from "lucide-react";
import { useRef, type ComponentType, type PointerEvent as ReactPointerEvent } from "react";
import type { AnnotationMode, AnnotationState, AnnotationTool } from "./annotation-model";

export type AnnotationCommand =
  | { type: "mode"; mode: AnnotationMode }
  | { type: "tool"; tool: AnnotationState["tool"] }
  | { type: "undo" } | { type: "redo" } | { type: "clear" } | { type: "exit" }
  | { type: "move"; dx: number; dy: number };

export const ANNOTATION_COLORS = ["#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#111827", "#ffffff"];
export const ANNOTATION_SIZES = [{ value: 2, label: "细" }, { value: 4, label: "中" }, { value: 8, label: "粗" }];

const TOOLS: { tool: AnnotationTool; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { tool: "pen", label: "画笔", icon: Pencil },
  { tool: "highlighter", label: "荧光笔", icon: Highlighter },
  { tool: "laser", label: "激光笔", icon: Zap },
  { tool: "line", label: "直线", icon: Minus },
  { tool: "arrow", label: "箭头", icon: ArrowUpRight },
  { tool: "rectangle", label: "矩形", icon: Square },
  { tool: "ellipse", label: "椭圆", icon: Circle },
  { tool: "text", label: "文字", icon: Type },
  { tool: "eraser", label: "橡皮", icon: Eraser },
];

export function AnnotationToolbar({ state, send }: { state: AnnotationState; send: (command: AnnotationCommand) => void }) {
  const drag = useRef<{ x: number; y: number } | null>(null);
  const setTool = (patch: Partial<AnnotationState["tool"]>) => send({ type: "tool", tool: { ...state.tool, ...patch } });
  const drawing = state.mode === "draw";
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
  return (
    <div className="annotation-toolbar" role="toolbar" aria-label="屏幕标注">
      <button type="button" className="grip" aria-label="拖动工具栏" title="拖动工具栏"
        onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={() => { drag.current = null; }}>
        <GripVertical size={16} />
      </button>
      <div className="segmented" role="radiogroup" aria-label="模式">
        <button type="button" role="radio" aria-checked={drawing} onClick={() => send({ type: "mode", mode: "draw" })} title="标注模式">
          <Pencil size={15} /><span>标注</span>
        </button>
        <button type="button" role="radio" aria-checked={!drawing} onClick={() => send({ type: "mode", mode: "pointer" })} title="操作模式：鼠标操作下面的应用">
          <MousePointer2 size={15} /><span>操作</span>
        </button>
      </div>
      <span className="sep" />
      <div className="tools" role="radiogroup" aria-label="工具">
        {TOOLS.map(({ tool, label, icon: Icon }) => (
          <button key={tool} type="button" role="radio" aria-checked={drawing && state.tool.tool === tool} aria-label={label} title={label}
            onClick={() => setTool({ tool })}>
            <Icon size={17} strokeWidth={1.8} />
          </button>
        ))}
      </div>
      <span className="sep" />
      <div className="colors" role="radiogroup" aria-label="颜色">
        {ANNOTATION_COLORS.map((color) => (
          <button key={color} type="button" role="radio" aria-checked={state.tool.color === color} aria-label={`颜色 ${color}`}
            className="swatch" style={{ background: color }} onClick={() => setTool({ color })} />
        ))}
      </div>
      <div className="sizes" role="radiogroup" aria-label="粗细">
        {ANNOTATION_SIZES.map(({ value, label }) => (
          <button key={value} type="button" role="radio" aria-checked={state.tool.size === value} aria-label={`粗细：${label}`} title={label}
            onClick={() => setTool({ size: value })}>
            <span className="dot" style={{ width: value + 3, height: value + 3 }} />
          </button>
        ))}
      </div>
      <span className="sep" />
      <button type="button" aria-label="撤销" title="撤销" disabled={!state.history.canUndo} onClick={() => send({ type: "undo" })}><Undo2 size={17} /></button>
      <button type="button" aria-label="重做" title="重做" disabled={!state.history.canRedo} onClick={() => send({ type: "redo" })}><Redo2 size={17} /></button>
      <button type="button" aria-label="清空" title="清空" disabled={!state.history.canUndo && !state.history.canRedo} onClick={() => send({ type: "clear" })}><Trash2 size={17} /></button>
      <button type="button" className="exit" onClick={() => send({ type: "exit" })} title="退出标注（Esc）"><LogOut size={15} /><span>退出标注</span></button>
    </div>
  );
}
