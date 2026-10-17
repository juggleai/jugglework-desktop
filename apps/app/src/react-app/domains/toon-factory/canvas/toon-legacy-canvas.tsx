/** @jsxImportSource react */
import { useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { Hand, HelpCircle, Image, Maximize, Minus, MousePointer2, Plus, Sparkles, Video } from "lucide-react";
import type { ToonCanvas, ToonNode, ToonNodeKind } from "@jugglework/types/toon-factory";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { TOON_NODE_DEFINITIONS, createNode, validateToonConnection } from "../toon-factory-workflow";

const CANVAS_NODE_WIDTH = 220;
const CANVAS_NODE_HEIGHT = 120;
const CANVAS_FIT_PADDING = 64;
const CANVAS_ASSISTANT_PLACEHOLDER = 360;
type PendingConnection = { nodeId: string; handleId: string } | null;

function makeIdentifier(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

export function fitToonCanvasViewport(nodes: ToonNode[], width: number, height: number, assistantPlaceholder = 0) {
  if (!nodes.length || width <= 0 || height <= 0) return { x: 0, y: 0, zoom: 1 };
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + CANVAS_NODE_WIDTH));
  const maxY = Math.max(...nodes.map((node) => node.position.y + CANVAS_NODE_HEIGHT));
  const availableWidth = Math.max(1, width - assistantPlaceholder - CANVAS_FIT_PADDING * 2);
  const availableHeight = Math.max(1, height - CANVAS_FIT_PADDING * 2);
  const zoom = Math.min(2.5, Math.max(0.1, Math.min(availableWidth / Math.max(1, maxX - minX), availableHeight / Math.max(1, maxY - minY))));
  return { x: (width - assistantPlaceholder) / 2 - ((minX + maxX) / 2) * zoom, y: height / 2 - ((minY + maxY) / 2) * zoom, zoom };
}

export function ToonLegacyCanvas(props: { canvas: ToonCanvas; onChange: (canvas: ToonCanvas) => void; imageGenerationAvailable: boolean; videoGenerationAvailable: boolean }) {
  const [pendingConnection, setPendingConnection] = useState<PendingConnection>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const canvasElementRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ kind: "canvas" | "node"; id?: string; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const viewport = props.canvas.viewport;
  const positions = new Map(props.canvas.nodes.map((node) => [node.id, node.position]));
  const addNode = (kind: ToonNodeKind) => { const nodeId = makeIdentifier(kind); props.onChange({ ...props.canvas, nodes: [...props.canvas.nodes, createNode(kind, nodeId, props.canvas.nodes.length)], selectedNodeId: nodeId }); };
  const setZoom = (zoom: number) => props.onChange({ ...props.canvas, viewport: { ...viewport, zoom: Math.min(2.5, Math.max(0.35, zoom)) } });
  const fitCanvas = () => { const element = canvasElementRef.current; props.onChange({ ...props.canvas, viewport: fitToonCanvasViewport(props.canvas.nodes, element?.clientWidth || 1200, element?.clientHeight || 800, element ? 0 : CANVAS_ASSISTANT_PLACEHOLDER) }); };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current; if (!drag) return;
    if (drag.kind === "canvas") { props.onChange({ ...props.canvas, viewport: { ...viewport, x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY } }); return; }
    props.onChange({ ...props.canvas, nodes: props.canvas.nodes.map((node) => node.id === drag.id ? { ...node, position: { x: drag.originX + (event.clientX - drag.startX) / viewport.zoom, y: drag.originY + (event.clientY - drag.startY) / viewport.zoom } } : node) });
  };
  const zoom = (event: WheelEvent<HTMLDivElement>) => { event.preventDefault(); setZoom(viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1)); };
  const handleClick = (node: ToonNode, handleId: string, direction: "source" | "target") => {
    if (direction === "source") { setPendingConnection({ nodeId: node.id, handleId }); setConnectionError(null); return; }
    if (!pendingConnection) return;
    const candidate = { sourceNodeId: pendingConnection.nodeId, sourceHandleId: pendingConnection.handleId, targetNodeId: node.id, targetHandleId: handleId };
    const result = validateToonConnection(props.canvas, candidate);
    if (!result.valid) { setConnectionError(t(`toon_factory.edge_${result.reason.replaceAll("-", "_")}`)); return; }
    props.onChange({ ...props.canvas, edges: [...props.canvas.edges, { id: makeIdentifier("edge"), ...candidate }] }); setPendingConnection(null); setConnectionError(null);
  };
  const nodeKeyDown = (event: KeyboardEvent<HTMLDivElement>, node: ToonNode) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onChange({ ...props.canvas, selectedNodeId: node.id }); return; }
    const movement = event.shiftKey ? 25 : 8;
    const delta = event.key === "ArrowLeft" ? { x: -movement, y: 0 } : event.key === "ArrowRight" ? { x: movement, y: 0 } : event.key === "ArrowUp" ? { x: 0, y: -movement } : event.key === "ArrowDown" ? { x: 0, y: movement } : null;
    if (!delta) return; event.preventDefault();
    props.onChange({ ...props.canvas, selectedNodeId: node.id, nodes: props.canvas.nodes.map((candidate) => candidate.id === node.id ? { ...candidate, position: { x: candidate.position.x + delta.x, y: candidate.position.y + delta.y } } : candidate) });
  };
  return <div ref={canvasElementRef} className={cn("absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_1px_1px,var(--dls-border)_1px,transparent_0)] [background-size:20px_20px]", tool === "hand" ? "cursor-grab" : "cursor-default")} onDoubleClick={(event) => { if ((event.target as HTMLElement).closest("button,[data-toon-node]")) return; addNode("text"); }} onWheel={zoom} onPointerMove={pointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} onPointerDown={(event) => { if ((event.target as HTMLElement).closest("button,[data-toon-node]")) return; if (tool === "hand") { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { kind: "canvas", startX: event.clientX, startY: event.clientY, originX: viewport.x, originY: viewport.y }; } props.onChange({ ...props.canvas, selectedNodeId: undefined }); }} data-testid="toon-node-canvas">
    {!props.canvas.nodes.length ? <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6" data-testid="toon-canvas-empty"><div className="pointer-events-auto max-w-2xl text-center"><Sparkles className="mx-auto size-6 text-dls-secondary" /><h2 className="mt-3 text-sm font-semibold text-dls-text">{t("toon_factory.double_click_to_add")}</h2><p className="mt-1 text-xs text-dls-secondary">{t("toon_factory.empty_canvas_hint")}</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => addNode("image-generation")} disabled={!props.imageGenerationAvailable} title={!props.imageGenerationAvailable ? t("toon_factory.image_model_required") : undefined} className="flex items-center gap-2 rounded-xl border border-dls-border bg-background px-4 py-2 text-xs text-dls-text shadow-sm disabled:opacity-40"><Image className="size-4" />{t("toon_factory.image_generation")}</button><button type="button" onClick={() => addNode("video-generation")} disabled={!props.videoGenerationAvailable} title={!props.videoGenerationAvailable ? t("toon_factory.video_model_required") : undefined} className="flex items-center gap-2 rounded-xl border border-dls-border bg-background px-4 py-2 text-xs text-dls-text shadow-sm disabled:opacity-40"><Video className="size-4" />{t("toon_factory.video_generation")}</button></div></div></div> : null}
    {connectionError ? <div className="absolute bottom-3 left-3 z-30 rounded-lg bg-destructive px-3 py-2 text-[10px] text-white" role="alert">{connectionError}</div> : null}
    {pendingConnection ? <div className="absolute bottom-3 right-3 z-30 rounded-lg border border-dls-border bg-background px-3 py-2 text-[10px] text-dls-secondary" role="status">{t("toon_factory.choose_target_handle")}</div> : null}
    <div className="absolute left-0 top-0 h-[1600px] w-[2400px] origin-top-left" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">{props.canvas.edges.map((edge) => { const source = positions.get(edge.sourceNodeId); const target = positions.get(edge.targetNodeId); if (!source || !target) return null; const x1 = source.x + 220; const y1 = source.y + 60; const x2 = target.x; const y2 = target.y + 60; return <path key={edge.id} d={`M ${x1} ${y1} C ${x1 + 90} ${y1}, ${x2 - 90} ${y2}, ${x2} ${y2}`} fill="none" stroke="var(--dls-accent)" strokeWidth="2" />; })}</svg>
      {props.canvas.nodes.map((node) => { const nodeLabel = node.data.label ?? t(TOON_NODE_DEFINITIONS.find((item) => item.kind === node.kind)!.labelKey); return <div key={node.id} role="button" tabIndex={0} aria-label={nodeLabel} aria-pressed={props.canvas.selectedNodeId === node.id} className={cn("absolute w-[220px] rounded-xl border bg-background shadow-[var(--dls-card-shadow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent", props.canvas.selectedNodeId === node.id ? "border-dls-accent ring-2 ring-dls-accent/15" : "border-dls-border")} style={{ transform: `translate(${node.position.x}px, ${node.position.y}px)` }} onKeyDown={(event) => nodeKeyDown(event, node)} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { kind: "node", id: node.id, startX: event.clientX, startY: event.clientY, originX: node.position.x, originY: node.position.y }; props.onChange({ ...props.canvas, selectedNodeId: node.id }); }} data-toon-node={node.id} data-testid={`toon-node-${node.kind}`}><div className="cursor-grab border-b border-dls-border px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-dls-secondary">{t(`toon_factory.node_kind_${node.kind.replaceAll("-", "_")}`)}</p><p className="truncate text-xs font-semibold text-dls-text">{nodeLabel}</p></div><div className="relative min-h-12 px-3 py-2 text-[10px] text-dls-secondary">{node.data.contentRef ?? node.data.assetRef ?? t("toon_factory.node_unconfigured")}{node.handles.map((handle, index) => <button key={handle.id} type="button" title={`${handle.direction}: ${handle.dataType}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); handleClick(node, handle.id, handle.direction); }} className={cn("absolute size-3 rounded-full border-2 border-background", handle.direction === "source" ? "-right-1.5 bg-dls-accent" : "-left-1.5 bg-amber-500")} style={{ top: 10 + index * 15 }} data-testid={`toon-handle-${node.id}-${handle.id}`} />)}</div></div>; })}
    </div>
    <div className="absolute bottom-3 left-3 z-30 flex items-center gap-0.5 rounded-xl border border-dls-border bg-background/95 p-1 shadow-md backdrop-blur" data-testid="toon-canvas-controls"><span className="hidden px-2 text-[10px] text-dls-secondary sm:inline">{t("toon_factory.node_count", { count: props.canvas.nodes.length })}</span><button type="button" onClick={fitCanvas} className="rounded-lg p-2 text-dls-secondary hover:bg-dls-hover" aria-label={t("toon_factory.fit_canvas")} data-testid="toon-canvas-fit"><Maximize className="size-3.5" /></button><button type="button" onClick={() => setZoom(viewport.zoom - 0.1)} className="rounded-lg p-2 text-dls-secondary hover:bg-dls-hover" aria-label={t("toon_factory.zoom_out")} data-testid="toon-canvas-zoom-out"><Minus className="size-3.5" /></button><button type="button" onClick={() => setZoom(1)} className="min-w-12 rounded-lg px-1 py-2 text-[10px] text-dls-secondary hover:bg-dls-hover" aria-label={t("toon_factory.reset_zoom")} data-testid="toon-canvas-zoom-reset">{Math.round(viewport.zoom * 100)}%</button><button type="button" onClick={() => setZoom(viewport.zoom + 0.1)} className="rounded-lg p-2 text-dls-secondary hover:bg-dls-hover" aria-label={t("toon_factory.zoom_in")} data-testid="toon-canvas-zoom-in"><Plus className="size-3.5" /></button></div>
    <div className="absolute bottom-3 left-1/2 z-30 -translate-x-1/2" data-testid="toon-canvas-bottom-toolbar">{paletteOpen ? <div className="absolute bottom-full left-1/2 mb-2 flex max-h-52 w-[min(560px,calc(100vw-5rem))] -translate-x-1/2 flex-wrap justify-center gap-1 overflow-y-auto rounded-xl border border-dls-border bg-background/95 p-2 shadow-lg backdrop-blur" data-testid="toon-node-palette">{TOON_NODE_DEFINITIONS.map((definition) => <button key={definition.kind} type="button" onClick={() => { addNode(definition.kind); setPaletteOpen(false); }} className="rounded-lg px-2.5 py-1.5 text-[10px] text-dls-secondary hover:bg-dls-hover hover:text-dls-text" data-testid={`toon-add-node-${definition.kind}`}>+ {t(definition.labelKey)}</button>)}</div> : null}<div className="flex items-center gap-0.5 rounded-xl border border-dls-border bg-background/95 p-1 shadow-md backdrop-blur"><button type="button" onClick={() => setPaletteOpen((open) => !open)} aria-expanded={paletteOpen} className={cn("rounded-lg p-2", paletteOpen ? "bg-dls-accent text-white" : "bg-dls-text text-background")} aria-label={t("toon_factory.add_node")}><Plus className="size-4" /></button><button type="button" onClick={() => setTool("select")} aria-pressed={tool === "select"} className={cn("rounded-lg p-2", tool === "select" ? "bg-dls-active text-dls-accent" : "text-dls-secondary hover:bg-dls-hover")} aria-label={t("toon_factory.select_tool")}><MousePointer2 className="size-4" /></button><button type="button" onClick={() => setTool("hand")} aria-pressed={tool === "hand"} className={cn("rounded-lg p-2", tool === "hand" ? "bg-dls-active text-dls-accent" : "text-dls-secondary hover:bg-dls-hover")} aria-label={t("toon_factory.hand_tool")}><Hand className="size-4" /></button><button type="button" disabled title={t("toon_factory.help_unavailable_hint")} className="rounded-lg p-2 text-dls-secondary opacity-50" aria-label={t("toon_factory.help")}><HelpCircle className="size-4" /></button></div></div>
  </div>;
}
