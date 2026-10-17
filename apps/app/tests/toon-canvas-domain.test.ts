import { describe, expect, test } from "bun:test";
import type { ToonWorkspaceCanvas, ToonWorkspaceNode } from "@jugglework/types/toon-workspace";
import {
  alignToonCanvasNodes,
  connectToonWorkspaceNodes,
  copyToonCanvasSelection,
  createToonCanvasHistory,
  distributeToonCanvasNodes,
  groupToonCanvasSelection,
  pasteToonCanvasSelection,
  recordToonCanvasHistory,
  redoToonCanvas,
  snapToonCanvasNodes,
  shouldSuppressToonCanvasShortcut,
  navigateToonCanvasViewport,
  toonCanvasCommandKey,
  toonCanvasMinimapState,
  undoToonCanvas,
  ungroupToonCanvas,
  validateToonWorkspaceConnection,
} from "../src/react-app/domains/toon-factory/canvas/toon-canvas-domain";

const node = (id: string, x: number, type: "text" | "image" = "text"): ToonWorkspaceNode => ({
  id,
  kind: "text",
  position: { x, y: x / 2 },
  handles: [
    { id: "in", direction: "target", dataType: type },
    { id: "out", direction: "source", dataType: type },
  ],
  config: { label: id },
});
const canvas = (): ToonWorkspaceCanvas => ({ schemaVersion: 2, id: "main", nodes: [node("a", 3), node("b", 53), node("c", 123)], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });

describe("Toon canvas domain", () => {
  test("accepts compatible typed edges and rejects invalid edges without mutation", () => {
    const current = canvas();
    const valid = { sourceNodeId: "a", sourceHandleId: "out", targetNodeId: "b", targetHandleId: "in" };
    expect(validateToonWorkspaceConnection(current, valid)).toEqual({ valid: true });
    const connected = connectToonWorkspaceNodes(current, valid, "edge-1");
    expect(connected.edges).toHaveLength(1);
    const incompatible = { ...valid, targetNodeId: "c" };
    current.nodes[2] = node("c", 123, "image");
    expect(validateToonWorkspaceConnection(current, incompatible)).toEqual({ valid: false, reason: "incompatible_type" });
    expect(connectToonWorkspaceNodes(current, incompatible, "edge-bad")).toBe(current);
  });

  test("bounds and coalesces history while preserving deterministic undo and redo", () => {
    let history = createToonCanvasHistory(2);
    const initial = { canvas: canvas(), selection: ["a"] };
    const moved = structuredClone(initial); moved.canvas.nodes[0]!.position.x = 20;
    const movedAgain = structuredClone(moved); movedAgain.canvas.nodes[0]!.position.x = 40;
    history = recordToonCanvasHistory(history, initial, moved, { label: "Move", coalesceKey: "drag:a", committedAt: 10 });
    history = recordToonCanvasHistory(history, moved, movedAgain, { label: "Move", coalesceKey: "drag:a", committedAt: 20 });
    expect(history.past).toHaveLength(1);
    expect(undoToonCanvas(history).snapshot?.canvas.nodes[0]?.position.x).toBe(3);
    const undone = undoToonCanvas(history);
    expect(redoToonCanvas(undone.history).snapshot?.canvas.nodes[0]?.position.x).toBe(40);
    history = recordToonCanvasHistory(history, movedAgain, { ...movedAgain, selection: ["b"] }, { label: "Select", committedAt: 1000 });
    history = recordToonCanvasHistory(history, { ...movedAgain, selection: ["b"] }, { ...movedAgain, selection: ["c"] }, { label: "Select", committedAt: 2000 });
    expect(history.past).toHaveLength(2);
    expect(history.past.map((entry) => entry.before.selection)).toEqual([["a"], ["b"]]);
  });

  test("coalesces continuous node text edits into one undo entry", () => {
    let history = createToonCanvasHistory();
    const before = { canvas: canvas(), selection: ["a"] };
    const first = structuredClone(before); first.canvas.nodes[0]!.config.label = "First";
    const second = structuredClone(first); second.canvas.nodes[0]!.config.label = "Final";
    history = recordToonCanvasHistory(history, before, first, { label: "Text", coalesceKey: "text:a", committedAt: 10 });
    history = recordToonCanvasHistory(history, first, second, { label: "Text", coalesceKey: "text:a", committedAt: 20 });
    expect(history.past).toHaveLength(1);
    expect(undoToonCanvas(history).snapshot?.canvas.nodes[0]?.config.label).toBe("a");
  });

  test("pastes fresh IDs and remaps only internal edges", () => {
    const current = canvas();
    current.edges = [
      { id: "internal", sourceNodeId: "a", sourceHandleId: "out", targetNodeId: "b", targetHandleId: "in" },
      { id: "external", sourceNodeId: "b", sourceHandleId: "out", targetNodeId: "c", targetHandleId: "in" },
    ];
    const clipboard = copyToonCanvasSelection(current, ["a", "b"]);
    let sequence = 0;
    const pasted = pasteToonCanvasSelection(current, clipboard, (kind) => `${kind}-${++sequence}`);
    expect(pasted.canvas.nodes).toHaveLength(5);
    expect(pasted.canvas.edges).toHaveLength(3);
    expect(pasted.canvas.edges.at(-1)).toMatchObject({ sourceNodeId: "node-1", targetNodeId: "node-2" });
  });

  test("groups and ungroups with relative placement while preserving mixed edges", () => {
    const current = canvas();
    current.edges = [
      { id: "inside", sourceNodeId: "a", sourceHandleId: "out", targetNodeId: "b", targetHandleId: "in" },
      { id: "outside", sourceNodeId: "b", sourceHandleId: "out", targetNodeId: "c", targetHandleId: "in" },
    ];
    const grouped = groupToonCanvasSelection(current, ["a", "b"], "group-1", "Group");
    expect(grouped.canvas.groups?.[0]?.id).toBe("group-1");
    expect(grouped.canvas.nodes[0]).toMatchObject({ parentGroupId: "group-1", position: { x: 0 } });
    expect(grouped.canvas.edges).toEqual(current.edges);
    const ungrouped = ungroupToonCanvas(grouped.canvas, "group-1");
    expect(ungrouped.canvas.nodes.map((item) => item.position)).toEqual(current.nodes.map((item) => item.position));
    expect(ungrouped.canvas.edges).toEqual(current.edges);
  });

  test("alignment, distribution and grid snapping change layout only", () => {
    const current = canvas();
    const aligned = alignToonCanvasNodes(current, ["a", "b"], "left");
    expect(aligned.nodes[1]?.position.x).toBe(3);
    const distributed = distributeToonCanvasNodes(current, ["a", "b", "c"], "horizontal");
    expect(distributed.nodes[1]?.position.x).toBe(63);
    const snapped = snapToonCanvasNodes(current, ["a", "b"], 20);
    expect(snapped.nodes.slice(0, 2).map((item) => item.position)).toEqual([{ x: 0, y: 0 }, { x: 60, y: 20 }]);
    expect(snapped.edges).toEqual(current.edges);
    expect(snapped.nodes.map((item) => item.config)).toEqual(current.nodes.map((item) => item.config));
  });

  test("suppresses destructive shortcuts in text, menu and dialog controls", () => {
    const input = { closest: (selector: string) => selector.includes("input") ? input : null };
    const menu = { closest: (selector: string) => selector.includes("[role=menu]") ? menu : null };
    const canvas = { closest: () => null };
    const original = globalThis.Element;
    class TestElement {}
    Object.defineProperty(globalThis, "Element", { value: TestElement, configurable: true });
    Object.setPrototypeOf(input, TestElement.prototype);
    Object.setPrototypeOf(menu, TestElement.prototype);
    Object.setPrototypeOf(canvas, TestElement.prototype);
    try {
      expect(shouldSuppressToonCanvasShortcut(input as unknown as EventTarget)).toBe(true);
      expect(shouldSuppressToonCanvasShortcut(menu as unknown as EventTarget)).toBe(true);
      expect(shouldSuppressToonCanvasShortcut(canvas as unknown as EventTarget)).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "Element", { value: original, configurable: true });
    }
  });

  test("formats shortcut labels for macOS and non-macOS platforms", () => {
    expect(toonCanvasCommandKey("MacIntel", "Z")).toBe("⌘+Z");
    expect(toonCanvasCommandKey("Win32", "Z")).toBe("Ctrl+Z");
  });

  test("derives portable minimap bounds and keyboard viewport navigation without graph objects", () => {
    const current = canvas();
    current.groups = [{ id: "group", title: "Group", position: { x: -100, y: -80 } }];
    current.nodes[0] = { ...current.nodes[0]!, parentGroupId: "group", position: { x: 10, y: 20 } };
    const minimap = toonCanvasMinimapState(current);
    expect(minimap.visibleNodeIds).toEqual(["group", "a", "b", "c"]);
    expect(minimap.bounds).toEqual({ x: -100, y: -80, width: 443, height: 237.5 });
    expect(JSON.stringify(minimap)).not.toMatch(/internals|measured|positionAbsolute/);
    expect(navigateToonCanvasViewport(current.viewport, "ArrowRight")).toEqual({ x: -64, y: 0, zoom: 1 });
    expect(navigateToonCanvasViewport(current.viewport, "ArrowUp", true)).toEqual({ x: 0, y: 160, zoom: 1 });
    expect(navigateToonCanvasViewport({ x: 3, y: 4, zoom: 2.5 }, "+")).toEqual({ x: 3, y: 4, zoom: 2.5 });
    expect(navigateToonCanvasViewport({ x: 3, y: 4, zoom: 0.1 }, "-")).toEqual({ x: 3, y: 4, zoom: 0.1 });
    expect(navigateToonCanvasViewport(current.viewport, "0")).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
