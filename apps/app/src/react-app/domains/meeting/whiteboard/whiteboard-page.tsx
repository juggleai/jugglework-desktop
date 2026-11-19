/** @jsxImportSource react */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MeetingWhiteboardHandle } from "./meeting-whiteboard";
import { startCanvasMirror, waitForSceneCanvas } from "./canvas-mirror";
import { createSceneSaver } from "./scene";
import "./whiteboard.css";

export type WhiteboardContext = { whiteboardId: string; title: string; theme: "light" | "dark"; scene: string | null };
/** Set by the meeting stage on this page's iframe element before the page loads. */
export type WhiteboardBridge = {
  context: WhiteboardContext;
  save(content: string): Promise<void>;
  exportFile(kind: "png" | "excalidraw", data: string): Promise<{ saved: boolean }>;
  /** Hands the mirrored canvas stream to the meeting for publishing. */
  publish(stream: MediaStream): void;
  fail(message: string): void;
  /** The stage calls the registered flush right before it removes the iframe. */
  setFlush(flush: (() => void) | null): void;
};

// Keeps the ~2MB Excalidraw bundle out of every other entry point.
const MeetingWhiteboard = lazy(() => import("./meeting-whiteboard").then((m) => ({ default: m.MeetingWhiteboard })));

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取导出内容"));
    reader.readAsDataURL(blob);
  });
}

export function WhiteboardPage({ bridge }: { bridge: WhiteboardBridge }) {
  const ctx = bridge.context;
  const [status, setStatus] = useState("");
  const board = useRef<MeetingWhiteboardHandle>(null);
  const canvasHost = useRef<HTMLElement>(null);
  // The bridge lives in the long-lived meeting renderer, so an async save
  // started during pagehide still completes after this iframe is gone.
  const saver = useMemo(() => createSceneSaver((json) => bridge.save(json), (json) => { void bridge.save(json).catch(() => {}); return true; }), [bridge]);

  useEffect(() => {
    document.documentElement.dataset.theme = ctx.theme;
    document.title = "会议白板";
    saver.onError(() => setStatus("自动保存失败，请导出备份"));
    const flush = () => { saver.flushSync(); };
    bridge.setFlush(flush);
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); bridge.setFlush(null); flush(); };
  }, [bridge, ctx.theme, saver]);

  useEffect(() => {
    let mirror: ReturnType<typeof startCanvasMirror> | null = null;
    let alive = true;
    const host = canvasHost.current;
    if (!host) return;
    waitForSceneCanvas(host, window).then((root) => {
      if (!alive) return;
      mirror = startCanvasMirror(root);
      bridge.publish(mirror.stream);
    }, (reason) => alive && bridge.fail(reason instanceof Error ? reason.message : "白板画布加载失败"));
    return () => { alive = false; mirror?.stop(); };
  }, [bridge]);

  const onSceneChange = useCallback((json: string) => { setStatus(""); saver.schedule(json); }, [saver]);

  async function exportAs(kind: "png" | "excalidraw") {
    setStatus("");
    try {
      const data = kind === "png"
        ? await board.current?.exportPng().then((blob) => (blob ? blobToBase64(blob) : null))
        : board.current?.exportSource();
      if (!data) return;
      const result = await bridge.exportFile(kind, data);
      if (result.saved) setStatus("已导出");
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : "导出失败");
    }
  }

  return (
    <div className="whiteboard-shell">
      <header className="whiteboard-bar">
        <strong>会议白板</strong>
        <span className="whiteboard-live">共享中</span>
        <span className="whiteboard-status" role="status">{status}</span>
        <button type="button" onClick={() => void exportAs("png")}>导出 PNG</button>
        <button type="button" onClick={() => void exportAs("excalidraw")}>导出源文件</button>
      </header>
      <main className="whiteboard-canvas" ref={canvasHost}>
        <Suspense fallback={<div className="whiteboard-message" role="status">正在加载画布…</div>}>
          <MeetingWhiteboard ref={board} initialScene={ctx.scene} onSceneChange={onSceneChange} theme={ctx.theme} />
        </Suspense>
      </main>
    </div>
  );
}
