/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnnotationCanvas, type AnnotationCanvasBridge } from "../react-app/domains/annotation/annotation-canvas";
import type { AnnotationHistoryState, AnnotationState } from "../react-app/domains/annotation/annotation-model";
import type { WindowAnnotationScene } from "../react-app/domains/meeting/window-annotation-events";
import { AnnotationToolbar, type AnnotationCommand } from "../react-app/domains/annotation/annotation-toolbar";
import "../react-app/domains/annotation/annotation.css";

type AnnotationBridge = {
  init(): Promise<AnnotationState & { windowShare?: boolean; capabilities?: import("../react-app/domains/annotation/annotation-model").AnnotationTool[] |
    { tools: import("../react-app/domains/annotation/annotation-model").AnnotationTool[]; history?: ("undo" | "clear")[] } }>;
  onState(callback: (state: AnnotationState) => void): () => void;
  onAction(callback: (action: "undo" | "clear") => void): () => void;
  command(command: AnnotationCommand): void;
  history(value: AnnotationHistoryState): void;
  scene(value: WindowAnnotationScene): void;
};

declare global { interface Window { __JUGGLEWORK_ANNOTATION__?: AnnotationBridge } }

const view = new URLSearchParams(location.search).get("view") === "toolbar" ? "toolbar" : "canvas";

function AnnotationPage({ bridge }: { bridge: AnnotationBridge }) {
  const [state, setState] = useState<Awaited<ReturnType<AnnotationBridge["init"]>> | null>(null);
  useEffect(() => {
    let alive = true;
    const off = bridge.onState((next) => { if (alive) setState(current => ({ ...current, ...next })); });
    bridge.init().then((initial) => { if (alive) setState((current) => current ?? initial); }, () => {});
    return () => { alive = false; off(); };
  }, [bridge]);
  const canvasBridge = useMemo<AnnotationCanvasBridge>(() => ({
    onAction: (callback) => bridge.onAction(callback),
    history: (value) => bridge.history(value),
    escape: () => bridge.command({ type: "escape" }),
  }), [bridge]);
  if (!state) return null;
  return view === "toolbar"
    ? <AnnotationToolbar state={state} send={(command) => bridge.command(command)} />
    : <AnnotationCanvas state={state} bridge={canvasBridge} onScene={state.windowShare ? bridge.scene : undefined} />;
}

const bridge = window.__JUGGLEWORK_ANNOTATION__;
document.title = view === "toolbar" ? "标注工具栏" : "屏幕标注";
if (bridge) createRoot(document.getElementById("root")!).render(<AnnotationPage bridge={bridge} />);
