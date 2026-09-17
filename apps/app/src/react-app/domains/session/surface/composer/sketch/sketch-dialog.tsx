/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  Circle,
  Eraser,
  LoaderCircle,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Shapes,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

import { SketchCanvas, type SketchCanvasHandle } from "./sketch-canvas";
import { exportSketchFile } from "./sketch-export";
import {
  commitSketchHistory,
  createSketchHistory,
  isSketchEmpty,
  redoSketchHistory,
  undoSketchHistory,
  type SketchElement,
  type SketchTool,
} from "./sketch-model";

const SKETCH_COLORS = [
  "#111111",
  "#6b7280",
  "#92400e",
  "#dc2626",
  "#f97316",
  "#f59e0b",
  "#16a34a",
  "#0f766e",
  "#0891b2",
  "#2563eb",
  "#4f46e5",
  "#9333ea",
  "#db2777",
];

type SketchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (file: File) => void | Promise<void>;
};

type ToolButtonProps = {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
};

function ToolButton(props: ToolButtonProps) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`inline-flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-35 sm:size-11 ${
        props.active ? "bg-gray-3 text-gray-12" : "text-gray-10 hover:bg-gray-2 hover:text-gray-12"
      }`}
    >
      {props.children}
    </button>
  );
}

function iconForShape(tool: SketchTool) {
  if (tool === "line") return <Minus size={20} />;
  if (tool === "arrow") return <ArrowRight size={20} />;
  if (tool === "rectangle") return <Square size={19} />;
  if (tool === "ellipse") return <Circle size={19} />;
  return <Shapes size={20} />;
}

function isShapeTool(tool: SketchTool) {
  return tool === "line" || tool === "arrow" || tool === "rectangle" || tool === "ellipse";
}

export function SketchDialog(props: SketchDialogProps) {
  const [editor, setEditor] = useState(() => {
    const history = createSketchHistory();
    return { history, elements: history.present };
  });
  const { history, elements } = editor;
  const [tool, setTool] = useState<SketchTool>("pen");
  const [color, setColor] = useState(SKETCH_COLORS[0]!);
  const [strokeWidth, setStrokeWidth] = useState(5);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [textDraftDirty, setTextDraftDirty] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<SketchCanvasHandle | null>(null);

  const reset = useCallback(() => {
    const next = createSketchHistory();
    setEditor({ history: next, elements: next.present });
    setTool("pen");
    setColor(SKETCH_COLORS[0]!);
    setStrokeWidth(5);
    setSelectedId(null);
    setShapeMenuOpen(false);
    setDiscardOpen(false);
    setTextDraftDirty(false);
    setExporting(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (props.open) reset();
  }, [props.open, reset]);

  const commit = useCallback((next: SketchElement[]) => {
    setEditor((current) => {
      const history = commitSketchHistory(current.history, next);
      return { history, elements: history.present };
    });
    setError(null);
  }, []);

  const preview = useCallback((next: SketchElement[]) => {
    setEditor((current) => ({ ...current, elements: next }));
  }, []);

  const undo = useCallback(() => {
    setEditor((current) => {
      const history = undoSketchHistory(current.history);
      return { history, elements: history.present };
    });
    setSelectedId(null);
  }, []);

  const redo = useCallback(() => {
    setEditor((current) => {
      const history = redoSketchHistory(current.history);
      return { history, elements: history.present };
    });
    setSelectedId(null);
  }, []);

  const requestClose = useCallback(() => {
    if (exporting) return;
    if (isSketchEmpty(elements) && !textDraftDirty) {
      props.onOpenChange(false);
      return;
    }
    setDiscardOpen(true);
  }, [elements, exporting, props, textDraftDirty]);

  const complete = useCallback(async () => {
    if (isSketchEmpty(elements) || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const file = await exportSketchFile(elements);
      await props.onComplete(file);
      props.onOpenChange(false);
    } catch (cause) {
      console.error("Failed to export sketch", cause);
      setError(t("sketch.export_error"));
    } finally {
      setExporting(false);
    }
  }, [elements, exporting, props]);

  const selectTool = (next: SketchTool) => {
    setTool(next);
    setSelectedId(null);
    setShapeMenuOpen(false);
    canvasRef.current?.focus();
  };

  return (
    <>
      <Dialog
        open={props.open}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          aria-describedby="sketch-dialog-description"
          className="top-auto bottom-0 h-[calc(100dvh-10rem)] max-h-[calc(100dvh-10rem)] w-full max-w-none translate-y-0 gap-0 overflow-hidden rounded-[28px] rounded-b-none bg-white p-0 sm:top-1/2 sm:bottom-auto sm:h-[min(48rem,calc(100dvh-5rem))] sm:max-h-[calc(100dvh-5rem)] sm:w-[min(52rem,calc(100%-4rem))] sm:max-w-[52rem] sm:-translate-y-1/2 sm:rounded-b-[28px] dark:bg-gray-1"
          onKeyDown={(event) => {
            const target = event.target;
            if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
            if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
          }}
        >
          <DialogTitle className="sr-only">{t("sketch.title")}</DialogTitle>
          <DialogDescription id="sketch-dialog-description" className="sr-only">
            {t("sketch.description")}
          </DialogDescription>

          <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-white">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={requestClose}
              aria-label={t("sketch.close")}
              title={t("sketch.close")}
              className="absolute left-2 top-2 z-30 inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 sm:left-5 sm:top-5 sm:size-11"
            >
              <X size={22} />
            </button>

            <div className="absolute left-1/2 top-2 z-30 flex -translate-x-1/2 items-center rounded-full border border-gray-4 bg-white/95 p-1 shadow-lg backdrop-blur sm:top-4 dark:border-gray-5 dark:bg-gray-2/95">
              <ToolButton active={tool === "select"} label={t("sketch.tool_select")} onClick={() => selectTool("select")}>
                <MousePointer2 size={20} />
              </ToolButton>
              <ToolButton active={tool === "pen"} label={t("sketch.tool_pen")} onClick={() => selectTool("pen")}>
                <Pencil size={20} />
              </ToolButton>
              <ToolButton active={tool === "text"} label={t("sketch.tool_text")} onClick={() => selectTool("text")}>
                <Type size={20} />
              </ToolButton>
              <div className="relative">
                <ToolButton
                  active={isShapeTool(tool)}
                  label={t("sketch.tool_shapes")}
                  onClick={() => setShapeMenuOpen((open) => !open)}
                >
                  {iconForShape(tool)}
                </ToolButton>
                {shapeMenuOpen ? (
                  <div className="absolute left-1/2 top-full mt-2 flex -translate-x-1/2 rounded-2xl border border-gray-4 bg-white p-1 shadow-lg dark:border-gray-5 dark:bg-gray-2">
                    {(["line", "arrow", "rectangle", "ellipse"] as const).map((shape) => (
                      <ToolButton key={shape} active={tool === shape} label={t(`sketch.tool_${shape}`)} onClick={() => selectTool(shape)}>
                        {iconForShape(shape)}
                      </ToolButton>
                    ))}
                  </div>
                ) : null}
              </div>
              <ToolButton active={tool === "eraser"} label={t("sketch.tool_eraser")} onClick={() => selectTool("eraser")}>
                <Eraser size={20} />
              </ToolButton>
            </div>

            <div className="absolute right-2 top-2 z-30 flex items-center gap-1 sm:right-5 sm:top-5">
              <ToolButton active={false} disabled={history.past.length === 0 || exporting} label={t("sketch.undo")} onClick={undo}>
                <Undo2 size={20} />
              </ToolButton>
              <ToolButton active={false} disabled={history.future.length === 0 || exporting} label={t("sketch.redo")} onClick={redo}>
                <Redo2 size={20} />
              </ToolButton>
            </div>

            <div className="absolute bottom-1/2 left-2 z-30 flex translate-y-1/2 flex-col items-center gap-1 rounded-full border border-gray-4 bg-white/95 px-1.5 py-2 shadow-md backdrop-blur sm:left-4 sm:gap-3 sm:px-2 sm:py-4 dark:border-gray-5 dark:bg-gray-2/95">
              <span className="text-[10px] font-medium text-gray-9">{strokeWidth}</span>
              <input
                aria-label={t("sketch.stroke_width")}
                type="range"
                min={1}
                max={24}
                step={1}
                value={strokeWidth}
                onChange={(event) => setStrokeWidth(Number(event.currentTarget.value))}
                className="h-28 w-5 cursor-pointer accent-gray-12 sm:h-44"
                style={{ writingMode: "vertical-lr", direction: "rtl" }}
              />
            </div>

            <div className="min-h-0 flex-1 pt-0">
              <SketchCanvas
                ref={canvasRef}
                elements={elements}
                tool={tool}
                color={color}
                strokeWidth={strokeWidth}
                selectedId={selectedId}
                onSelectedIdChange={setSelectedId}
                onPreview={preview}
                onCommit={commit}
                onTextDraftDirtyChange={setTextDraftDirty}
                textPlaceholder={t("sketch.text_placeholder")}
                textCommitLabel={t("sketch.text_input")}
              />
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center px-14 sm:bottom-5 sm:px-24">
              <div className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-gray-4 bg-white/95 p-1 shadow-lg backdrop-blur sm:gap-2 sm:p-2 dark:border-gray-5 dark:bg-gray-2/95">
                <label
                  className="relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-gray-5 bg-[conic-gradient(red,yellow,lime,aqua,blue,magenta,red)] focus-within:ring-2 focus-within:ring-blue-8 focus-within:ring-offset-2 sm:size-9"
                  title={t("sketch.custom_color")}
                >
                  <input
                    type="color"
                    value={color}
                    aria-label={t("sketch.custom_color")}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    onChange={(event) => setColor(event.currentTarget.value)}
                  />
                </label>
                {SKETCH_COLORS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-label={t("sketch.choose_color", { color: item })}
                    aria-pressed={color.toLowerCase() === item.toLowerCase()}
                    onClick={() => setColor(item)}
                    className={`size-6 shrink-0 cursor-pointer rounded-full border transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 focus-visible:ring-offset-2 sm:size-9 ${
                      color.toLowerCase() === item.toLowerCase() ? "ring-2 ring-blue-8 ring-offset-2" : "border-black/15 hover:ring-2 hover:ring-gray-5"
                    }`}
                    style={{ backgroundColor: item }}
                  />
                ))}
              </div>
            </div>

            {error ? (
              <div role="alert" className="absolute bottom-20 right-5 z-30 max-w-sm rounded-xl border border-red-5 bg-red-2 px-4 py-2 text-sm text-red-11 shadow-lg">
                {error}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => void complete()}
              disabled={isSketchEmpty(elements) || exporting}
              aria-label={t("sketch.complete")}
              title={t("sketch.complete")}
              className="absolute right-2 bottom-2 z-30 inline-flex size-12 cursor-pointer items-center justify-center rounded-full bg-blue-9 text-white shadow-lg transition-colors hover:bg-blue-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 focus-visible:ring-offset-2 disabled:cursor-default disabled:bg-gray-4 disabled:text-gray-9 sm:right-5 sm:bottom-5 sm:size-14"
            >
              {exporting ? <LoaderCircle size={24} className="animate-spin" /> : <Check size={25} />}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sketch.discard_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("sketch.discard_description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => window.requestAnimationFrame(() => canvasRef.current?.focus())}>
              {t("sketch.keep_editing")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDiscardOpen(false);
                props.onOpenChange(false);
              }}
            >
              {t("sketch.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
