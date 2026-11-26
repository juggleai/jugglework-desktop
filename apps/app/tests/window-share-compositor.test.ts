import { expect, test } from "bun:test";
import { createWindowShareCompositor } from "../src/react-app/domains/meeting/window-share-compositor";

function fixture() {
  const calls: string[] = [];
  let callback: (() => void) | undefined;
  const raw = { readyState: "live", stop: () => { raw.readyState = "ended"; calls.push("input-stop"); } };
  const capture = { getVideoTracks: () => [raw] } as unknown as MediaStream;
  const track = { requestFrame: () => calls.push("frame"), stop: () => calls.push("stop") };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const video = {
    videoWidth: 640, videoHeight: 400, muted: false, playsInline: false,
    srcObject: null, play: async () => {}, pause: () => { calls.push("pause"); },
    requestVideoFrameCallback: (cb: () => void) => { callback = cb; return 1; },
    cancelVideoFrameCallback: () => { callback = undefined; },
  };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => calls.push("source"), save: () => {}, restore: () => {} }), captureStream: () => stream };
  const document = { createElement: (tag: string) => tag === "video" ? video : canvas } as unknown as Document;
  return { calls, capture, raw, video, document, frame(width = video.videoWidth, height = video.videoHeight) {
    const before = calls.length;
    video.videoWidth = width;
    video.videoHeight = height;
    callback?.();
    return calls.slice(before);
  } };
}

test("clearing an overlay emits a clean frame without replacing the track or stopping input", async () => {
  const f = fixture();
  const compositor = await createWindowShareCompositor(f.capture, f.document);
  const track = compositor.stream.getVideoTracks()[0];
  compositor.setOverlay(() => f.calls.push("overlay"));
  await Promise.resolve();
  expect(f.calls.slice(-3)).toEqual(["source", "overlay", "frame"]);
  compositor.setOverlay(null);
  await Promise.resolve();
  expect(f.calls.slice(-2)).toEqual(["source", "frame"]);
  expect(compositor.stream.getVideoTracks()[0]).toBe(track);
  compositor.dispose();
  compositor.dispose();
  expect(f.calls.filter(call => call === "stop")).toHaveLength(1);
  expect(f.raw.readyState).toBe("live");
});

test("a new pixel size suppresses old ink until the frame geometry is confirmed", async () => {
  const f = fixture();
  const compositor = await createWindowShareCompositor(f.capture, f.document);
  try {
    compositor.confirmSize(640, 400);
    compositor.setOverlay(() => f.calls.push("overlay"));
    await Promise.resolve();
    f.video.videoWidth = 1280;
    f.video.videoHeight = 800;
    f.frame();
    expect(f.calls.slice(-2)).toEqual(["source", "frame"]);
    compositor.confirmSize(1280, 800);
    await Promise.resolve();
    expect(f.calls.slice(-3)).toEqual(["source", "overlay", "frame"]);
    compositor.setPaused(true);
    const before = f.calls.length;
    f.frame();
    expect(f.calls.length).toBe(before);
    compositor.setOverlay(null);
    compositor.setPaused(false);
    await Promise.resolve();
    expect(f.calls.slice(-2)).toEqual(["source", "frame"]);
  } finally { compositor.dispose(); }
});

test("opening ink survives the transition from the rounded frame to the exact native size once", async () => {
  const f = fixture();
  f.video.videoWidth = 3836;
  f.video.videoHeight = 2156;
  const compositor = await createWindowShareCompositor(f.capture, f.document);
  try {
    compositor.confirmSize(0, 0);
    compositor.confirmSize(3840, 2160);
    compositor.setOverlay(() => f.calls.push("overlay"));
    await Promise.resolve();
    expect(f.calls.slice(-3)).toEqual(["source", "overlay", "frame"]);
    expect(f.frame(3840, 2160)).toEqual(["source", "overlay", "frame"]);
    expect(f.frame(3836, 2156)).toEqual(["source", "frame"]);
    expect(f.frame(3840, 2160)).toEqual(["source", "frame"]);
  } finally { compositor.dispose(); }
});

test("returning to a previously confirmed size needs fresh confirmation after an unrecognized size", async () => {
  const f = fixture();
  const compositor = await createWindowShareCompositor(f.capture, f.document);
  try {
    const track = compositor.stream.getVideoTracks()[0];
    compositor.confirmSize(640, 400);
    compositor.setOverlay(() => f.calls.push("overlay"));
    await Promise.resolve();
    expect(f.calls.slice(-3)).toEqual(["source", "overlay", "frame"]);

    expect(f.frame(1280, 800)).toEqual(["source", "frame"]);
    expect(f.frame(640, 400)).toEqual(["source", "frame"]);
    f.calls.length = 0;
    compositor.confirmSize(640, 400);
    await Promise.resolve();
    expect(f.calls).toEqual(["source", "overlay", "frame"]);
    expect(compositor.stream.getVideoTracks()[0]).toBe(track);
  } finally { compositor.dispose(); }
});

test("a native-first confirmation is usable on the next size change only if it matches", async () => {
  const f = fixture();
  const compositor = await createWindowShareCompositor(f.capture, f.document);
  try {
    compositor.confirmSize(640, 400);
    compositor.setOverlay(() => f.calls.push("overlay"));
    await Promise.resolve();

    compositor.confirmSize(1280, 800);
    await Promise.resolve();
    expect(f.frame()).toEqual(["source", "frame"]);
    expect(f.frame(1280, 800)).toEqual(["source", "overlay", "frame"]);

    compositor.confirmSize(640, 400);
    await Promise.resolve();
    expect(f.frame(960, 600)).toEqual(["source", "frame"]);
    expect(f.frame(640, 400)).toEqual(["source", "frame"]);
  } finally { compositor.dispose(); }
});

test("geometry pending refreshes a static source without ink and keeps capture and output track live", async () => {
  const f = fixture();
  const compositor = await createWindowShareCompositor(f.capture, f.document);
  try {
    const track = compositor.stream.getVideoTracks()[0];
    compositor.confirmSize(640, 400);
    compositor.setOverlay(() => f.calls.push("overlay"));
    await Promise.resolve();
    expect(f.calls.slice(-3)).toEqual(["source", "overlay", "frame"]);

    f.calls.length = 0;
    compositor.setGeometryPending(true);
    await Promise.resolve();
    // No new video callback: invalidation must replace the last inked frame.
    expect(f.calls).toEqual(["source", "frame"]);
    expect(f.frame()).toEqual(["source", "frame"]);
    compositor.setOverlay(() => f.calls.push("latest-overlay"));
    await Promise.resolve();
    expect(f.calls.slice(-2)).toEqual(["source", "frame"]);

    compositor.confirmSize(640, 400);
    await Promise.resolve();
    expect(f.calls.slice(-2)).toEqual(["source", "frame"]);
    f.calls.length = 0;
    compositor.setGeometryPending(false);
    await Promise.resolve();
    expect(f.calls).toEqual(["source", "latest-overlay", "frame"]);
    expect(compositor.stream.getVideoTracks()[0]).toBe(track);
    expect(f.video.srcObject).toBe(f.capture);
    expect(f.raw.readyState).toBe("live");
    expect(f.calls).not.toContain("pause");
    expect(f.calls).not.toContain("input-stop");
    expect(f.calls).not.toContain("stop");
  } finally { compositor.dispose(); }
  expect(f.raw.readyState).toBe("live");
});

test("clearing pending alone cannot revive an old confirmation, including a size round trip", async () => {
  const f = fixture();
  const compositor = await createWindowShareCompositor(f.capture, f.document);
  try {
    compositor.setOverlay(() => f.calls.push("overlay"));
    await Promise.resolve();
    compositor.setGeometryPending(true);
    compositor.setGeometryPending(false);
    await Promise.resolve();
    expect(f.frame()).toEqual(["source", "frame"]);
    expect(f.frame(1280, 800)).toEqual(["source", "frame"]);
    expect(f.frame(640, 400)).toEqual(["source", "frame"]);
    compositor.confirmSize(640, 400);
    await Promise.resolve();
    expect(f.frame()).toEqual(["source", "overlay", "frame"]);

    compositor.setGeometryPending(true);
    compositor.confirmSize(640, 400);
    compositor.setGeometryPending(true);
    compositor.setGeometryPending(false);
    await Promise.resolve();
    expect(f.frame()).toEqual(["source", "frame"]);
  } finally { compositor.dispose(); }
});

test("pending recovery requires exact geometry even during the opening rounding grace", async () => {
  const f = fixture();
  f.video.videoWidth = 3836;
  f.video.videoHeight = 2156;
  const compositor = await createWindowShareCompositor(f.capture, f.document);
  try {
    compositor.confirmSize(0, 0);
    compositor.setOverlay(() => f.calls.push("overlay"));
    compositor.setGeometryPending(true);
    compositor.confirmSize(3840, 2160);
    compositor.setGeometryPending(false);
    await Promise.resolve();
    expect(f.frame()).toEqual(["source", "frame"]);
    expect(f.frame(3840, 2160)).toEqual(["source", "overlay", "frame"]);
  } finally { compositor.dispose(); }
});

test("minimization remains paused during pending and resumes clean until confirmed", async () => {
  const f = fixture();
  const compositor = await createWindowShareCompositor(f.capture, f.document);
  try {
    compositor.setOverlay(() => f.calls.push("overlay"));
    await Promise.resolve();
    compositor.setPaused(true);
    f.calls.length = 0;
    compositor.setGeometryPending(true);
    await Promise.resolve();
    expect(f.calls).toEqual([]);
    expect(f.frame()).toEqual([]);

    compositor.setPaused(false);
    await Promise.resolve();
    expect(f.calls).toEqual(["source", "frame"]);
    compositor.setPaused(true);
    compositor.confirmSize(640, 400);
    compositor.setGeometryPending(false);
    f.calls.length = 0;
    await Promise.resolve();
    expect(f.calls).toEqual([]);
    compositor.setPaused(false);
    await Promise.resolve();
    expect(f.calls).toEqual(["source", "overlay", "frame"]);
  } finally { compositor.dispose(); }
});
