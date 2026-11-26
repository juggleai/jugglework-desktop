import { expect, test } from "bun:test";
import { eraseElements, type AnnotationShape, type AnnotationStroke } from "../src/react-app/domains/annotation/annotation-model";
import { createWindowAnnotationReceiver, type WindowAnnotationScene } from "../src/react-app/domains/meeting/window-annotation-events";
import { createWindowShareCompositor, type WindowShareCompositor } from "../src/react-app/domains/meeting/window-share-compositor";

test("a resize clears ink without stopping sharing and rejects later scenes from that session", () => {
  const effects: string[] = [];
  const receive = createWindowAnnotationReceiver("capture", {
    setOverlay: draw => effects.push(draw ? "draw" : "clear"),
    confirmSize: () => {}, setGeometryPending: () => {}, setPaused: paused => effects.push(paused ? "pause" : "resume"),
  }, reason => effects.push(reason));
  const key = { captureId: "capture", annotationId: "one" };
  receive({ ...key, kind: "opened", seq: 1 });
  receive({ ...key, kind: "scene", seq: 2, scene: { elements: [], lasers: [], size: { width: 640, height: 400 } } });
  receive({ ...key, kind: "closed", seq: 3, reason: "resized" });
  receive({ ...key, kind: "scene", seq: 4, scene: { elements: [], lasers: [], size: { width: 640, height: 400 } } });
  expect(effects).toEqual(["clear", "resume", "draw", "clear", "resume", "resized"]);
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
    rect(...args: number[]) { path.push(["rect", ...args]); },
    ellipse(...args: number[]) { path.push(["ellipse", ...args]); },
    translate(...args: number[]) { path.push(["translate", ...args]); },
    rotate(...args: number[]) { path.push(["rotate", ...args]); },
    quadraticCurveTo(...args: number[]) { path.push(["quadratic", ...args]); },
    bezierCurveTo(...args: number[]) { path.push(["cubic", ...args]); },
    closePath() { path.push(["close"]); },
    fill() { path.push(["fill"]); },
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
    setOverlay: draw => { overlay = draw; }, confirmSize: () => {}, setGeometryPending: () => {}, setPaused: () => {},
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
const rectangle: AnnotationShape = { id: "rectangle", type: "shape", kind: "rectangle", color: "#ef4444", size: 4,
  x1: 0.8, y1: 0.7, x2: 0.2, y2: 0.1 };
const ellipse: AnnotationShape = { ...rectangle, id: "ellipse", kind: "ellipse", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 };
const arrow: AnnotationShape = { ...rectangle, id: "arrow", kind: "arrow", x1: 0.2, y1: 0.3, x2: 0.7, y2: 0.6 };

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

test("eraser-filtered rectangles, ellipses, arrows, and lasers reach the compositor as canvas paths", () => {
  const f = drawingFixture();
  const erased = { ...rectangle, id: "erased" };
  const remaining = eraseElements([rectangle, ellipse, arrow, erased], new Set([erased.id]));
  f.scene({ elements: remaining, lasers: [{ stroke: { ...pen, id: "laser", points: [0.1, 0.2, 0.4, 0.5] }, opacity: 0.75 }] });
  f.draw();

  expect(f.video.blits).toHaveLength(2);
  const paths = f.video.blits[0].strokes.map(stroke => stroke.path);
  expect(paths.slice(0, 3)).toEqual([
    [["rect", 40, 10, 120, 60], ["close"]],
    [["ellipse", 60, 50, 40, 30, 0, 0, Math.PI * 2], ["close"]],
    [["move", 40, 30], ["line", 140, 60]],
  ]);
  expect(paths[3].filter(command => command[0] !== "rotate")).toEqual([
    ["translate", 140, 60], ["move", 0, 0], ["line", -14, 7], ["line", -14, -7], ["close"], ["fill"],
  ]);
  expect(paths[3][1][1]).toBeCloseTo(Math.atan2(30, 100), 14);
  expect(f.video.blits[0].strokes).toHaveLength(4);
  expect(f.video.blits[1].strokes).toHaveLength(1);
  expect(f.video.blits[1].strokes[0]).toMatchObject({ alpha: 0.75, width: 4, blur: 28, shadow: "rgba(255, 59, 48, 0.9)" });
  expect(f.video.blits[1].strokes[0].path).toEqual([["move", 20, 20], ["line", 80, 50]]);
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

function receiverFixture() {
  const effects: string[] = [];
  const key = { captureId: "capture", annotationId: "one" };
  const receive = createWindowAnnotationReceiver(key.captureId, {
    setOverlay: draw => effects.push(draw ? "draw" : "clear"),
    confirmSize: (w, h) => effects.push(`size:${w}:${h}`),
    setGeometryPending: value => effects.push(`pending:${value}`),
    setPaused: value => effects.push(`paused:${value}`),
  }, reason => effects.push(`closed:${reason}`));
  return { effects, key, receive };
}

test("pending is sequenced by capture and session, and recovery confirms size before clearing it", () => {
  const { effects, key, receive } = receiverFixture();
  receive({ ...key, kind: "opened", seq: 1 });
  effects.length = 0;
  receive({ ...key, kind: "geometry-pending", seq: 5 });
  receive({ ...key, kind: "geometry", seq: 4, width: 640, height: 400 });
  receive({ ...key, kind: "geometry", seq: 5, width: 640, height: 400 });
  receive({ ...key, captureId: "other", kind: "geometry", seq: 99, width: 640, height: 400 });
  receive({ ...key, annotationId: "other", kind: "geometry", seq: 99, width: 640, height: 400 });
  receive({ ...key, kind: "geometry", seq: NaN, width: 640, height: 400 });
  receive({ ...key, kind: "resumed", seq: 6 });
  expect(effects).toEqual(["pending:true", "paused:false"]);
  receive({ ...key, kind: "geometry", seq: 7, width: 640, height: 400 });
  expect(effects.slice(-2)).toEqual(["size:640:400", "pending:false"]);
  receive({ ...key, kind: "geometry-pending", seq: 6 });
  expect(effects.at(-1)).toBe("pending:false");
});

test("invalid geometry cannot release pending", () => {
  const { effects, key, receive } = receiverFixture();
  receive({ ...key, kind: "opened", seq: 1 });
  effects.length = 0;
  receive({ ...key, kind: "geometry-pending", seq: 2 });
  for (const [i, [width, height]] of [[0, 400], [640, -1], [Infinity, 400], [640, NaN]].entries()) {
    receive({ ...key, kind: "geometry", seq: 3 + i, width, height });
  }
  expect(effects).toEqual(["pending:true"]);
  receive({ ...key, kind: "geometry", seq: 7, width: 640, height: 400 });
  expect(effects.slice(-2)).toEqual(["size:640:400", "pending:false"]);
});

test("opened and closed reset pending, size, overlay and paused state; retired sessions stay retired", () => {
  const { effects, key, receive } = receiverFixture();
  receive({ ...key, kind: "opened", seq: 1 });
  receive({ ...key, kind: "paused", seq: 2 });
  receive({ ...key, kind: "geometry-pending", seq: 3 });
  effects.length = 0;
  receive({ ...key, kind: "opened", seq: 1 });
  receive({ ...key, kind: "opened", seq: 0 });
  expect(effects).toEqual([]);
  receive({ ...key, kind: "closed", seq: 4, reason: "manual" });
  expect(effects).toEqual(["clear", "size:0:0", "pending:false", "paused:false", "closed:manual"]);
  effects.length = 0;
  receive({ ...key, kind: "geometry", seq: 99, width: 640, height: 400 });
  receive({ ...key, kind: "closed", seq: 100, reason: "target-closed" });
  receive({ ...key, kind: "opened", seq: 101 });
  expect(effects).toEqual([]);

  const next = { ...key, annotationId: "two" };
  receive({ ...next, kind: "opened", seq: 1 });
  expect(effects).toEqual(["clear", "size:0:0", "pending:false", "paused:false"]);
  effects.length = 0;
  receive({ ...next, kind: "geometry-pending", seq: 2 });
  receive({ ...key, kind: "opened", seq: 102 });
  receive({ ...key, kind: "geometry", seq: 103, width: 640, height: 400 });
  receive({ ...next, kind: "geometry", seq: 1, width: 640, height: 400 });
  expect(effects).toEqual(["pending:true"]);
  receive({ ...next, kind: "geometry", seq: 3, width: 640, height: 400 });
  expect(effects.slice(-2)).toEqual(["size:640:400", "pending:false"]);
});

test("a new opened session resets an old paused session even without a preceding closed event", () => {
  const { effects, key, receive } = receiverFixture();
  receive({ ...key, kind: "opened", seq: 1 });
  receive({ ...key, kind: "paused", seq: 2 });
  receive({ ...key, kind: "geometry-pending", seq: 3 });
  effects.length = 0;
  receive({ ...key, annotationId: "two", kind: "opened", seq: 1 });
  expect(effects).toEqual(["clear", "size:0:0", "pending:false", "paused:false"]);
  effects.length = 0;
  receive({ ...key, kind: "opened", seq: 100 });
  receive({ ...key, kind: "resumed", seq: 101 });
  receive({ ...key, kind: "closed", seq: 102, reason: "target-closed" });
  expect(effects).toEqual([]);
});

test("target closure before opened still ends sharing once and cannot later open that session", () => {
  const { effects, key, receive } = receiverFixture();
  receive({ ...key, kind: "closed", seq: 1, reason: "target-closed" });
  receive({ ...key, kind: "closed", seq: 2, reason: "target-closed" });
  receive({ ...key, kind: "opened", seq: 3 });
  expect(effects).toEqual(["closed:target-closed"]);
});

test("receiver and compositor draw clean live frames throughout pending and restore the latest scene", async () => {
  const draws: string[] = [];
  const scratch = recordingCanvas();
  let callback: (() => void) | undefined;
  const raw = { readyState: "live", stop: () => { raw.readyState = "ended"; } };
  const capture = { getVideoTracks: () => [raw] } as unknown as MediaStream;
  const track = { requestFrame: () => draws.push("frame"), stop: () => draws.push("stop") };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const video = { videoWidth: 640, videoHeight: 400, srcObject: null,
    play: async () => {}, pause: () => draws.push("pause"),
    requestVideoFrameCallback: (cb: () => void) => { callback = cb; return 1; },
    cancelVideoFrameCallback: () => { callback = undefined; } };
  const canvas = { width: 0, height: 0, captureStream: () => stream,
    getContext: () => ({ canvas, save() {}, restore() {},
      drawImage: (source: unknown) => draws.push(source === video ? "source" : `ink:${scratch.strokes.length}`) }),
    ownerDocument: { createElement: () => scratch.canvas } };
  const doc = { createElement: (tag: string) => tag === "video" ? video : canvas } as unknown as Document;
  const output = await createWindowShareCompositor(capture, doc);
  const key = { captureId: "capture", annotationId: "one" };
  const receive = createWindowAnnotationReceiver(key.captureId, output, reason => draws.push(`closed:${reason}`));
  const scene = (elements: AnnotationStroke[]) => ({ elements, lasers: [], size: { width: 640, height: 400 } });
  try {
    receive({ ...key, kind: "opened", seq: 1 });
    receive({ ...key, kind: "geometry", seq: 2, width: 640, height: 400 });
    receive({ ...key, kind: "scene", seq: 3, scene: scene([pen]) });
    await Promise.resolve();
    expect(draws.slice(-3)).toEqual(["source", "ink:1", "frame"]);
    draws.length = 0;
    receive({ ...key, kind: "geometry-pending", seq: 5 });
    await Promise.resolve();
    expect(draws).toEqual(["source", "frame"]);
    draws.length = 0;
    receive({ ...key, kind: "scene", seq: 6, scene: scene([pen, highlight]) });
    receive({ ...key, kind: "geometry", seq: 4, width: 640, height: 400 });
    receive({ ...key, kind: "resumed", seq: 7 });
    await Promise.resolve();
    callback?.();
    expect(draws).toEqual(["source", "frame", "source", "frame"]);
    draws.length = 0;
    receive({ ...key, kind: "geometry", seq: 8, width: 640, height: 400 });
    await Promise.resolve();
    expect(draws).toEqual(["source", "ink:2", "frame"]);
    expect(output.stream.getVideoTracks()[0]).toBe(track);
    expect(video.srcObject).toBe(capture);
    expect(raw.readyState).toBe("live");

    receive({ ...key, kind: "paused", seq: 9 });
    receive({ ...key, kind: "geometry-pending", seq: 10 });
    draws.length = 0;
    await Promise.resolve();
    expect(draws).toEqual([]);
    const next = { ...key, annotationId: "two" };
    receive({ ...next, kind: "opened", seq: 1 });
    await Promise.resolve();
    expect(draws).toEqual(["source", "frame"]);
    draws.length = 0;
    receive({ ...key, kind: "geometry", seq: 99, width: 640, height: 400 });
    receive({ ...next, kind: "scene", seq: 2, scene: scene([pen]) });
    await Promise.resolve();
    expect(draws).toEqual(["source", "frame"]);
    receive({ ...next, kind: "geometry", seq: 3, width: 640, height: 400 });
    await Promise.resolve();
    expect(draws.slice(-3)).toEqual(["source", "ink:1", "frame"]);

    receive({ ...next, kind: "geometry-pending", seq: 4 });
    receive({ ...next, kind: "closed", seq: 5, reason: "manual" });
    draws.length = 0;
    await Promise.resolve();
    expect(draws).toEqual(["source", "frame"]);
    receive({ ...next, kind: "geometry", seq: 6, width: 640, height: 400 });
    receive({ ...next, kind: "scene", seq: 7, scene: scene([pen]) });
    draws.length = 0;
    callback?.();
    expect(draws).toEqual(["source", "frame"]);
    expect(output.stream.getVideoTracks()[0]).toBe(track);
    expect(raw.readyState).toBe("live");
  } finally { output.dispose(); }
  expect(raw.readyState).toBe("live");
});
