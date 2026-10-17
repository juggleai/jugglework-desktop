/** @jsxImportSource react */
import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyNodeChanges,
  type Connection,
  type NodeChange,
  type NodeProps,
  type OnMoveEnd,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlignCenter, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, BringToFront, Copy, Group, HelpCircle, Maximize, Redo2, Rows3, SendToBack, Ungroup, Undo2, Upload } from "lucide-react";
import type { ToonNodeKind } from "@jugglework/types/toon-factory";
import type { ToonWorkspaceCanvas, ToonWorkspaceNode } from "@jugglework/types/toon-workspace";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  alignToonCanvasNodes,
  connectToonWorkspaceNodes,
  copyToonCanvasSelection,
  createToonCanvasHistory,
  deleteToonCanvasSelection,
  distributeToonCanvasNodes,
  groupToonCanvasSelection,
  pasteToonCanvasSelection,
  recordToonCanvasHistory,
  redoToonCanvas,
  reorderToonCanvasNodes,
  navigateToonCanvasViewport,
  shouldSuppressToonCanvasShortcut,
  snapToonCanvasNodes,
  undoToonCanvas,
  ungroupToonCanvas,
  validateToonWorkspaceConnection,
  toonCanvasCommandKey,
  toonCanvasMinimapState,
  type ToonCanvasClipboard,
  type ToonCanvasHistory,
  type ToonCanvasSnapshot,
} from "./toon-canvas-domain";
import { applyToonFlowPositions, toToonFlowEdges, toToonFlowNodes, toToonViewport, type ToonFlowNode } from "./toon-canvas-xyflow-adapter";

const NODE_KINDS: ToonNodeKind[] = ["text", "asset", "storyboard", "image-asset", "video-asset", "image-generation", "video-generation"];

function id(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function createNode(kind: ToonNodeKind, position: { x: number; y: number }): ToonWorkspaceNode {
  const nodeId = id(kind);
  const dataType = kind === "text" ? "text" : kind === "storyboard" ? "storyboard" : kind.includes("video") ? "video" : kind.includes("image") ? "image" : "asset";
  return {
    id: nodeId,
    kind,
    position,
    handles: [
      { id: `${nodeId}-in`, direction: "target", dataType },
      { id: `${nodeId}-out`, direction: "source", dataType },
    ],
    config: { label: t(`toon_factory.node_${kind.replaceAll("-", "_")}`) },
  };
}

function ToonGraphNode({ data, selected }: NodeProps<ToonFlowNode>) {
  const node = data.node;
  if (!node) return <div className="h-full w-full rounded-2xl border-2 border-dashed border-dls-accent/40 bg-dls-accent/5 p-3 text-xs font-semibold text-dls-accent">{data.label}</div>;
  return <div className={cn("min-w-48 rounded-2xl border bg-background/95 shadow-md", selected ? "border-dls-accent ring-2 ring-dls-accent/20" : "border-dls-border")} data-testid={`toon-v2-node-${node.id}`}>
    {node.handles.map((handle, index) => <Handle key={handle.id} id={handle.id} type={handle.direction} position={handle.direction === "source" ? Position.Right : Position.Left} style={{ top: 28 + index * 18 }} title={`${handle.direction}: ${handle.dataType}`} />)}
    <div className="rounded-t-2xl border-b border-dls-border bg-[var(--app-list-bg)] px-3 py-2 text-[10px] font-semibold text-dls-text">{data.label}</div>
    <div className="px-3 py-3 text-[10px] text-dls-secondary">{node.kind}</div>
  </div>;
}

export type ToonSpatialCanvasProps = {
  canvas: ToonWorkspaceCanvas;
  selection: string[];
  visible: boolean;
  history: ToonCanvasHistory;
  conflict: boolean;
  readOnly?: boolean;
  assistantWidth: number;
  onChange: (snapshot: ToonCanvasSnapshot, history: ToonCanvasHistory) => void;
  onImportFiles?: (files: File[], position: { x: number; y: number }) => Promise<void>;
};

function SpatialCanvas(props: ToonSpatialCanvasProps) {
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const [showGuides, setShowGuides] = useState(false);
  const clipboardRef = useRef<ToonCanvasClipboard | null>(null);
  const gestureRef = useRef<ToonCanvasSnapshot | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const flowRef = useRef<{ fitView: (options?: object) => Promise<boolean>; screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number }; zoomIn: (options?: object) => Promise<boolean>; zoomOut: (options?: object) => Promise<boolean>; setViewport: (viewport: { x: number; y: number; zoom: number }, options?: object) => Promise<boolean> } | null>(null);
  const snapshot = (): ToonCanvasSnapshot => ({ canvas: props.canvas, selection: props.selection });
  const commit = (next: ToonCanvasSnapshot, label: string, coalesceKey?: string, before = snapshot()) => props.onChange(next, recordToonCanvasHistory(props.history, before, next, { label, coalesceKey }));
  const selectedNodes = props.canvas.nodes.filter((node) => props.selection.includes(node.id));
  const selectedGroups = (props.canvas.groups ?? []).filter((group) => props.selection.includes(group.id));
  const canGroup = selectedNodes.length >= 2 && selectedNodes.every((node) => !node.parentGroupId);
  const canUngroup = selectedGroups.length === 1;
  const minimap = toonCanvasMinimapState(props.canvas);
  const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const setViewport = (viewport: ToonWorkspaceCanvas["viewport"]) => {
    void flowRef.current?.setViewport(viewport, { duration: reducedMotion() ? 0 : 140 });
    if (!props.readOnly) props.onChange({ canvas: { ...props.canvas, viewport }, selection: props.selection }, props.history);
  };

  const onNodesChange = (changes: NodeChange<ToonFlowNode>[]) => {
    const started = changes.some((change) => change.type === "position" && change.dragging === true);
    if (started && !gestureRef.current) { gestureRef.current = snapshot(); setShowGuides(true); }
    const nextFlow = applyNodeChanges(changes, toToonFlowNodes(props.canvas, props.selection));
    const nextCanvas = applyToonFlowPositions(props.canvas, nextFlow);
    const nextSelection = nextFlow.filter((node) => node.selected).map((node) => node.id);
    const next = { canvas: nextCanvas, selection: nextSelection };
    const ended = changes.some((change) => change.type === "position" && change.dragging === false);
    if (ended && gestureRef.current) {
      const before = gestureRef.current; gestureRef.current = null; setShowGuides(false);
      commit({ ...next, canvas: snapToonCanvasNodes(next.canvas, nextSelection) }, t("toon_factory.history_move"), `drag:${nextSelection.sort().join(",")}`, before);
    } else props.onChange(next, props.history);
  };
  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const domainConnection = { sourceNodeId: connection.source, sourceHandleId: connection.sourceHandle, targetNodeId: connection.target, targetHandleId: connection.targetHandle };
    const result = validateToonWorkspaceConnection(props.canvas, domainConnection);
    if (!result.valid) { setConnectionError(t(`toon_factory.connection_${result.reason}`)); return; }
    setConnectionError(null);
    commit({ canvas: connectToonWorkspaceNodes(props.canvas, domainConnection, id("edge")), selection: props.selection }, t("toon_factory.history_connect"));
  };
  const removeSelection = () => commit({ canvas: deleteToonCanvasSelection(props.canvas, props.selection), selection: [] }, t("toon_factory.history_delete"));
  const paste = () => {
    if (!clipboardRef.current) return;
    const next = pasteToonCanvasSelection(props.canvas, clipboardRef.current, (kind) => id(kind));
    commit(next, t("toon_factory.history_paste"));
  };
  const duplicate = () => {
    const copied = copyToonCanvasSelection(props.canvas, props.selection);
    const next = pasteToonCanvasSelection(props.canvas, copied, (kind) => id(kind));
    commit(next, t("toon_factory.history_duplicate"));
  };
  const applyHistory = (direction: "undo" | "redo") => {
    const result = direction === "undo" ? undoToonCanvas(props.history) : redoToonCanvas(props.history);
    if (result.snapshot) props.onChange(result.snapshot, result.history);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (shouldSuppressToonCanvasShortcut(event.target) || props.conflict || props.readOnly) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === "a") { event.preventDefault(); props.onChange({ canvas: props.canvas, selection: [...(props.canvas.groups ?? []).map((group) => group.id), ...props.canvas.nodes.map((node) => node.id)] }, props.history); }
    else if (command && key === "c") { event.preventDefault(); clipboardRef.current = copyToonCanvasSelection(props.canvas, props.selection); }
    else if (command && key === "x") { event.preventDefault(); clipboardRef.current = copyToonCanvasSelection(props.canvas, props.selection); removeSelection(); }
    else if (command && key === "v") { event.preventDefault(); paste(); }
    else if (command && key === "d") { event.preventDefault(); duplicate(); }
    else if (command && key === "z") { event.preventDefault(); applyHistory(event.shiftKey ? "redo" : "undo"); }
    else if (command && key === "y") { event.preventDefault(); applyHistory("redo"); }
    else if (key === "delete" || key === "backspace") { event.preventDefault(); removeSelection(); }
    else if (key === "?" || (event.shiftKey && key === "/")) { event.preventDefault(); setHelpOpen(true); }
    else if (key === "f") { event.preventDefault(); void flowRef.current?.fitView({ padding: 0.16, duration: reducedMotion() ? 0 : 180 }); }
    else if (key === "+" || key === "=") { event.preventDefault(); void flowRef.current?.zoomIn(); }
    else if (key === "-") { event.preventDefault(); void flowRef.current?.zoomOut(); }
    else if (key === "0") { event.preventDefault(); setViewport({ x: 0, y: 0, zoom: 1 }); }
    else if (["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key) && selectedNodes.length) {
      event.preventDefault();
      const step = event.shiftKey ? 20 : 4;
      const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
      const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
      const nextCanvas = { ...props.canvas, nodes: props.canvas.nodes.map((node) => props.selection.includes(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node) };
      commit({ canvas: nextCanvas, selection: props.selection }, t("toon_factory.history_move"), `keyboard:${props.selection.sort().join(",")}`);
    }
  };
  const addNodeAtCenter = (kind: ToonNodeKind) => {
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const point = flowRef.current?.screenToFlowPosition({ x: (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2, y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2 }) ?? { x: 100, y: 100 };
    const nextNode = createNode(kind, point);
    commit({ canvas: { ...props.canvas, nodes: [...props.canvas.nodes, nextNode] }, selection: [nextNode.id] }, t("toon_factory.history_create"));
  };
  const importAtCenter = (files: File[]) => {
    if (!props.onImportFiles || !files.length) return;
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const position = flowRef.current?.screenToFlowPosition({ x: (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2, y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2 }) ?? { x: 100, y: 100 };
    void props.onImportFiles(files, position).then(() => setDropMessage(null)).catch((cause) => setDropMessage(cause instanceof Error ? cause.message : String(cause)));
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer.files.length) {
      const position = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: event.clientX, y: event.clientY };
      void props.onImportFiles?.([...event.dataTransfer.files], position).then(() => setDropMessage(null)).catch((cause) => setDropMessage(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    const kind = event.dataTransfer.getData("application/x-jugglework-toon-node") as ToonNodeKind;
    if (!NODE_KINDS.includes(kind)) { setDropMessage(t("toon_factory.internal_drop_only")); return; }
    const position = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: event.clientX, y: event.clientY };
    const nextNode = createNode(kind, position);
    commit({ canvas: { ...props.canvas, nodes: [...props.canvas.nodes, nextNode] }, selection: [nextNode.id] }, t("toon_factory.history_create"));
    setDropMessage(null);
  };
  const pasteFiles = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = [...event.clipboardData.files];
    if (!files.length || !props.onImportFiles) return;
    event.preventDefault();
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const position = flowRef.current?.screenToFlowPosition({ x: (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2, y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2 }) ?? { x: 100, y: 100 };
    void props.onImportFiles(files, position).then(() => setDropMessage(null)).catch((cause) => setDropMessage(cause instanceof Error ? cause.message : String(cause)));
  };
  const moveEnd: OnMoveEnd = (_event, viewport) => { if (!props.readOnly) props.onChange({ canvas: { ...props.canvas, viewport: toToonViewport(viewport) }, selection: props.selection }, props.history); };
  const arrange = (nextCanvas: ToonWorkspaceCanvas, label: string) => commit({ canvas: nextCanvas, selection: props.selection }, label);
  const renameSelectedNode = (label: string) => {
    const selected = selectedNodes[0];
    if (!selected) return;
    const nextCanvas = { ...props.canvas, nodes: props.canvas.nodes.map((node) => node.id === selected.id ? { ...node, config: { ...node.config, label } } : node) };
    commit({ canvas: nextCanvas, selection: props.selection }, t("toon_factory.history_text"), `text:${selected.id}`);
  };

  if (!props.visible) return <div data-testid="toon-v2-canvas-suspended" />;
  return <div ref={wrapperRef} className="relative h-full min-h-0 outline-none" tabIndex={0} onKeyDown={keyDown} onPaste={props.readOnly ? undefined : pasteFiles} onDrop={props.readOnly ? undefined : drop} onDragOver={props.readOnly ? undefined : (event) => event.preventDefault()} data-testid="toon-v2-spatial-canvas">
    <ReactFlow
      nodes={toToonFlowNodes(props.canvas, props.selection)} edges={toToonFlowEdges(props.canvas, props.selection)} nodeTypes={{ "toon-node": ToonGraphNode, "toon-group": ToonGraphNode }}
      onInit={(instance) => { flowRef.current = instance; }} onNodesChange={props.readOnly ? undefined : onNodesChange} onConnect={props.readOnly ? undefined : connect}
      onEdgesDelete={props.readOnly ? undefined : (edges) => commit({ canvas: { ...props.canvas, edges: props.canvas.edges.filter((edge) => !edges.some((removed) => removed.id === edge.id)) }, selection: props.selection }, t("toon_factory.history_disconnect"))}
      onSelectionChange={props.readOnly ? undefined : ({ nodes, edges }) => props.onChange({ canvas: props.canvas, selection: [...nodes.map((node) => node.id), ...edges.map((edge) => edge.id)] }, props.history)}
      onMoveEnd={moveEnd} defaultViewport={props.canvas.viewport} selectionMode={SelectionMode.Partial} selectionOnDrag panOnDrag={[1, 2]} multiSelectionKeyCode={["Meta", "Control"]}
      nodesDraggable={!props.readOnly} nodesConnectable={!props.readOnly} elementsSelectable deleteKeyCode={null} minZoom={0.1} maxZoom={2.5} snapToGrid snapGrid={[20, 20]} fitViewOptions={{ padding: 0.16 }} attributionPosition="bottom-right">
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--dls-border)" />
      <MiniMap pannable zoomable ariaLabel={t("toon_factory.minimap")} nodeColor="var(--dls-accent)" maskColor="color-mix(in srgb, var(--app-page-bg) 75%, transparent)" position="bottom-right" style={{ marginBottom: 48 }} />
    </ReactFlow>
    {showGuides ? <div className="pointer-events-none absolute inset-0 z-[5]" aria-hidden="true"><div className="absolute inset-y-0 left-1/2 border-l border-dashed border-dls-accent/50" /><div className="absolute inset-x-0 top-1/2 border-t border-dashed border-dls-accent/50" /></div> : null}
    <fieldset disabled={props.readOnly} className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-15rem)] flex-wrap gap-1 rounded-xl border border-dls-border bg-background/95 p-1 shadow-md max-[760px]:max-w-[calc(100%-1.5rem)] max-[760px]:bottom-14 disabled:opacity-60" data-testid="toon-v2-canvas-tools">
      <button type="button" onClick={() => applyHistory("undo")} disabled={props.readOnly || !props.history.past.length || props.conflict} title={props.readOnly ? t("toon_factory.lease_read_only") : t("toon_factory.undo")} className="rounded-lg p-2 disabled:opacity-30"><Undo2 className="size-3.5" /></button>
      <button type="button" onClick={() => applyHistory("redo")} disabled={props.readOnly || !props.history.future.length || props.conflict} title={props.readOnly ? t("toon_factory.lease_read_only") : t("toon_factory.redo")} className="rounded-lg p-2 disabled:opacity-30"><Redo2 className="size-3.5" /></button>
      <button type="button" onClick={() => void flowRef.current?.fitView({ padding: 0.16 })} title={t("toon_factory.fit_canvas")} className="rounded-lg p-2"><Maximize className="size-3.5" /></button>
      <button type="button" onClick={() => { const next = groupToonCanvasSelection(props.canvas, props.selection, id("group"), t("toon_factory.group")); commit(next, t("toon_factory.history_group")); }} disabled={props.readOnly || !canGroup} title={props.readOnly ? t("toon_factory.lease_read_only") : canGroup ? t("toon_factory.group") : t("toon_factory.group_disabled")} className="rounded-lg p-2 disabled:opacity-30"><Group className="size-3.5" /></button>
      <button type="button" onClick={() => { const next = ungroupToonCanvas(props.canvas, selectedGroups[0]!.id); commit(next, t("toon_factory.history_ungroup")); }} disabled={props.readOnly || !canUngroup} title={props.readOnly ? t("toon_factory.lease_read_only") : canUngroup ? t("toon_factory.ungroup") : t("toon_factory.ungroup_disabled")} className="rounded-lg p-2 disabled:opacity-30"><Ungroup className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(alignToonCanvasNodes(props.canvas, props.selection, "left"), t("toon_factory.history_align"))} disabled={props.readOnly || selectedNodes.length < 2} title={props.readOnly ? t("toon_factory.lease_read_only") : t("toon_factory.align_left")} className="rounded-lg p-2 disabled:opacity-30"><AlignLeft className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(alignToonCanvasNodes(props.canvas, props.selection, "center"), t("toon_factory.history_align"))} disabled={selectedNodes.length < 2} title={t("toon_factory.align_center")} className="rounded-lg p-2 disabled:opacity-30"><AlignCenter className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(alignToonCanvasNodes(props.canvas, props.selection, "right"), t("toon_factory.history_align"))} disabled={selectedNodes.length < 2} title={t("toon_factory.align_right")} className="rounded-lg p-2 disabled:opacity-30"><AlignRight className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(alignToonCanvasNodes(props.canvas, props.selection, "top"), t("toon_factory.history_align"))} disabled={selectedNodes.length < 2} title={t("toon_factory.align_top")} className="rounded-lg p-2 disabled:opacity-30"><AlignVerticalJustifyStart className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(alignToonCanvasNodes(props.canvas, props.selection, "middle"), t("toon_factory.history_align"))} disabled={selectedNodes.length < 2} title={t("toon_factory.align_middle")} className="rounded-lg p-2 disabled:opacity-30"><AlignVerticalJustifyCenter className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(alignToonCanvasNodes(props.canvas, props.selection, "bottom"), t("toon_factory.history_align"))} disabled={selectedNodes.length < 2} title={t("toon_factory.align_bottom")} className="rounded-lg p-2 disabled:opacity-30"><AlignVerticalJustifyEnd className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(distributeToonCanvasNodes(props.canvas, props.selection, "horizontal"), t("toon_factory.history_distribute"))} disabled={selectedNodes.length < 3} title={t("toon_factory.distribute_horizontal")} className="rounded-lg p-2 disabled:opacity-30"><Copy className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(distributeToonCanvasNodes(props.canvas, props.selection, "vertical"), t("toon_factory.history_distribute"))} disabled={selectedNodes.length < 3} title={t("toon_factory.distribute_vertical")} className="rounded-lg p-2 disabled:opacity-30"><Rows3 className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(snapToonCanvasNodes(props.canvas, props.selection), t("toon_factory.history_snap"))} disabled={!selectedNodes.length} title={t("toon_factory.snap_grid")} className="rounded-lg px-2 text-[10px] disabled:opacity-30">20px</button>
      <button type="button" onClick={() => arrange(reorderToonCanvasNodes(props.canvas, props.selection, "front"), t("toon_factory.history_zorder"))} disabled={!selectedNodes.length} title={t("toon_factory.bring_front")} className="rounded-lg p-2 disabled:opacity-30"><BringToFront className="size-3.5" /></button>
      <button type="button" onClick={() => arrange(reorderToonCanvasNodes(props.canvas, props.selection, "back"), t("toon_factory.history_zorder"))} disabled={!selectedNodes.length} title={t("toon_factory.send_back")} className="rounded-lg p-2 disabled:opacity-30"><SendToBack className="size-3.5" /></button>
      <button type="button" onClick={() => setHelpOpen(true)} title={t("toon_factory.help")} className="rounded-lg p-2"><HelpCircle className="size-3.5" /></button>
      {props.onImportFiles ? <><button type="button" disabled={props.readOnly} onClick={() => importInputRef.current?.click()} title={props.readOnly ? t("toon_factory.lease_read_only") : "Import asset at canvas center"} className="rounded-lg p-2 disabled:opacity-30"><Upload className="size-3.5" /></button><input ref={importInputRef} hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,text/plain,.md" onChange={(event) => { importAtCenter([...(event.target.files ?? [])]); event.currentTarget.value = ""; }} /></> : null}
    </fieldset>
    <div role="navigation" tabIndex={0} aria-label={t("toon_factory.minimap_navigation")} aria-describedby="toon-minimap-help" onKeyDown={(event) => { const key = event.key === "=" ? "+" : event.key; if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "0"].includes(key)) return; event.preventDefault(); setViewport(navigateToonCanvasViewport(props.canvas.viewport, key as Parameters<typeof navigateToonCanvasViewport>[1], event.shiftKey)); }} className="absolute bottom-3 right-3 z-10 rounded-xl border border-dls-border bg-background/95 px-2 py-1 text-[10px] text-dls-secondary shadow-md outline-none focus:ring-2 focus:ring-dls-accent" data-testid="toon-minimap-keyboard" data-visible-node-count={minimap.visibleNodeIds.length} data-bounds={`${minimap.bounds.x},${minimap.bounds.y},${minimap.bounds.width},${minimap.bounds.height}`}><span aria-hidden="true">{Math.round(props.canvas.viewport.zoom * 100)}%</span><span id="toon-minimap-help" className="sr-only">{t("toon_factory.minimap_keyboard_hint")}</span></div>
    <fieldset disabled={props.readOnly} className="absolute left-1/2 top-20 z-10 flex -translate-x-1/2 gap-1 rounded-xl border border-dls-border bg-background/95 p-1 shadow-sm disabled:opacity-60" aria-label={t("toon_factory.add_node")}>
      {NODE_KINDS.map((kind) => <button key={kind} type="button" disabled={props.readOnly} draggable={!props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : undefined} onDragStart={(event) => event.dataTransfer.setData("application/x-jugglework-toon-node", kind)} onClick={() => addNodeAtCenter(kind)} className="rounded-lg px-2 py-1 text-[9px] text-dls-secondary hover:bg-dls-hover disabled:opacity-30">{kind}</button>)}
    </fieldset>
    {selectedNodes.length === 1 ? <label className="absolute right-3 top-20 z-10 flex items-center gap-2 rounded-xl border border-dls-border bg-background/95 px-2 py-1 text-[10px] text-dls-secondary shadow-sm" data-canvas-shortcuts="disabled">{t("toon_factory.node_title")}<input value={selectedNodes[0]!.config.label ?? ""} disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : undefined} onChange={(event) => renameSelectedNode(event.target.value)} className="w-36 rounded-lg border border-dls-border bg-background px-2 py-1 text-dls-text outline-none focus:border-dls-accent disabled:opacity-50" /></label> : null}
    {connectionError ? <div role="alert" className="absolute left-3 top-32 z-20 rounded-lg bg-destructive px-3 py-2 text-xs text-white">{connectionError}</div> : null}
    {dropMessage ? <div role="status" className="absolute left-3 top-32 z-20 rounded-lg border border-amber-500/30 bg-background px-3 py-2 text-xs text-amber-700">{dropMessage}</div> : null}
    {helpOpen ? <div role="dialog" aria-modal="true" aria-label={t("toon_factory.shortcut_help")} className="absolute inset-0 z-40 flex items-center justify-center bg-black/20 p-6" data-canvas-shortcuts="disabled" onKeyDown={(event) => { if (event.key === "Escape") setHelpOpen(false); }}><div className="w-full max-w-md rounded-2xl border border-dls-border bg-background p-5 shadow-xl"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{t("toon_factory.shortcut_help")}</h2><button type="button" autoFocus onClick={() => setHelpOpen(false)} className="rounded-lg border border-dls-border px-2 py-1 text-xs">Esc</button></div><ShortcutReference history={props.history} selectionCount={props.selection.length} clipboard={Boolean(clipboardRef.current)} conflict={props.conflict} /></div></div> : null}
  </div>;
}

function ShortcutReference(props: { history: ToonCanvasHistory; selectionCount: number; clipboard: boolean; conflict: boolean }) {
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";
  const rows = [
    [t("toon_factory.undo"), toonCanvasCommandKey(platform, "Z"), props.history.past.length > 0 && !props.conflict, props.conflict ? t("toon_factory.disabled_conflict") : t("toon_factory.disabled_history_empty")],
    [t("toon_factory.redo"), toonCanvasCommandKey(platform, "Shift+Z"), props.history.future.length > 0 && !props.conflict, props.conflict ? t("toon_factory.disabled_conflict") : t("toon_factory.disabled_history_empty")],
    [t("toon_factory.copy"), toonCanvasCommandKey(platform, "C"), props.selectionCount > 0, t("toon_factory.disabled_selection_required")],
    [t("toon_factory.paste"), toonCanvasCommandKey(platform, "V"), props.clipboard, t("toon_factory.disabled_clipboard_empty")],
    [t("toon_factory.delete"), "Delete", props.selectionCount > 0, t("toon_factory.disabled_selection_required")],
    [t("toon_factory.fit_canvas"), "F", true, ""],
  ] as const;
  return <div className="mt-4 space-y-1">{rows.map(([label, keys, enabled, reason]) => <div key={label} className="flex items-center justify-between gap-3 rounded-lg bg-[var(--app-list-bg)] px-3 py-2 text-xs"><span className={enabled ? "text-dls-text" : "text-dls-secondary"}>{label}{!enabled ? ` · ${reason}` : ""}</span><kbd className="rounded border border-dls-border bg-background px-2 py-1 text-[10px]">{keys}</kbd></div>)}</div>;
}

export function ToonSpatialCanvas(props: ToonSpatialCanvasProps) {
  return <ReactFlowProvider><SpatialCanvas {...props} /></ReactFlowProvider>;
}

export { createToonCanvasHistory };
