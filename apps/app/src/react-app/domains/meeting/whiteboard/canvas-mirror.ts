// Mirrors Excalidraw's scene canvases into one canvas whose stream is shared
// to the meeting. Excalidraw keeps the committed scene on the static canvas and
// the stroke being drawn on a separate canvas; the interactive canvas (selection
// handles, hover outlines) is presenter-only and is not mirrored.
import { mirrorSize } from "./scene";

const SCENE_CANVASES = "canvas.excalidraw__canvas:not(.interactive)";

export type CanvasMirror = { stream: MediaStream; stop(): void };

export function startCanvasMirror(root: HTMLElement, fps = 15): CanvasMirror {
  const doc = root.ownerDocument;
  const view = doc.defaultView!;
  const out = doc.createElement("canvas");
  const g = out.getContext("2d", { alpha: false })!;
  let scale = 1;
  const resize = () => {
    const rect = root.getBoundingClientRect();
    const size = mirrorSize(rect.width, rect.height, view.devicePixelRatio);
    if (out.width !== size.width) out.width = size.width;
    if (out.height !== size.height) out.height = size.height;
    scale = size.scale;
  };
  const draw = () => {
    resize();
    const origin = root.getBoundingClientRect();
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, out.width, out.height);
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>(SCENE_CANVASES)) {
      if (!canvas.width || !canvas.height) continue;
      const rect = canvas.getBoundingClientRect();
      g.drawImage(canvas, (rect.left - origin.left) * scale, (rect.top - origin.top) * scale, rect.width * scale, rect.height * scale);
    }
  };
  draw();
  const stream = out.captureStream(fps);
  // Timers keep running while the meeting window is hidden (backgroundThrottling is off).
  const timer = view.setInterval(draw, Math.round(1000 / fps));
  return {
    stream,
    stop() {
      view.clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}

/** Resolves once Excalidraw has mounted its static canvas inside root. */
export function waitForSceneCanvas(root: ParentNode, view: Window, timeoutMs = 15_000): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const board = root.querySelector<HTMLElement>(".excalidraw");
      if (board?.querySelector("canvas.excalidraw__canvas.static")) return resolve(board);
      if (Date.now() - started > timeoutMs) return reject(new Error("白板画布加载超时，请重新打开白板。"));
      view.setTimeout(poll, 100);
    };
    poll();
  });
}
