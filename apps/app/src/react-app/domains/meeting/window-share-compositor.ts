type DrawOverlay = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
type PixelSize = { width: number; height: number };

export type WindowShareCompositor = {
  stream: MediaStream;
  setOverlay(draw: DrawOverlay | null): void;
  confirmSize(width: number, height: number): void;
  setGeometryPending(pending: boolean): void;
  setPaused(paused: boolean): void;
  getPixelSize(): PixelSize | null;
  dispose(): void;
};

/** The caller owns the original capture. This only owns the canvas output. */
export async function createWindowShareCompositor(capture: MediaStream, doc = document): Promise<WindowShareCompositor> {
  const video = doc.createElement("video");
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx || typeof canvas.captureStream !== "function" || typeof video.requestVideoFrameCallback !== "function")
    throw new Error("窗口画面合成不可用");
  let stream: MediaStream | undefined;
  let latestFrame: number | undefined;
  let disposed = false, paused = false, geometryPending = false, queued = false;
  let overlay: DrawOverlay | null = null;
  let opening = true;
  let geometry: { target: PixelSize; waitingFrom?: PixelSize & { allowInk: boolean } } | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (latestFrame !== undefined) video.cancelVideoFrameCallback(latestFrame);
    video.pause();
    video.srcObject = null;
    stream?.getTracks().forEach(track => track.stop());
  };
  video.muted = true;
  video.playsInline = true;
  video.srcObject = capture;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await video.play();
        if (disposed) return;
        if (!video.videoWidth || !video.videoHeight) await new Promise<void>(resolve => {
          latestFrame = video.requestVideoFrameCallback(() => resolve());
        });
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("等待窗口画面超时")), 2000); }),
    ]);
    if (!video.videoWidth || !video.videoHeight) throw new Error("窗口画面尺寸不可用");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    geometry = { target: { width: canvas.width, height: canvas.height } };
    stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
    if (!track || typeof track.requestFrame !== "function") throw new Error("窗口画面输出轨不可用");
    const paint = () => {
      const { videoWidth: width, videoHeight: height } = video;
      if (disposed || paused || !width || !height) return;
      let allowInk = false;
      if (geometry) {
        if (width === geometry.target.width && height === geometry.target.height) {
          geometry.waitingFrom = undefined;
          allowInk = true;
        } else if (width === geometry.waitingFrom?.width && height === geometry.waitingFrom.height) {
          allowInk = geometry.waitingFrom.allowInk;
        } else {
          // An unexpected size ends this confirmation, even if its dimensions return later.
          geometry = undefined;
        }
      }
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.drawImage(video, 0, 0, width, height);
      if (overlay && allowInk && !geometryPending) {
        ctx.save();
        try { overlay(ctx, width, height); } finally { ctx.restore(); }
      }
      track.requestFrame();
    };
    const invalidate = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => { queued = false; paint(); });
    };
    const tick = () => {
      if (disposed) return;
      latestFrame = video.requestVideoFrameCallback(tick);
      paint();
    };
    tick();
    return {
      stream,
      setOverlay(draw) { overlay = draw; invalidate(); },
      confirmSize(width, height) {
        if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
          geometry = undefined;
          opening = true;
        } else {
          const { videoWidth, videoHeight } = video;
          geometry = { target: { width, height } };
          if (videoWidth !== width || videoHeight !== height) {
            // A native-first confirmation can wait through the current frame size.
            // Only at opening may that size also carry ink while Chromium settles.
            geometry.waitingFrom = {
              width: videoWidth, height: videoHeight,
              allowInk: opening && Math.abs(videoWidth - width) <= 4 && Math.abs(videoHeight - height) <= 4,
            };
          }
          opening = false;
        }
        invalidate();
      },
      setGeometryPending(value) {
        geometryPending = value;
        if (value) {
          // A transient ends the old confirmation even if the dimensions never
          // change. Only confirmSize followed by clearing pending can restore ink.
          geometry = undefined;
          opening = false;
        }
        invalidate();
      },
      setPaused(value) { paused = value; if (!paused) invalidate(); },
      getPixelSize() {
        const { videoWidth: width, videoHeight: height } = video;
        return !disposed && width > 0 && height > 0 ? { width, height } : null;
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  } finally { clearTimeout(timer); }
}
