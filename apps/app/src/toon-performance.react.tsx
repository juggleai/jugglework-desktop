/** @jsxImportSource react */
import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { Background, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./app/index.css";

const count = 1_000;
const nodes: Node[] = Array.from({ length: count }, (_, index) => ({
  id: `node-${index}`,
  position: { x: (index % 40) * 180, y: Math.floor(index / 40) * 90 },
  data: { label: `Node ${index}` },
  style: { width: 140, height: 50 },
}));
const edges: Edge[] = Array.from({ length: count - 1 }, (_, index) => ({ id: `edge-${index}`, source: `node-${index}`, target: `node-${index + 1}` }));

function Harness() {
  const flow = useReactFlow();
  useEffect(() => {
    const mountedAt = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      (window as typeof window & { __toonPerf?: unknown }).__toonPerf = {
        mountedAt,
        readyAt: performance.now(),
        nodeCount: nodes.length,
        edgeCount: edges.length,
        runZoom: async () => {
          const samples: number[] = [];
          for (let index = 0; index < 60; index += 1) {
            const started = performance.now();
            await flow.setViewport({ x: index * -4, y: index * -2, zoom: 0.7 + (index % 12) * 0.025 }, { duration: 0 });
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            samples.push(performance.now() - started);
          }
          return samples;
        },
        runDrag: async () => {
          const samples: number[] = [];
          for (let index = 0; index < 60; index += 1) {
            const started = performance.now();
            flow.setNodes((current) => current.map((node, nodeIndex) => nodeIndex === index % 20 ? { ...node, position: { x: node.position.x + 4, y: node.position.y + 2 } } : node));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            samples.push(performance.now() - started);
          }
          return samples;
        },
      };
    }));
  }, [flow]);
  return <ReactFlow nodes={nodes} edges={edges} minZoom={0.1} maxZoom={2.5} fitView><Background /></ReactFlow>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
ReactDOM.createRoot(root).render(<div style={{ width: "100vw", height: "100vh" }}><ReactFlowProvider><Harness /></ReactFlowProvider></div>);
