import type { Edge, Node, Viewport } from "@xyflow/react";
import type { ToonWorkspaceCanvas, ToonWorkspaceNode } from "@jugglework/types/toon-workspace";

export type ToonFlowNodeData = { node?: ToonWorkspaceNode; label: string; groupId?: string };
export type ToonFlowNode = Node<ToonFlowNodeData, "toon-node" | "toon-group">;

export function toToonFlowNodes(canvas: ToonWorkspaceCanvas, selection: readonly string[]): ToonFlowNode[] {
  const selected = new Set(selection);
  const groups: ToonFlowNode[] = (canvas.groups ?? []).map((group) => ({
    id: group.id,
    type: "toon-group",
    position: group.position,
    data: { label: group.title, groupId: group.id },
    selected: selected.has(group.id),
    zIndex: group.zIndex ?? -1,
    style: { width: 420, height: 260 },
    ...(group.parentGroupId ? { parentId: group.parentGroupId, extent: "parent" as const } : {}),
  }));
  return [...groups, ...canvas.nodes.map((node) => ({
    id: node.id,
    type: "toon-node" as const,
    position: node.position,
    data: { node, label: node.config.label ?? node.kind },
    selected: selected.has(node.id),
    zIndex: node.zIndex,
    ...(node.parentGroupId ? { parentId: node.parentGroupId, extent: "parent" as const } : {}),
  }))];
}

export function toToonFlowEdges(canvas: ToonWorkspaceCanvas, selection: readonly string[]): Edge[] {
  const selected = new Set(selection);
  return canvas.edges.map((edge) => ({
    id: edge.id,
    source: edge.sourceNodeId,
    sourceHandle: edge.sourceHandleId,
    target: edge.targetNodeId,
    targetHandle: edge.targetHandleId,
    selected: selected.has(edge.id),
  }));
}

export function applyToonFlowPositions(canvas: ToonWorkspaceCanvas, nodes: readonly Node[]): ToonWorkspaceCanvas {
  const positions = new Map(nodes.map((node) => [node.id, node.position]));
  return {
    ...canvas,
    groups: (canvas.groups ?? []).map((group) => positions.has(group.id) ? { ...group, position: positions.get(group.id)! } : group),
    nodes: canvas.nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node),
  };
}

export function toToonViewport(viewport: Viewport): ToonWorkspaceCanvas["viewport"] {
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
}
