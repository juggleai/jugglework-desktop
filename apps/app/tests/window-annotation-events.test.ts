import { expect, test } from "bun:test";
import type { AnnotationStroke } from "../src/react-app/domains/annotation/annotation-model";
import { createWindowAnnotationReceiver, type WindowAnnotationScene } from "../src/react-app/domains/meeting/window-annotation-events";
import type { WindowShareCompositor } from "../src/react-app/domains/meeting/window-share-compositor";

test("a resize clears ink without stopping sharing and rejects later scenes from that session", () => {
  const effects: string[] = [];
  const receive = createWindowAnnotationReceiver("capture", {
    setOverlay: draw => effects.push(draw ? "draw" : "clear"),
    confirmSize: () => {}, setPaused: paused => effects.push(paused ? "pause" : "resume"),
  }, reason => effects.push(reason));
  const key = { captureId: "capture", annotationId: "one" };
  receive({ ...key, kind: "opened", seq: 1 });
  receive({ ...key, kind: "scene", seq: 2, scene: { elements: [], lasers: [], size: { width: 640, height: 400 } } });
  receive({ ...key, kind: "closed", seq: 3, reason: "resized" });
  receive({ ...key, kind: "scene", seq: 4, scene: { elements: [], lasers: [], size: { width: 640, height: 400 } } });
  expect(effects).toEqual(["clear", "draw", "clear", "resume", "resized"]);
});

function recordingCanvas(createElement?: () => object) {
  type Command = [string, ...number[]];
  let path: Command[] = [];
  const strokes: { path: Command[]; blend: string; alpha: number; width: number; blur: number; shadow: string }[] = [];
  const blits: { blend: string; alpha: number; strokes: typeof strokes }[] = [];
  const clears: number[][] = [];
  const canvas = { width: 300, height: 150, ownerDocument: { createElement }, strokes,
    getContext: (): CanvasRenderingContext2D => ctx as unknown as CanvasRenderingContext2D };
  const style = { globalAlpha: 1, globalCompositeOperation: "source-over", lineWidth: 1, shadowBlur: 0, shadowColor: "transparent" };
  const saved: (typeof style)[] = [];
  const ctx = {
    canvas, ...style,
    save() { saved.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation,
      lineWidth: this.lineWidth, shadowBlur: this.shadowBlur, shadowColor: this.shadowColor }); },
    restore() { Object.assign(this, saved.pop()); },
    setTransform() {}, scale() {},
    clearRect(...args: number[]) { clears.push(args); strokes.length = 0; },
    beginPath() { path = []; },
    moveTo(...args: number[]) { path.push(["move", ...args]); },
    lineTo(...args: number[]) { path.push(["line", ...args]); },
    quadraticCurveTo(...args: number[]) { path.push(["quadratic", ...args]); },
    bezierCurveTo(...args: number[]) { path.push(["cubic", ...args]); },
    stroke() { strokes.push({ path, blend: this.globalCompositeOperation, alpha: this.globalAlpha,
      width: this.lineWidth, blur: this.shadowBlur, shadow: this.shadowColor }); },
    drawImage(source: typeof canvas) { blits.push({ blend: this.globalCompositeOperation, alpha: this.globalAlpha,
      strokes: [...source.strokes] }); },
  };
  return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D, strokes, blits, clears };
}

function drawingFixture() {
  const scratch: ReturnType<typeof recordingCanvas>[] = [];
  const video = recordingCanvas(() => {
    const surface = recordingCanvas();
    scratch.push(surface);
    return surface.canvas;
  });
  let overlay: Parameters<WindowShareCompositor["setOverlay"]>[0] = null;
  let seq = 1;
  const key = { captureId: "capture", annotationId: "one" };
  const receive = createWindowAnnotationReceiver(key.captureId, {
    setOverlay: draw => { overlay = draw; }, confirmSize: () => {}, setPaused: () => {},
  }, () => {});
  receive({ ...key, kind: "opened", seq });
  return {
    video, scratch,
    scene(scene: Omit<WindowAnnotationScene, "size">) {
      receive({ ...key, kind: "scene", seq: ++seq, scene: { ...scene, size: { width: 200, height: 100 } } });
    },
    draw(width = 400, height = 300) { overlay!(video.ctx, width, height); },
  };
}

const pen: AnnotationStroke = { id: "pen", type: "stroke", color: "#ef4444", highlight: false, size: 4,
  points: [0.1, 0.2, 0.3, 0.2, 0.3, 0.6, 0.5, 0.6] };
const highlight: AnnotationStroke = { ...pen, id: "highlight", color: "#facc15", highlight: true };

test("open pen splines preserve Konva's quadratic ends and cubic middle in viewport coordinates", () => {
  const f = drawingFixture();
  f.scene({ elements: [pen], lasers: [] });
  f.draw();
  const [stroke] = f.video.blits[0]?.strokes ?? f.video.strokes;
  // The viewport segments are each 40 CSS px, so each control is offset by 0.35 / 2 of the adjacent span.
  expect(stroke.path).toEqual([
    ["move", 20, 20], ["quadratic", 53, 13, 60, 20],
    ["cubic", 67, 27, 53, 53, 60, 60], ["quadratic", 67, 67, 100, 60],
  ]);
});

test("highlight multiplies only marks in the ink layer, and video receives that layer source-over", () => {
  const f = drawingFixture();
  f.scene({ elements: [pen, highlight], lasers: [] });
  f.draw();
  expect(f.video.strokes).toEqual([]);
  expect(f.video.blits.map(({ blend, alpha, strokes }) => ({ blend, alpha, marks: strokes.map(s => [s.blend, s.alpha, s.width]) })))
    .toEqual([{ blend: "source-over", alpha: 1, marks: [["source-over", 1, 4], ["multiply", 0.35, 16]] }]);
});

test("a fading laser keeps its own Konva tension, minimum width, and scaled translucent glow", () => {
  const f = drawingFixture();
  f.scene({ elements: [highlight], lasers: [{ stroke: { ...pen, size: 1 }, opacity: 0.4 }] });
  f.draw();
  expect(f.video.blits.map(({ strokes }) => strokes.map(s => s.blend))).toEqual([["multiply"], ["source-over"]]);
  const [stroke] = f.video.blits[1].strokes;
  expect(stroke).toMatchObject({ alpha: 0.4, width: 3, blur: 28, shadow: "rgba(255, 59, 48, 0.9)" });
  expect(stroke.path).toEqual([
    ["move", 20, 20], ["quadratic", 52, 12, 60, 20],
    ["cubic", 68, 28, 52, 52, 60, 60], ["quadratic", 68, 68, 100, 60],
  ]);
});

test("one lazy scratch surface is cleared for repeated draws, scene changes, and frame resizes", () => {
  const f = drawingFixture();
  f.scene({ elements: [], lasers: [] });
  f.draw();
  expect(f.scratch).toHaveLength(0);

  f.scene({ elements: [pen, highlight], lasers: [] });
  f.draw();
  f.draw();
  f.scene({ elements: [highlight], lasers: [] });
  f.draw();
  f.draw(800, 600);
  expect(f.scratch).toHaveLength(1);
  expect(f.scratch[0].clears).toEqual([[0, 0, 400, 300], [0, 0, 400, 300], [0, 0, 400, 300], [0, 0, 800, 600]]);
  expect(f.video.blits.map(blit => blit.strokes.length)).toEqual([2, 2, 1, 1]);
  expect([f.scratch[0].canvas.width, f.scratch[0].canvas.height]).toEqual([800, 600]);
});
