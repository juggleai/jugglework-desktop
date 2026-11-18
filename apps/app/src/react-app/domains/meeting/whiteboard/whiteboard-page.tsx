/** @jsxImportSource react */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MeetingWhiteboardHandle } from "./meeting-whiteboard";
import { createSceneSaver } from "./scene";
import "./whiteboard.css";

export type WhiteboardContext = { meetingId: string; whiteboardId: string; title: string; theme: "light" | "dark"; scene: string | null };
export type WhiteboardBridge = {
  getContext(): Promise<WhiteboardContext>;
  save(content: string): Promise<void>;
  saveNow(content: string): boolean;
  exportFile(kind: "png" | "excalidraw", data: string): Promise<{ saved: boolean }>;
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
  const [ctx, setCtx] = useState<WhiteboardContext | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const board = useRef<MeetingWhiteboardHandle>(null);
  const saver = useMemo(() => createSceneSaver((json) => bridge.save(json), (json) => bridge.saveNow(json)), [bridge]);

  useEffect(() => {
    saver.onError(() => setStatus("自动保存失败，请导出备份"));
    let alive = true;
    bridge.getContext().then((next) => {
      if (!alive) return;
      document.documentElement.dataset.theme = next.theme;
      document.title = next.title ? `白板 · ${next.title}` : "会议白板";
      setCtx(next);
    }, (reason) => alive && setError(reason instanceof Error ? reason.message : "无法打开白板"));
    // Window close, meeting end and reloads all pass through pagehide.
    const flush = () => { saver.flushSync(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => { alive = false; window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", flush); flush(); };
  }, [bridge, saver]);

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

  if (error) return <div className="whiteboard-message" role="alert">{error}</div>;
  if (!ctx) return <div className="whiteboard-message" role="status">正在打开白板…</div>;
  return (
    <div className="whiteboard-shell">
      <header className="whiteboard-bar">
        <strong title={ctx.title}>{ctx.title ? `白板 · ${ctx.title}` : "会议白板"}</strong>
        <span className="whiteboard-status" role="status">{status}</span>
        <button type="button" onClick={() => void exportAs("png")}>导出 PNG</button>
        <button type="button" onClick={() => void exportAs("excalidraw")}>导出源文件</button>
      </header>
      <main className="whiteboard-canvas">
        <Suspense fallback={<div className="whiteboard-message" role="status">正在加载画布…</div>}>
          <MeetingWhiteboard ref={board} initialScene={ctx.scene} onSceneChange={onSceneChange} theme={ctx.theme} />
        </Suspense>
      </main>
    </div>
  );
}
