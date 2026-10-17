import type {
  ToonCanvasGroup,
  ToonWorkspaceCanvas,
  ToonWorkspaceNode,
} from "@jugglework/types/toon-workspace";
import type { ToonEdge } from "@jugglework/types/toon-factory";

export type ToonCanvasSnapshot = {
  canvas: ToonWorkspaceCanvas;
  selection: string[];
};

export type ToonCanvasHistoryEntry = {
  before: ToonCanvasSnapshot;
  after: ToonCanvasSnapshot;
  label: string;
  coalesceKey?: string;
  committedAt: number;
};

export type ToonCanvasHistory = {
  past: ToonCanvasHistoryEntry[];
  future: ToonCanvasHistoryEntry[];
  limit: number;
  blocked: boolean;
};

export type ToonCanvasClipboard = {
  nodes: ToonWorkspaceNode[];
  edges: ToonEdge[];
  groups: ToonCanvasGroup[];
};

export type ToonConnection = {
  sourceNodeId: string;
  sourceHandleId: string;
  targetNodeId: string;
  targetHandleId: string;
};

export type ToonConnectionResult =
  | { valid: true }
  | { valid: false; reason: "missing_node" | "missing_handle" | "invalid_direction" | "incompatible_type" | "duplicate_edge" };

export type ToonCanvasMinimapState = {
  bounds: { x: number; y: number; width: number; height: number };
  viewport: ToonWorkspaceCanvas["viewport"];
  visibleNodeIds: string[];
};

export function toonCanvasMinimapState(canvas: ToonWorkspaceCanvas): ToonCanvasMinimapState {
  const groups = new Map((canvas.groups ?? []).map((group) => [group.id, group]));
  const points = canvas.nodes.map((node) => {
    const parent = node.parentGroupId ? groups.get(node.parentGroupId) : undefined;
    return { id: node.id, x: node.position.x + (parent?.position.x ?? 0), y: node.position.y + (parent?.position.y ?? 0), width: 220, height: 96 };
  });
  const groupPoints = (canvas.groups ?? []).map((group) => ({ id: group.id, x: group.position.x, y: group.position.y, width: 320, height: 220 }));
  const visible = [...groupPoints, ...points];
  if (!visible.length) return { bounds: { x: 0, y: 0, width: 1, height: 1 }, viewport: { ...canvas.viewport }, visibleNodeIds: [] };
  const minX = Math.min(...visible.map((item) => item.x));
  const minY = Math.min(...visible.map((item) => item.y));
  const maxX = Math.max(...visible.map((item) => item.x + item.width));
  const maxY = Math.max(...visible.map((item) => item.y + item.height));
  return { bounds: { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }, viewport: { ...canvas.viewport }, visibleNodeIds: visible.map((item) => item.id) };
}

export function navigateToonCanvasViewport(viewport: ToonWorkspaceCanvas["viewport"], key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "+" | "-" | "0", large = false): ToonWorkspaceCanvas["viewport"] {
  const step = large ? 160 : 64;
  if (key === "+") return { ...viewport, zoom: Math.min(2.5, viewport.zoom * 1.2) };
  if (key === "-") return { ...viewport, zoom: Math.max(0.1, viewport.zoom / 1.2) };
  if (key === "0") return { x: 0, y: 0, zoom: 1 };
  return {
    ...viewport,
    x: viewport.x + (key === "ArrowLeft" ? step : key === "ArrowRight" ? -step : 0),
    y: viewport.y + (key === "ArrowUp" ? step : key === "ArrowDown" ? -step : 0),
  };
}

export function createToonCanvasHistory(limit = 100): ToonCanvasHistory {
  return { past: [], future: [], limit: Math.max(1, limit), blocked: false };
}

export function cloneToonCanvasSnapshot(snapshot: ToonCanvasSnapshot): ToonCanvasSnapshot {
  return structuredClone(snapshot);
}

export function recordToonCanvasHistory(
  history: ToonCanvasHistory,
  before: ToonCanvasSnapshot,
  after: ToonCanvasSnapshot,
  options: { label: string; coalesceKey?: string; committedAt?: number },
): ToonCanvasHistory {
  if (history.blocked || JSON.stringify(before) === JSON.stringify(after)) return history;
  const committedAt = options.committedAt ?? Date.now();
  const previous = history.past.at(-1);
  const coalesces = Boolean(options.coalesceKey
    && previous?.coalesceKey === options.coalesceKey
    && committedAt - previous.committedAt <= 750);
  const entry: ToonCanvasHistoryEntry = coalesces
    ? { ...previous!, after: cloneToonCanvasSnapshot(after), committedAt }
    : {
        before: cloneToonCanvasSnapshot(before),
        after: cloneToonCanvasSnapshot(after),
        label: options.label,
        ...(options.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
        committedAt,
      };
  const past = coalesces ? [...history.past.slice(0, -1), entry] : [...history.past, entry];
  return { ...history, past: past.slice(-history.limit), future: [] };
}

export function undoToonCanvas(history: ToonCanvasHistory): { history: ToonCanvasHistory; snapshot: ToonCanvasSnapshot | null } {
  if (history.blocked || history.past.length === 0) return { history, snapshot: null };
  const entry = history.past.at(-1)!;
  return {
    history: { ...history, past: history.past.slice(0, -1), future: [entry, ...history.future] },
    snapshot: cloneToonCanvasSnapshot(entry.before),
  };
}

export function redoToonCanvas(history: ToonCanvasHistory): { history: ToonCanvasHistory; snapshot: ToonCanvasSnapshot | null } {
  if (history.blocked || history.future.length === 0) return { history, snapshot: null };
  const [entry, ...future] = history.future;
  return {
    history: { ...history, past: [...history.past, entry!].slice(-history.limit), future },
    snapshot: cloneToonCanvasSnapshot(entry!.after),
  };
}

export function validateToonWorkspaceConnection(canvas: ToonWorkspaceCanvas, connection: ToonConnection): ToonConnectionResult {
  const source = canvas.nodes.find((node) => node.id === connection.sourceNodeId);
  const target = canvas.nodes.find((node) => node.id === connection.targetNodeId);
  if (!source || !target) return { valid: false, reason: "missing_node" };
  const sourceHandle = source.handles.find((handle) => handle.id === connection.sourceHandleId);
  const targetHandle = target.handles.find((handle) => handle.id === connection.targetHandleId);
  if (!sourceHandle || !targetHandle) return { valid: false, reason: "missing_handle" };
  if (sourceHandle.direction !== "source" || targetHandle.direction !== "target") return { valid: false, reason: "invalid_direction" };
  if (sourceHandle.dataType !== "any" && targetHandle.dataType !== "any" && sourceHandle.dataType !== targetHandle.dataType) {
    return { valid: false, reason: "incompatible_type" };
  }
  if (canvas.edges.some((edge) => edge.sourceNodeId === connection.sourceNodeId
    && edge.sourceHandleId === connection.sourceHandleId
    && edge.targetNodeId === connection.targetNodeId
    && edge.targetHandleId === connection.targetHandleId)) return { valid: false, reason: "duplicate_edge" };
  return { valid: true };
}

export function connectToonWorkspaceNodes(canvas: ToonWorkspaceCanvas, connection: ToonConnection, edgeId: string): ToonWorkspaceCanvas {
  const result = validateToonWorkspaceConnection(canvas, connection);
  if (!result.valid) return canvas;
  return { ...canvas, edges: [...canvas.edges, { id: edgeId, ...connection }] };
}

export function copyToonCanvasSelection(canvas: ToonWorkspaceCanvas, selection: readonly string[]): ToonCanvasClipboard {
  const selected = new Set(selection);
  const groups = (canvas.groups ?? []).filter((group) => selected.has(group.id));
  const groupIds = new Set(groups.map((group) => group.id));
  const nodes = canvas.nodes.filter((node) => selected.has(node.id) || Boolean(node.parentGroupId && groupIds.has(node.parentGroupId)));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes: structuredClone(nodes),
    groups: structuredClone(groups),
    edges: structuredClone(canvas.edges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId))),
  };
}

export function pasteToonCanvasSelection(
  canvas: ToonWorkspaceCanvas,
  clipboard: ToonCanvasClipboard,
  makeId: (kind: "node" | "edge" | "group", sourceId: string) => string,
  offset = { x: 32, y: 32 },
): ToonCanvasSnapshot {
  const groupIds = new Map(clipboard.groups.map((group) => [group.id, makeId("group", group.id)]));
  const nodeIds = new Map(clipboard.nodes.map((node) => [node.id, makeId("node", node.id)]));
  const groups = clipboard.groups.map((group) => ({
    ...group,
    id: groupIds.get(group.id)!,
    position: { x: group.position.x + offset.x, y: group.position.y + offset.y },
    ...(group.parentGroupId && groupIds.has(group.parentGroupId) ? { parentGroupId: groupIds.get(group.parentGroupId) } : { parentGroupId: undefined }),
  }));
  const nodes = clipboard.nodes.map((node) => ({
    ...node,
    id: nodeIds.get(node.id)!,
    position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
    ...(node.parentGroupId && groupIds.has(node.parentGroupId) ? { parentGroupId: groupIds.get(node.parentGroupId) } : { parentGroupId: undefined }),
  }));
  const edges = clipboard.edges.map((edge) => ({
    ...edge,
    id: makeId("edge", edge.id),
    sourceNodeId: nodeIds.get(edge.sourceNodeId)!,
    targetNodeId: nodeIds.get(edge.targetNodeId)!,
  }));
  return {
    canvas: { ...canvas, groups: [...(canvas.groups ?? []), ...groups], nodes: [...canvas.nodes, ...nodes], edges: [...canvas.edges, ...edges] },
    selection: [...groups.map((group) => group.id), ...nodes.map((node) => node.id)],
  };
}

export function deleteToonCanvasSelection(canvas: ToonWorkspaceCanvas, selection: readonly string[]): ToonWorkspaceCanvas {
  const selected = new Set(selection);
  const removedGroups = new Set((canvas.groups ?? []).filter((group) => selected.has(group.id)).map((group) => group.id));
  const removedNodes = new Set(canvas.nodes.filter((node) => selected.has(node.id) || Boolean(node.parentGroupId && removedGroups.has(node.parentGroupId))).map((node) => node.id));
  return {
    ...canvas,
    groups: (canvas.groups ?? []).filter((group) => !removedGroups.has(group.id)),
    nodes: canvas.nodes.filter((node) => !removedNodes.has(node.id)),
    edges: canvas.edges.filter((edge) => !selected.has(edge.id) && !removedNodes.has(edge.sourceNodeId) && !removedNodes.has(edge.targetNodeId)),
  };
}

export function groupToonCanvasSelection(canvas: ToonWorkspaceCanvas, selection: readonly string[], groupId: string, title: string): ToonCanvasSnapshot {
  const selected = new Set(selection);
  const nodes = canvas.nodes.filter((node) => selected.has(node.id));
  if (nodes.length < 2 || nodes.some((node) => node.parentGroupId)) return { canvas, selection: [...selection] };
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const group: ToonCanvasGroup = { id: groupId, title, position: { x: minX, y: minY } };
  return {
    canvas: {
      ...canvas,
      groups: [...(canvas.groups ?? []), group],
      nodes: canvas.nodes.map((node) => selected.has(node.id)
        ? { ...node, parentGroupId: groupId, position: { x: node.position.x - minX, y: node.position.y - minY } }
        : node),
    },
    selection: [groupId],
  };
}

export function ungroupToonCanvas(canvas: ToonWorkspaceCanvas, groupId: string): ToonCanvasSnapshot {
  const group = (canvas.groups ?? []).find((candidate) => candidate.id === groupId);
  if (!group) return { canvas, selection: [] };
  const members = canvas.nodes.filter((node) => node.parentGroupId === groupId);
  return {
    canvas: {
      ...canvas,
      groups: (canvas.groups ?? []).filter((candidate) => candidate.id !== groupId),
      nodes: canvas.nodes.map((node) => node.parentGroupId === groupId
        ? { ...node, parentGroupId: undefined, position: { x: group.position.x + node.position.x, y: group.position.y + node.position.y } }
        : node),
    },
    selection: members.map((node) => node.id),
  };
}

export type ToonAlignment = "left" | "center" | "right" | "top" | "middle" | "bottom";

export function alignToonCanvasNodes(canvas: ToonWorkspaceCanvas, selection: readonly string[], alignment: ToonAlignment): ToonWorkspaceCanvas {
  const selected = canvas.nodes.filter((node) => selection.includes(node.id));
  if (selected.length < 2) return canvas;
  const xs = selected.map((node) => node.position.x);
  const ys = selected.map((node) => node.position.y);
  const target = alignment === "left" ? Math.min(...xs)
    : alignment === "right" ? Math.max(...xs)
      : alignment === "center" ? (Math.min(...xs) + Math.max(...xs)) / 2
        : alignment === "top" ? Math.min(...ys)
          : alignment === "bottom" ? Math.max(...ys)
            : (Math.min(...ys) + Math.max(...ys)) / 2;
  const horizontal = alignment === "left" || alignment === "center" || alignment === "right";
  return { ...canvas, nodes: canvas.nodes.map((node) => selection.includes(node.id) ? { ...node, position: { ...node.position, [horizontal ? "x" : "y"]: target } } : node) };
}

export function distributeToonCanvasNodes(canvas: ToonWorkspaceCanvas, selection: readonly string[], axis: "horizontal" | "vertical"): ToonWorkspaceCanvas {
  const key = axis === "horizontal" ? "x" : "y";
  const selected = canvas.nodes.filter((node) => selection.includes(node.id)).sort((left, right) => left.position[key] - right.position[key]);
  if (selected.length < 3) return canvas;
  const first = selected[0]!.position[key];
  const step = (selected.at(-1)!.position[key] - first) / (selected.length - 1);
  const positions = new Map(selected.map((node, index) => [node.id, first + step * index]));
  return { ...canvas, nodes: canvas.nodes.map((node) => positions.has(node.id) ? { ...node, position: { ...node.position, [key]: positions.get(node.id)! } } : node) };
}

export function snapToonCanvasNodes(canvas: ToonWorkspaceCanvas, selection: readonly string[], grid = 20): ToonWorkspaceCanvas {
  return { ...canvas, nodes: canvas.nodes.map((node) => selection.includes(node.id) ? { ...node, position: { x: Math.round(node.position.x / grid) * grid, y: Math.round(node.position.y / grid) * grid } } : node) };
}

export function reorderToonCanvasNodes(canvas: ToonWorkspaceCanvas, selection: readonly string[], direction: "front" | "back"): ToonWorkspaceCanvas {
  const values = canvas.nodes.map((node) => node.zIndex ?? 0);
  const zIndex = direction === "front" ? Math.max(0, ...values) + 1 : Math.min(0, ...values) - 1;
  return { ...canvas, nodes: canvas.nodes.map((node) => selection.includes(node.id) ? { ...node, zIndex } : node) };
}

export function shouldSuppressToonCanvasShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input,textarea,select,[contenteditable=true],[role=dialog],[role=menu],[data-canvas-shortcuts=disabled]"));
}

export function toonCanvasCommandKey(platform: string, key: string): string {
  return `${/mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl"}+${key}`;
}
