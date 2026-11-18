import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { MeetingVideoEffects } from "../src/react-app/domains/meeting/video-effects";

const imported = mock(async (_id: string): Promise<string | null> => null);
mock.module("../src/react-app/domains/meeting/meeting-background-imports", () => ({ readImportedBackgroundUrl: imported }));
mock.module("../src/react-app/domains/meeting/meeting-background-catalog", () => ({ MEETING_BACKGROUND_PRESETS: [
  { id: "scene-room", label: "Room", url: "/room.jpg" },
] }));
const { createMeetingEffectTrack } = await import("../src/react-app/domains/meeting/video-effects");

class Track extends EventTarget {
  kind = "video";
  enabled = true;
  muted = false;
  readyState = "live";
  getSettings = () => ({ width: 1920, height: 1080 });
  stop = mock(() => { this.readyState = "ended"; });
}

class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
}

const restores: (() => void)[] = [];
function stub(name: string, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  restores.push(() => old ? Object.defineProperty(globalThis, name, old) : Reflect.deleteProperty(globalThis, name));
}
afterEach(() => {
  imported.mockReset().mockResolvedValue(null);
  while (restores.length) restores.pop()!();
  mock.restore();
});

function setup() {
  const raw = new Track(), owned = new Track();
  const settings: MeetingVideoEffects = { background: "none", avatar: "none", beauty: 0, filter: "none" };
  const video = Object.assign(new EventTarget(), {
    readyState: 2, videoWidth: 1920, videoHeight: 1080, srcObject: null,
    play: mock((): Promise<void> => new Promise(() => {})), pause: mock(() => {}),
  });
  function canvas() {
    const el = Object.assign(new EventTarget(), {
      width: 0, height: 0, captureStream: mock((_fps: number) => new Stream([owned])), getContext: () => ctx,
    });
    const ctx = {
      canvas: el as { width: number; height: number }, globalCompositeOperation: "source-over",
      drawImage: mock((_source: unknown, ..._coords: number[]): string => ctx.globalCompositeOperation),
      clearRect() {}, fillRect: mock(() => {}), createLinearGradient: () => ({ addColorStop() {} }),
      getImageData: mock(() => ({ data: new Uint8ClampedArray([0, 200, 0, 255, 160, 100, 90, 255, 30, 67, 30, 255]) })),
      putImageData: mock((_img: { data: Uint8ClampedArray }) => {}), filter: "none",
      save() {}, translate() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {},
      fill() {}, ellipse: mock(() => {}), fillText: mock(() => {}), restore() {},
    };
    return { el, ctx };
  }
  const work = canvas(), output = canvas();
  const canvases = [work.el, output.el];
  const photos: ReturnType<typeof canvas>[] = [];
  stub("document", { createElement: (tag: string) => {
    if (tag === "video") return video;
    if (canvases.length) return canvases.shift();
    const photo = canvas();
    photos.push(photo);
    return photo.el;
  } });
  stub("MediaStream", Stream);
  let tick: (() => void) | undefined;
  let interval = 0;
  stub("setInterval", (cb: () => void, ms: number) => { tick = cb; interval = ms; return 19; });
  const clear = mock(() => { tick = undefined; });
  stub("clearInterval", clear);
  const read = mock(() => settings);
  return { raw, owned, settings, work, output, photos, video, read, clear, interval: () => interval, tick: () => tick?.(),
    start: () => createMeetingEffectTrack(raw as unknown as MediaStreamTrack, read) };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function stubImages() {
  const images: ImageStub[] = [];
  class ImageStub {
    src = "";
    naturalWidth = 800;
    naturalHeight = 800;
    ready = deferred<void>();
    decode = mock(() => this.ready.promise);
    removeAttribute = mock(() => { this.src = ""; });
    constructor() { images.push(this); }
  }
  stub("Image", ImageStub);
  return images;
}

test("photos use one opaque centered cover crop: behind a keyed subject or instead of a non-keyed frame", async () => {
  const h = setup(), images = stubImages();
  h.settings.background = "scene-room";
  const effect = await h.start();
  h.tick();
  expect(h.work.ctx.drawImage).not.toHaveBeenCalled();
  expect(h.work.ctx.fillRect).toHaveBeenCalledTimes(2);
  expect(images[0].src).toBe("/room.jpg");
  images[0].ready.resolve();
  await images[0].ready.promise;
  h.tick();
  const [photo] = h.photos;
  expect(photo.ctx.fillRect).toHaveBeenCalledWith(0, 0, 640, 360);
  expect(photo.ctx.drawImage).toHaveBeenCalledWith(images[0], 0, 175, 800, 450, 0, 0, 640, 360);
  expect(h.work.ctx.drawImage).toHaveBeenLastCalledWith(photo.el, 0, 0);
  expect(h.work.ctx.drawImage.mock.results.at(-1)?.value).toBe("destination-over");
  h.work.ctx.getImageData.mockReturnValue({ data: new Uint8ClampedArray([100, 100, 100, 255]) });
  h.tick();
  expect(h.work.ctx.drawImage).toHaveBeenLastCalledWith(photo.el, 0, 0);
  expect(h.work.ctx.drawImage.mock.results.at(-1)?.value).toBe("source-over");
  expect(images).toHaveLength(1);
  expect(photo.ctx.drawImage).toHaveBeenCalledTimes(1);
  effect.stop();
  expect(photo.el.width).toBe(0);
});

test("late reads and decodes cannot restore an old selection or resurrect a stopped track", async () => {
  const h = setup(), images = stubImages();
  const oldRead = deferred<string | null>();
  imported.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce("data:image/png;base64,AA==");
  h.settings.background = "custom-a";
  const effect = await h.start();
  h.settings.background = "scene-room";
  h.tick();
  h.settings.background = "custom-b";
  h.tick();
  h.tick();
  await Promise.resolve();
  expect(imported.mock.calls).toEqual([["custom-a"], ["custom-b"]]);
  expect(images[1].src).toBe("data:image/png;base64,AA==");
  oldRead.resolve("data:image/png;base64,AQ==");
  images[0].ready.resolve();
  await Promise.resolve();
  h.tick();
  expect(images).toHaveLength(2);
  expect(h.photos).toHaveLength(0);
  expect(h.work.ctx.drawImage).not.toHaveBeenCalled();
  effect.stop();
  expect(images[1].src).toBe("");
  images[1].ready.resolve();
  await Promise.resolve();
  expect(h.photos).toHaveLength(0);
});

test("switching away from a ready custom photo keeps publishing opaque frames on load errors", async () => {
  const h = setup(), images = stubImages();
  imported.mockResolvedValueOnce("data:image/png;base64,AA==").mockRejectedValueOnce(new Error("storage failed")).mockResolvedValueOnce(null);
  h.settings.background = "custom-good";
  const effect = await h.start();
  images[0].ready.resolve();
  await Promise.resolve();
  h.tick();
  expect(h.work.ctx.drawImage).toHaveBeenLastCalledWith(h.photos[0].el, 0, 0);
  h.work.ctx.drawImage.mockClear();
  for (const id of ["custom-offline", "custom-deleted", "scene-unknown", "scene-room"] as const) {
    h.settings.background = id;
    h.tick();
    if (id === "scene-room") images[1].ready.reject(new Error("bad image"));
    await Promise.resolve();
    h.tick();
  }
  expect(h.photos[0].el.width).toBe(0);
  expect(h.work.ctx.drawImage).not.toHaveBeenCalled();
  expect(h.work.ctx.fillRect).toHaveBeenCalledTimes(9);
  expect(h.output.ctx.drawImage).toHaveBeenCalledTimes(10);
  expect(h.owned.readyState).toBe("live");
  effect.stop();
});

test("whole-frame blur works without a green screen and resets when switched off", async () => {
  const h = setup();
  h.settings.background = "blur";
  h.settings.filter = "cool";
  const effect = await h.start();
  expect(h.work.ctx.drawImage).toHaveBeenCalledWith(h.video, 0, 0, 640, 360);
  expect(h.work.ctx.getImageData).not.toHaveBeenCalled();
  expect(h.output.ctx.filter).toMatch(/blur\(16px\).*hue-rotate/);
  h.settings.background = "none";
  h.tick();
  expect(h.output.ctx.filter).not.toContain("blur");
  effect.stop();
});

test("publishes a separate, bounded track while play is pending; stop is idempotent", async () => {
  const h = setup();
  const effect = await h.start();
  expect(effect.track).toBe(h.owned as unknown as MediaStreamTrack);
  expect(h.output.el).toMatchObject({ width: 640, height: 360 });
  expect(h.output.el.captureStream).toHaveBeenCalledWith(20);
  expect(h.interval()).toBe(50);
  effect.stop();
  effect.stop();
  h.raw.dispatchEvent(new Event("ended"));
  expect(h.clear).toHaveBeenCalledTimes(1);
  expect(h.owned.stop).toHaveBeenCalledTimes(1);
  expect(h.video.srcObject).toBeNull();
  expect(h.raw.readyState).toBe("live");
  expect(h.raw.enabled).toBe(true);
});

test("keys original pixels, preserving the subject and feathering the edge; edits take effect on the same track", async () => {
  const h = setup();
  h.settings.background = "sky";
  await h.start();
  const [{ data }] = h.work.ctx.putImageData.mock.calls[0];
  expect(data[3]).toBe(0);
  expect([...data.slice(4, 8)]).toEqual([160, 100, 90, 255]);
  expect(data[11]).toBeGreaterThan(0);
  expect(data[11]).toBeLessThan(255);
  expect(h.output.ctx.drawImage.mock.calls[0][0]).toBe(h.work.el);
  h.settings.filter = "mono";
  h.settings.beauty = 500;
  h.tick();
  const max = h.output.ctx.filter;
  expect(max).toContain("blur(");
  expect(max).toContain("grayscale(1)");
  h.settings.beauty = 100;
  h.tick();
  expect(h.output.ctx.filter).toBe(max);
  h.settings.beauty = -1;
  for (const filter of ["warm", "cool", "none"] as const) {
    h.settings.filter = filter;
    h.tick();
    expect(h.output.ctx.filter.includes("blur")).toBe(false);
    expect(h.output.ctx.filter === "none").toBe(filter === "none");
  }
});

test("background without a usable key is replaced; avatars and missing frames never sample the camera", async () => {
  const h = setup();
  h.work.ctx.getImageData.mockReturnValue({ data: new Uint8ClampedArray([180, 140, 130, 255]) });
  h.settings.background = "studio";
  await h.start();
  expect(h.work.ctx.fillRect).toHaveBeenCalledWith(0, 0, 640, 360);
  expect(h.work.ctx.putImageData).not.toHaveBeenCalled();
  h.work.ctx.drawImage.mockClear();
  for (const avatar of ["cat", "robot"] as const) {
    h.settings.avatar = avatar;
    h.work.ctx.ellipse.mockClear();
    h.tick();
    expect(h.work.ctx.ellipse).toHaveBeenCalled();
  }
  h.settings.avatar = "panda";
  h.tick();
  expect(h.work.ctx.fillText).toHaveBeenCalledWith("🐼", 0, 0);
  h.settings.avatar = "none";
  h.video.readyState = 0;
  h.tick();
  expect(h.work.ctx.drawImage).not.toHaveBeenCalled();
  expect(h.output.ctx.drawImage.mock.calls.every(([src]) => src === h.work.el)).toBe(true);
});

test("failed keying after an unfiltered frame never commits the partial frame", async () => {
  const h = setup();
  await h.start();
  h.settings.background = "sky";
  h.work.ctx.getImageData.mockImplementation(() => { throw new Error("readback failed"); });
  h.tick();
  expect(h.output.ctx.drawImage).toHaveBeenCalledTimes(1);
  expect(h.owned.enabled).toBe(false);
  expect(h.owned.readyState).toBe("ended");
  expect(h.raw.stop).not.toHaveBeenCalled();
  expect(h.video.srcObject).toBeNull();
  expect(h.clear).toHaveBeenCalled();
});

test("setup failure cleans up the capture and detaches the borrowed track", async () => {
  const h = setup();
  h.read.mockImplementation(() => { throw new Error("settings unavailable"); });
  await expect(h.start()).rejects.toThrow("settings unavailable");
  expect(h.owned.stop).toHaveBeenCalled();
  expect(h.video.srcObject).toBeNull();
  expect(h.raw.stop).not.toHaveBeenCalled();
});

for (const cause of ["play rejection", "source ended", "source stopped", "output stopped", "context lost"] as const) {
  test(`releases processing resources on ${cause}`, async () => {
    const h = setup();
    if (cause === "play rejection") spyOn(h.video, "play").mockRejectedValue(new Error("decoder unavailable"));
    await h.start();
    if (cause === "source ended") h.raw.dispatchEvent(new Event("ended"));
    if (cause === "source stopped") h.raw.stop();
    if (cause === "output stopped") h.owned.stop();
    if (cause === "context lost") h.work.el.dispatchEvent(new Event("contextlost"));
    h.tick();
    expect(h.owned.readyState).toBe("ended");
    expect(h.video.srcObject).toBeNull();
    expect(h.clear).toHaveBeenCalledTimes(1);
  });
}
