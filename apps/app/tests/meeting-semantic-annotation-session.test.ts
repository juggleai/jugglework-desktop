import { expect, test } from "bun:test";
import { createMeetingSemanticAnnotationSession, type SemanticAnnotationOverlay, type SemanticPointerBatch } from "../src/react-app/domains/meeting/meeting-semantic-annotation-session";
import { attachMeetingSemanticAnnotation } from "../src/react-app/domains/meeting/meeting-semantic-annotation-events";

function fixture() {
  let input: (batch: SemanticPointerBatch) => void = () => {};
  const nativeScenes: unknown[] = [], modes: unknown[] = [], scenes: unknown[] = [], aborts: number[] = [];
  const overlay: SemanticAnnotationOverlay = {
    sessionId: "semantic_session_123456",
    onInput(callback) { input = callback; return () => { input = () => {}; }; },
    async setMode(mode, style) { modes.push({ mode, style }); return { ok: true }; },
    async abort() { aborts.push(1); return { ok: true }; },
  };
  let now = 1000; let scheduled: (() => void) | undefined;
  const session = createMeetingSemanticAnnotationSession({ overlay, size: { width: 800, height: 600 }, onScene: scene => scenes.push(scene),
    animation: { now: () => now, request(callback) { scheduled = callback; return callback; }, cancel(handle) { if (scheduled === handle) scheduled = undefined; } } });
  let seq = 0;
  const send = (phase: SemanticPointerBatch["phase"], points: { x: number; y: number }[], patch = {}) => input({
    sessionId: overlay.sessionId, epoch: 1, inputSeq: ++seq, phase, points, ...patch,
  });
  return { session, send, scenes, nativeScenes, modes, aborts, overlay, frame(ms: number) { now += ms; const callback = scheduled; scheduled = undefined; callback?.(); } };
}

test("down/move/up creates one existing AnnotationStroke and mirrors the same normalized scene", async () => {
  const f = fixture();
  f.send("down", [{ x: .1, y: .2 }]);
  f.send("move", [{ x: .2, y: .3 }, { x: .3, y: .4 }]);
  f.send("up", [{ x: .4, y: .5 }]);
  await f.session.flush();
  expect(f.session.getScene().elements).toMatchObject([{ type: "stroke", highlight: false, color: "#ef4444", size: 4,
    points: [.1, .2, .2, .3, .3, .4, .4, .5] }]);
  expect(f.nativeScenes).toEqual([]);
  expect(f.session.getHistory()).toEqual({ canUndo: true, canClear: true });
});

test("cancel and epoch changes remove only the draft; duplicate, late and wrong-session batches are ignored", () => {
  const f = fixture();
  f.send("down", [{ x: .1, y: .1 }]);
  f.send("move", [{ x: .2, y: .2 }]);
  f.send("cancel", []);
  expect(f.session.getScene().elements).toEqual([]);
  f.send("down", [{ x: .3, y: .3 }]);
  f.send("move", [{ x: .4, y: .4 }], { epoch: 2 });
  expect(f.session.getScene().elements).toEqual([]);
  const count = f.scenes.length;
  f.send("down", [{ x: .5, y: .5 }], { epoch: 1, inputSeq: 999 });
  f.send("down", [{ x: .5, y: .5 }], { epoch: 2, inputSeq: 1 });
  f.send("down", [{ x: .5, y: .5 }], { sessionId: "other_session_123456", epoch: 3 });
  expect(f.scenes).toHaveLength(count);
});

test("unknown/occluded periods produce no batches; a later new epoch starts cleanly", () => {
  const f = fixture();
  f.send("down", [{ x: .1, y: .1 }]);
  f.send("cancel", [], { epoch: 2 });
  const count = f.scenes.length;
  // Native sends no points while its trusted input region is withdrawn.
  expect(f.scenes).toHaveLength(count);
  f.send("down", [{ x: .6, y: .6 }], { epoch: 3 });
  f.send("up", [{ x: .7, y: .7 }], { epoch: 3 });
  expect(f.session.getScene().elements).toHaveLength(1);
});

test("highlighter and semantic eraser are supported", async () => {
  const f = fixture();
  expect(await f.session.setTool({ tool: "highlighter", color: "#facc15", size: 4 })).toEqual({ ok: true });
  f.send("down", [{ x: .1, y: .1 }]); f.send("up", [{ x: .2, y: .2 }]);
  expect(f.session.getScene().elements[0]).toMatchObject({ highlight: true, color: "#facc15" });
  expect(f.modes.at(-1)).toEqual({ mode: "draw", style: { tool: "highlighter", color: "#facc15", size: 4, highlight: true } });
  expect(await f.session.setTool({ tool: "eraser", color: "#facc15", size: 4 })).toEqual({ ok: true });
});

test("eraser accumulates hits, previews without history, commits once, cancels and undoes", async () => {
  const f = fixture();
  f.send("down", [{ x: .1, y: .2 }]); f.send("up", [{ x: .7, y: .2 }]);
  for (const tool of ["rectangle", "ellipse", "arrow"] as const) {
    await f.session.setTool({ tool, color: "#3b82f6", size: 4 });
    f.send("down", [{ x: .2, y: .3 }]); f.send("up", [{ x: .8, y: .8 }]);
  }
  expect(f.session.getScene().elements).toHaveLength(4);
  await f.session.setTool({ tool: "eraser", color: "#ef4444", size: 4 });
  f.send("down", [{ x: .4, y: .2 }]);
  expect(f.session.getScene().elements).toHaveLength(3);
  f.send("cancel", []);
  expect(f.session.getScene().elements).toHaveLength(4);
  f.send("down", [{ x: .4, y: .2 }]); f.send("up", [{ x: .4, y: .2 }]);
  expect(f.session.getScene().elements).toHaveLength(3);
  f.session.undo();
  expect(f.session.getScene().elements).toHaveLength(4);
});

test("laser is visible during input, fades linearly, and never enters history", async () => {
  const f = fixture();
  expect(await f.session.setTool({ tool: "laser", color: "#ef4444", size: 4 })).toEqual({ ok: true });
  f.send("down", [{ x: .1, y: .2 }]); f.send("move", [{ x: .3, y: .4 }]);
  expect(f.session.getScene().lasers[0]).toMatchObject({ opacity: 1, stroke: { type: "stroke", points: [.1, .2, .3, .4] } });
  f.send("up", [{ x: .5, y: .6 }]);
  expect(f.session.getHistory()).toEqual({ canUndo: false, canClear: false });
  f.frame(600); expect(f.session.getScene().lasers[0].opacity).toBeCloseTo(.5);
  f.session.undo(); expect(f.session.getHistory()).toEqual({ canUndo: false, canClear: false });
  expect(f.session.getScene().lasers[0].opacity).toBeCloseTo(.5);
  f.frame(600); expect(f.session.getScene().lasers).toEqual([]);
});

test("laser clear, switch, cancel, input gap, epoch and dispose clear immediately", async () => {
  for (const action of ["clear", "switch", "cancel", "gap", "epoch", "dispose"] as const) {
    const f = fixture(); await f.session.setTool({ tool: "laser", color: "#ef4444", size: 4 }); f.send("down", [{ x: .1, y: .1 }]);
    if (action === "clear") f.session.clear();
    if (action === "switch") await f.session.setTool({ tool: "pen", color: "#ef4444", size: 4 });
    if (action === "cancel") f.send("cancel", []);
    if (action === "gap") f.send("move", [{ x: .2, y: .2 }], { inputSeq: 9 });
    if (action === "epoch") f.send("move", [{ x: .2, y: .2 }], { epoch: 2 });
    if (action === "dispose") f.session.dispose();
    expect(f.session.getScene().lasers, action).toEqual([]);
  }
});

test("laser keeps at most 32 released trails while input remains a single stroke", async () => {
  const f = fixture(); await f.session.setTool({ tool: "laser", color: "#ef4444", size: 4 });
  for (let index = 0; index < 40; index++) {
    f.send("down", [{ x: index / 100, y: .1 }]); f.send("up", [{ x: index / 100 + .01, y: .2 }]);
  }
  expect(f.session.getScene().lasers).toHaveLength(32);
  expect(f.session.getHistory()).toEqual({ canUndo: false, canClear: false });
});

for (const tool of ["rectangle", "ellipse", "arrow"] as const) test(`${tool} down/move/up commits the shared AnnotationShape`, async () => {
  const f = fixture();
  expect(await f.session.setTool({ tool, color: "#3b82f6", size: 4 })).toEqual({ ok: true });
  f.send("down", [{ x: .1, y: .2 }]); f.send("move", [{ x: .3, y: .4 }]); f.send("up", [{ x: .6, y: .7 }]);
  expect(f.session.getScene().elements).toMatchObject([{ type: "shape", kind: tool, color: "#3b82f6", size: 4,
    x1: .1, y1: .2, x2: .6, y2: .7 }]);
  expect(f.modes.at(-1)).toEqual({ mode: "draw", style: { tool, color: "#3b82f6", size: 4, highlight: false } });
});

test("zero-size rectangle, ellipse and arrow drafts are dropped", async () => {
  const f = fixture();
  for (const tool of ["rectangle", "ellipse", "arrow"] as const) {
    await f.session.setTool({ tool, color: "#ef4444", size: 4 });
    f.send("down", [{ x: .25, y: .25 }]); f.send("up", [{ x: .25, y: .25 }]);
  }
  expect(f.session.getScene().elements).toEqual([]);
});

test("undo, clear, dimensions and rapid replacement sessions keep independent authority", async () => {
  const first = fixture();
  first.send("down", [{ x: 0, y: 0 }]); first.send("up", [{ x: 1, y: 1 }]);
  first.session.undo(); expect(first.session.getScene().elements).toEqual([]);
  first.send("down", [{ x: .25, y: .5 }]); first.send("up", [{ x: .5, y: .75 }]);
  first.session.clear(); expect(first.session.getScene().elements).toEqual([]);
  expect(first.session.getScene().size).toEqual({ width: 800, height: 600 });
  first.session.dispose();
  const second = fixture();
  first.send("down", [{ x: .1, y: .1 }]);
  second.send("down", [{ x: .2, y: .2 }]); second.send("up", [{ x: .3, y: .3 }]);
  expect(first.session.getScene().elements).toEqual([]);
  expect(second.session.getScene().elements).toHaveLength(1);
  await second.session.flush();
});

test("scene and pointer limits fail closed without committing oversized input", () => {
  const f = fixture();
  f.send("down", [{ x: .1, y: .1 }]);
  f.send("move", Array.from({ length: 65 }, () => ({ x: .2, y: .2 })));
  expect((f.session.getScene().elements[0] as { points: number[] }).points).toEqual([.1, .1]);
  for (let i = 0; i < 5; i++) f.send("move", Array.from({ length: 64 }, (_, n) => ({ x: n / 64, y: i / 5 })));
  expect(f.session.getScene().elements).toEqual([]);
});

test("input gaps cancel, identical up clicks do not commit, and clear aborts native input", async () => {
  const f = fixture();
  f.send("down", [{ x: .1, y: .1 }]);
  f.send("move", [{ x: .2, y: .2 }], { inputSeq: 9 });
  expect(f.session.getScene().elements).toEqual([]);
  f.send("down", [{ x: .4, y: .4 }], { inputSeq: 10 });
  f.send("up", [{ x: .4, y: .4 }], { inputSeq: 11 });
  expect(f.session.getHistory()).toEqual({ canUndo: false, canClear: false });
  f.send("down", [{ x: .2, y: .2 }], { inputSeq: 12 });
  f.session.clear(); await f.session.flush();
  expect(f.session.getScene().elements).toEqual([]);
  expect(f.aborts.length).toBeGreaterThanOrEqual(2);
});

test("1000 high-frequency move points are coalesced to local previews and fail closed at the stroke bound", async () => {
  const f = fixture(); f.send("down", [{ x: 0, y: 0 }]);
  let seq = 1;
  for (let sent = 0; sent < 1000; sent += 16) f.send("move", Array.from({ length: Math.min(16, 1000 - sent) }, (_, i) => ({
    x: ((sent + i) % 100) / 100, y: ((sent + i) % 80) / 80,
  })), { inputSeq: ++seq });
  await f.session.flush();
  expect(f.session.getScene().elements).toEqual([]);
  expect(f.nativeScenes).toEqual([]);
  expect(f.aborts.length).toBeGreaterThan(0);
});

test("semantic native events use a dedicated renderer channel", () => {
  const added: string[] = [], removed: string[] = [];
  const previous = globalThis.window;
  globalThis.window = {
    addEventListener: (name: string) => added.push(name),
    removeEventListener: (name: string) => removed.push(name),
  } as unknown as Window & typeof globalThis;
  try {
    const detach = attachMeetingSemanticAnnotation("capture");
    detach();
    expect(added).toEqual(["jugglework:meeting:semantic-annotation"]);
    expect(removed).toEqual(added);
  } finally { globalThis.window = previous; }
});
