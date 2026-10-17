import type { ToonWorkspaceCanvas, ToonWorkspaceNode } from "@jugglework/types/toon-workspace";
import { toToonFlowNodes } from "./canvas/toon-canvas-xyflow-adapter";
import { buildToonDocumentTree, documentOffsetForLine } from "./workspace/toon-document-domain";

export const TOON_PERFORMANCE_THRESHOLDS = Object.freeze({
  firstOpenMs: 120,
  retainedHiddenBytes: 8 * 1024 * 1024,
  canvasFrameMs: 16.7,
  largeDocumentMs: 80,
  directSearchMs: 250,
  assistantEventsMs: 100,
  assistantEventBytes: 2 * 1024 * 1024,
  lazyBundleGzipBytes: 650 * 1024,
});

export type ToonPerformanceFixture = {
  name: "small" | "large";
  canvas: ToonWorkspaceCanvas;
  documents: Array<{ id: string; title: string; path: string; kind: "markdown"; mimeType: "text/markdown"; revision: string; state: "active"; updatedAt: string }>;
  contents: string[];
  assistantEvents: Array<{ id: string; sequence: number; type: string; data: { text: string } }>;
};

export function createToonPerformanceFixture(size: "small" | "large"): ToonPerformanceFixture {
  const count = size === "small" ? 24 : 1_000;
  const documentCount = size === "small" ? 12 : 100;
  const eventCount = size === "small" ? 50 : 2_000;
  const revision = "a".repeat(64);
  const now = "2026-10-17T00:00:00.000Z";
  const nodes: ToonWorkspaceNode[] = Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`, kind: "text", position: { x: (index % 40) * 240, y: Math.floor(index / 40) * 120 }, handles: [], config: { label: `Node ${index}` },
  }));
  const documents = Array.from({ length: documentCount }, (_, index) => ({ id: `document-${index}`, title: `Document ${index}`, path: `documents/document-${index}.md`, kind: "markdown" as const, mimeType: "text/markdown" as const, revision, state: "active" as const, updatedAt: now }));
  const contents = documents.map((_, index) => `${"scene line\n".repeat(size === "small" ? 20 : 2_000)}needle-${index}\n`);
  return {
    name: size,
    canvas: { schemaVersion: 2, id: "main", nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    documents,
    contents,
    assistantEvents: Array.from({ length: eventCount }, (_, index) => ({ id: `event-${index}`, sequence: index + 1, type: "message.delta", data: { text: `delta ${index}` } })),
  };
}

export function measureToonFixture(fixture: ToonPerformanceFixture): Record<"firstOpenMs" | "retainedHiddenBytes" | "canvasFrameMs" | "largeDocumentMs" | "directSearchMs" | "assistantEventsMs" | "assistantEventBytes", number> {
  let start = performance.now();
  buildToonDocumentTree(fixture.documents, [], [], new Set());
  toToonFlowNodes(fixture.canvas, []);
  const firstOpenMs = performance.now() - start;
  const retainedHiddenBytes = new TextEncoder().encode(JSON.stringify({ canvas: fixture.canvas, documents: fixture.documents })).byteLength;
  const frameSamples: number[] = [];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    start = performance.now();
    toToonFlowNodes(fixture.canvas, []);
    frameSamples.push(performance.now() - start);
  }
  frameSamples.sort((left, right) => left - right);
  const canvasFrameMs = frameSamples[Math.floor(frameSamples.length / 2)]!;
  const largeDocument = `${"large document line\n".repeat(105_000)}end`;
  start = performance.now();
  documentOffsetForLine(largeDocument, 100_000, 4);
  const largeDocumentMs = performance.now() - start;
  start = performance.now();
  fixture.contents.flatMap((content, index) => content.includes(`needle-${index}`) ? [index] : []);
  const directSearchMs = performance.now() - start;
  start = performance.now();
  const encodedEvents = new TextEncoder().encode(JSON.stringify(fixture.assistantEvents));
  JSON.parse(new TextDecoder().decode(encodedEvents));
  const assistantEventsMs = performance.now() - start;
  return { firstOpenMs, retainedHiddenBytes, canvasFrameMs, largeDocumentMs, directSearchMs, assistantEventsMs, assistantEventBytes: encodedEvents.byteLength };
}
