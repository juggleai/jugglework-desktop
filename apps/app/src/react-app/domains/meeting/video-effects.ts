import { MEETING_BACKGROUND_PRESETS } from "./meeting-background-catalog";
import { meetingAvatars, type MeetingAvatar } from "./meeting-avatar-catalog";
import { readImportedBackgroundUrl } from "./meeting-background-imports";

type PhotoId = `scene-${string}` | `custom-${string}`;
export type MeetingVideoEffects = {
  background: "none" | "studio" | "sky" | "blur" | PhotoId;
  avatar: "none" | MeetingAvatar;
  beauty: number;
  filter: "none" | "warm" | "cool" | "mono";
};

const FPS = 20;
const filters = { none: "", warm: "sepia(0.28) saturate(1.2)", cool: "sepia(0.22) hue-rotate(155deg)", mono: "grayscale(1)" };
type Context = CanvasRenderingContext2D;

function isPhoto(id: MeetingVideoEffects["background"]): id is PhotoId {
  return id.startsWith("scene-") || id.startsWith("custom-");
}

// A single output-sized, opaque photo per track. Reads and decodes are never awaited by render().
function photoCache(width: number, height: number) {
  type Entry = { id: PhotoId; image?: HTMLImageElement; frame?: HTMLCanvasElement };
  let active: Entry | undefined;
  function release() {
    if (!active) return;
    if (active.frame) active.frame.width = 0;
    active.image?.removeAttribute("src");
    active.image = undefined;
    active = undefined;
  }
  async function load(entry: Entry) {
    try {
      const custom = entry.id.startsWith("custom-");
      const url = custom ? await readImportedBackgroundUrl(entry.id) : MEETING_BACKGROUND_PRESETS.find(p => p.id === entry.id)?.url;
      if (active !== entry || !url || (custom && !url.startsWith("data:image/"))) return;
      const image = entry.image = new Image();
      image.decoding = "async";
      image.crossOrigin = "anonymous";
      image.src = url;
      await image.decode();
      if (active !== entry || !image.naturalWidth || !image.naturalHeight) return;
      const frame = document.createElement("canvas");
      frame.width = width;
      frame.height = height;
      const ctx = frame.getContext("2d", { alpha: false });
      if (!ctx) return;
      // Flatten transparency and center-crop once, not on every video frame.
      ctx.fillStyle = "#262947";
      ctx.fillRect(0, 0, width, height);
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const sw = width / scale, sh = height / scale;
      ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, 0, 0, width, height);
      entry.frame = frame;
    } catch {
      // Keep the opaque placeholder; retry only when the photo is reselected.
    } finally {
      entry.image?.removeAttribute("src");
      entry.image = undefined;
    }
  }
  return {
    select(id: MeetingVideoEffects["background"]) {
      const photoId = isPhoto(id) ? id : undefined;
      if (photoId !== active?.id) {
        release();
        if (photoId) {
          active = { id: photoId };
          void load(active);
        }
      }
      return active?.frame;
    },
    release,
  };
}

function backdrop(ctx: Context, preset: MeetingVideoEffects["background"], photo?: HTMLCanvasElement) {
  const { width, height } = ctx.canvas;
  if (photo) {
    ctx.drawImage(photo, 0, 0);
    return;
  }
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  if (preset === "sky") {
    gradient.addColorStop(0, "#427dc1");
    gradient.addColorStop(0.8, "#c6ebfa");
    gradient.addColorStop(1, "#f9dfc2");
  } else {
    gradient.addColorStop(0, "#262947");
    gradient.addColorStop(0.7, "#676990");
    gradient.addColorStop(1, "#353552");
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function avatar(ctx: Context, kind: MeetingAvatar) {
  const { width, height } = ctx.canvas;
  const size = Math.min(width, height) * 0.32;
  ctx.save();
  ctx.translate(width / 2, height / 2 + size * 0.04 * Math.sin(performance.now() / 550));
  if (kind !== "cat" && kind !== "robot") {
    ctx.font = `${Math.round(size * 1.75)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(meetingAvatars[kind][1], 0, 0);
    ctx.restore();
    return;
  }
  ctx.scale(size, size);
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  if (kind === "cat") {
    ctx.fillStyle = "#ffb265";
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 0.88, -0.32);
      ctx.lineTo(side * 0.85, -1);
      ctx.lineTo(side * 0.25, -0.59);
      ctx.fill();
    }
    oval(0, 0, 0.93, 0.78, "#ffb265");
    oval(0, 0.28, 0.42, 0.25, "#fff0d2");
    oval(0, 0.16, 0.12, 0.08, "#bd6767");
  } else {
    ctx.fillStyle = "#9adbe6";
    ctx.fillRect(-0.05, -0.93, 0.1, 0.4);
    oval(0, -0.96, 0.13, 0.13, "#ffb768");
    ctx.fillRect(-0.95, -0.65, 1.9, 1.31);
    ctx.fillStyle = "#264660";
    ctx.fillRect(-0.74, -0.37, 1.48, 0.55);
    ctx.fillRect(-0.3, 0.33, 0.6, 0.08);
  }
  for (const side of [-1, 1]) oval(side * 0.38, -0.11, 0.11, 0.14, kind === "cat" ? "#392d42" : "#89ffdf");
  ctx.restore();
}

// Key the unfiltered input: changing the color grade must not change the matte.
function greenScreen(ctx: Context, preset: MeetingVideoEffects["background"], photo?: HTMLCanvasElement) {
  const { width, height } = ctx.canvas;
  const frame = ctx.getImageData(0, 0, width, height);
  const pixels = frame.data;
  let keyed = false;
  for (let i = 0; i < pixels.length; i += 4) {
    const g = pixels[i + 1];
    const other = Math.max(pixels[i], pixels[i + 2]);
    const dominance = g - other;
    if (g < 50 || dominance <= 18) continue;
    const removal = Math.min(1, (dominance - 18) / 40);
    keyed ||= removal === 1;
    pixels[i + 3] *= 1 - removal;
    pixels[i + 1] -= dominance * removal; // suppress green spill at soft edges
  }
  if (keyed) {
    ctx.putImageData(frame, 0, 0);
    ctx.globalCompositeOperation = "destination-over";
  } else {
    // Discard the camera completely before drawing the replacement, even if that draw is a no-op.
    ctx.clearRect(0, 0, width, height);
  }
  backdrop(ctx, preset, photo);
  ctx.globalCompositeOperation = "source-over";
}

/** The caller owns raw. Only a completed frame from the private work canvas can be published. */
export async function createMeetingEffectTrack(raw: MediaStreamTrack, read: () => MeetingVideoEffects): Promise<{
  track: MediaStreamTrack;
  stop(): void;
}> {
  if (raw.kind !== "video" || raw.readyState === "ended") throw new Error("Expected a live video track");
  const video = document.createElement("video");
  const work = document.createElement("canvas");
  const output = document.createElement("canvas");
  const settings = raw.getSettings();
  const w = settings.width || 640, h = settings.height || 360;
  const scale = Math.min(1, 640 / w, 480 / h);
  output.width = work.width = Math.max(1, Math.round(w * scale));
  output.height = work.height = Math.max(1, Math.round(h * scale));
  const photos = photoCache(work.width, work.height);

  let capture: MediaStream | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const listeners = new AbortController();
  function stop() {
    if (stopped) return;
    stopped = true;
    listeners.abort();
    clearInterval(timer);
    photos.release();
    for (const track of capture?.getTracks() ?? []) {
      track.enabled = false;
      track.stop();
    }
    video.pause();
    video.srcObject = null;
    work.width = output.width = 0;
  }

  try {
    const ctx = work.getContext("2d", { willReadFrequently: true });
    const dest = output.getContext("2d", { alpha: false });
    if (!ctx || !dest) throw new Error("Canvas 2D is unavailable");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([raw]);
    for (const [source, event] of [[raw, "ended"], [video, "error"], [work, "contextlost"], [output, "contextlost"]] as const) {
      source.addEventListener(event, stop, { signal: listeners.signal });
    }
    // play() may stay pending indefinitely without input frames. Return a cancellable,
    // publishable track immediately; the timer also renders avatars without camera frames.
    void video.play().catch(stop);
    capture = output.captureStream(FPS);
    const [track] = capture.getVideoTracks();
    if (!track) throw new Error("Canvas video capture is unavailable");
    const render = () => {
      const { avatar: kind, background, beauty, filter } = read();
      const { width, height } = work;
      const photo = photos.select(background);
      ctx.clearRect(0, 0, width, height);
      const cameraReady = !raw.muted && raw.enabled && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
      if ((isPhoto(background) && !photo) || kind !== "none" || !cameraReady) {
        backdrop(ctx, background, photo);
        if (kind !== "none") avatar(ctx, kind);
      } else {
        ctx.drawImage(video, 0, 0, width, height);
        if (background !== "none" && background !== "blur") greenScreen(ctx, background, photo);
      }
      const amount = Number.isFinite(beauty) ? Math.min(100, Math.max(0, beauty)) / 100 : 0;
      const soft = amount ? `blur(${0.7 * amount}px) brightness(${1 + 0.06 * amount}) contrast(${1 - 0.06 * amount})` : "";
      // This is deliberately whole-frame blur, not person segmentation.
      dest.filter = [background === "blur" ? "blur(16px)" : "", soft, filters[filter]].filter(Boolean).join(" ") || "none";
      dest.globalCompositeOperation = "copy";
      dest.drawImage(work, 0, 0);
    };
    render();
    timer = setInterval(() => {
      // Calling MediaStreamTrack.stop() directly does not dispatch an ended event.
      if (raw.readyState === "ended" || track.readyState === "ended") return stop();
      try { render(); } catch { stop(); }
    }, 1000 / FPS);
    return { track, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
