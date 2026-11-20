import { meetingDiagnostic, meetingDiagnosticError, meetingDiagnosticStep, meetingNumericMetrics, meetingTrackSnapshot } from "./diagnostics";
import { ensureMeetingMediaPermissions, handleScreenCaptureDenied, meetingDeviceError } from "./media-permission";
import type { MeetingJoin } from "./types";
import type { WindowShareCompositor } from "./window-share-compositor";

type WindowComposition = { captureId: string; compositor: WindowShareCompositor };
const WINDOW_PUBLICATION_TIMEOUT_MS = 15_000;
// The vendored Web SDK is loaded once, without initializing JuggleCall.
let loaded: Promise<void> | null = null;
async function loadZego() {
  if (window.ZegoExpressEngine) return;
  if (!loaded)
    loaded = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(
        `${import.meta.env.BASE_URL}jugglechat/vendor/ZegoExpressWebRTC-3.12.0.js`,
        document.baseURI,
      ).href;
      script.onload = () =>
        window.ZegoExpressEngine
          ? resolve()
          : reject(new Error("ZEGO SDK 未正确加载"));
      script.onerror = () => {
        script.remove();
        loaded = null;
        reject(new Error("无法加载 ZEGO SDK"));
      };
      document.head.appendChild(script);
    });
  await loaded;
}
export type MediaTile = {
  id: string;
  userId: string;
  stream: MediaStream;
  screen: boolean;
};
export class MeetingMedia {
  private engine: any;
  private joinInfo?: MeetingJoin;
  private local?: MediaStream;
  private share?: MediaStream;
  private shareCapture?: MediaStream;
  private windowComposition?: WindowComposition;
  private cancelWindowPublication?: () => void;
  private shareStarting = false;
  private shareGeneration = 0;
  // Keep SDK-created source previews alive while their tracks are published.
  private cameraSource?: MediaStream;
  private disposed = false;
  private cameraEnabled = false;
  private cameraCaptured = false;
  // ZEGO creates a live silent WebAudio track even when camera.audio is false.
  // Track presence alone does not mean that microphone capture was authorized.
  private microphoneCaptured = false;
  private diagnosticTimer?: ReturnType<typeof setInterval>;
  private diagnosticStreams = new Map<string, MediaStream>();
  private remote = new Set<string>();
  private remoteEpoch = new Map<string, number>();
  constructor(
    private update: (tile: MediaTile | null, id: string) => void,
    private error: (message: string) => void,
    private disconnected: () => void,
  ) {}
  async join(info: MeetingJoin, mic: boolean, camera: boolean) {
    await loadZego();
    if (this.disposed) return;
    const Engine = window.ZegoExpressEngine as unknown as new (
      appId: number,
    ) => any;
    this.engine = new Engine(info.appId);
    this.joinInfo = info;
    meetingDiagnostic("rtc.join", { meetingId: info.meeting.id, roomId: info.roomId, userId: info.userId, sessionId: info.sessionId, mic, camera });
    const sampled = new Map<string, number>();
    for (const event of ["publisherStateUpdate", "playerStateUpdate", "roomStateUpdate", "publishQualityUpdate", "playQualityUpdate", "remoteMicStatusUpdate", "remoteCameraStatusUpdate", "deviceError"]) {
      this.engine.on(event, (...args: unknown[]) => {
        if (this.disposed) return;
        const key = `${event}:${typeof args[0] === "string" ? args[0] : ""}`;
        if (event.includes("Quality") && Date.now() - (sampled.get(key) || 0) < 5000) return;
        sampled.set(key, Date.now());
        const detail = args[0] && typeof args[0] === "object" ? args[0] as Record<string, unknown> : {};
        const id = typeof args[0] === "string" ? args[0] : detail.streamID;
        const state = typeof args[1] === "string" ? args[1] : detail.state;
        meetingDiagnostic(`rtc.${event}`, { id: event !== "deviceError" && typeof id === "string" ? id.slice(0, 200) : undefined,
          state: typeof state === "string" && /^[A-Z_]+$/.test(state) ? state : undefined,
          metrics: args.map(a => meetingNumericMetrics(a)) });
      });
    }
    let previousTick = performance.now();
    this.diagnosticTimer = setInterval(() => {
      const now = performance.now();
      meetingDiagnostic("rtc.sample", { elapsedMs: now - previousTick, visibility: document.visibilityState,
        cameraEnabled: this.cameraEnabled, microphoneCaptured: this.microphoneCaptured,
        streams: [...this.diagnosticStreams].map(([id, stream]) => ({ id, streamId: stream.id, tracks: meetingTrackSnapshot(stream) })) });
      previousTick = now;
    }, 5000);
    this.engine.on(
      "roomStreamUpdate",
      (
        _room: string,
        type: string,
        streams: Array<{ streamID: string; user: { userID: string } }>,
      ) => {
        meetingDiagnostic("rtc.streams", { type, streams: streams.map(s => ({ id: s.streamID, userId: s.user.userID })) });
        for (const stream of streams) {
          const id = stream.streamID;
          if (stream.user.userID === info.userId) continue;
          if (type === "ADD") {
            if (this.remote.has(id)) continue;
            const epoch = (this.remoteEpoch.get(id) || 0) + 1;
            this.remoteEpoch.set(id, epoch);
            this.remote.add(id);
            void meetingDiagnosticStep("rtc.play", { id }, () => this.engine.startPlayingStream(id) as Promise<MediaStream>)
              .then((media: MediaStream) => {
                if (this.disposed || !this.remote.has(id) || this.remoteEpoch.get(id) !== epoch) {
                  media.getTracks().forEach((t) => t.stop());
                  return;
                }
                this.diagnosticStreams.set(id, media);
                this.update(
                  {
                    id,
                    userId: stream.user.userID,
                    stream: media,
                    screen: id.endsWith("_screen"),
                  },
                  id,
                );
              })
              .catch(() => this.error("部分远端媒体连接失败，请检查网络。"));
          } else if (type === "DELETE") {
            this.remoteEpoch.set(id, (this.remoteEpoch.get(id) || 0) + 1);
            this.remote.delete(id);
            this.diagnosticStreams.delete(id);
            this.engine.stopPlayingStream(id);
            this.update(null, id);
          }
        }
      },
    );
    this.engine.on("roomStateUpdate", (_room: string, state: string) => {
      if (state === "DISCONNECTED" && !this.disposed) this.disconnected();
    });
    const ok = await meetingDiagnosticStep("rtc.login", {}, () => this.engine.loginRoom(
      info.roomId,
      info.token,
      { userID: info.userId, userName: info.userName },
      { userUpdate: true },
    ));
    if (ok === false) throw new Error("音视频房间登录失败。");
    if (this.disposed) {
      this.engine.logoutRoom(info.roomId);
      return;
    }
    if (mic || camera) {
      await meetingDiagnosticStep("device.permission", { mic, camera }, () => ensureMeetingMediaPermissions(mic, camera));
      if (!this.disposed) await this.publish(mic, camera);
    }
  }
  private streamId(screen = false) {
    return `${this.joinInfo!.roomId}_${this.joinInfo!.userId}_${this.joinInfo!.sessionId}_${screen ? "screen" : "camera"}`;
  }
  private async publish(mic: boolean, camera: boolean) {
    if (this.disposed) return;
    let stream: MediaStream;
    try {
      stream = await meetingDiagnosticStep("device.create", { mic, camera }, () => this.engine.createStream({ camera: { audio: mic, video: camera } }) as Promise<MediaStream>);
    } catch (error) {
      throw new Error(meetingDeviceError(error, mic, camera));
    }
    if (this.disposed) {
      this.engine.destroyStream(stream);
      return;
    }
    meetingDiagnostic("rtc.publish.start", { id: this.streamId(), tracks: meetingTrackSnapshot(stream) });
    this.engine.muteMicrophone(!mic);
    if (this.engine.startPublishingStream(this.streamId(), stream) === false) {
      this.engine.destroyStream(stream);
      throw new Error("无法发布音视频。");
    }
    this.local = stream;
    this.diagnosticStreams.set("local", stream);
    this.cameraEnabled = camera;
    this.cameraCaptured = camera;
    this.microphoneCaptured = mic;
    this.update(
      { id: "local", userId: this.joinInfo!.userId, stream, screen: false },
      "local",
    );
  }
  async setDevices(mic: boolean, camera: boolean) {
    if (!this.engine || this.disposed) return;
    // Audio-only changes must preserve the stream, video track and rendered tile.
    if (this.local && camera === this.cameraEnabled) {
      const local = this.local;
      let track = local.getAudioTracks()[0];
      if (mic && (!this.microphoneCaptured || !track || track.readyState === "ended")) {
        let captured: MediaStream;
        try {
          captured = await meetingDiagnosticStep("device.getUserMedia", { mic: true, camera: false }, () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }));
        } catch (error) {
          throw new Error(meetingDeviceError(error, true, false));
        }
        const audio = captured.getAudioTracks()[0];
        if (this.disposed || this.local !== local) {
          captured.getTracks().forEach((t) => t.stop());
          return;
        }
        try {
          const result = this.microphoneCaptured && track
            ? await meetingDiagnosticStep("device.replaceTrack", { kind: "audio" }, () => this.engine.replaceTrack(local, audio) as Promise<any>)
            : await meetingDiagnosticStep("device.addTrack", { kind: "audio" }, () => this.engine.addTrack(local, audio) as Promise<any>);
          if (result?.errorCode) throw new Error("无法更新麦克风音轨");
          if (this.disposed) { audio.stop(); return; }
          track = audio;
          this.microphoneCaptured = true;
        } catch (error) {
          captured.getTracks().forEach((t) => t.stop());
          throw error;
        }
      }
      if (this.engine.muteMicrophone(!mic) === false)
        throw new Error("无法切换麦克风，请重试");
      if (track) track.enabled = mic;
      return;
    }
    if (this.local) {
      // Preserve microphone publication and the remote subscription when camera changes.
      const local = this.local;
      if (this.cameraCaptured) {
        const enabled = await meetingDiagnosticStep("device.enableVideoCaptureDevice", { kind: "camera" }, () => this.engine.enableVideoCaptureDevice(local, camera) as Promise<any>);
        if (enabled === false) throw new Error("摄像头切换失败，请重试");
      } else if (camera) {
        let captured: MediaStream;
        try { captured = await meetingDiagnosticStep("device.createCamera", {}, () => this.engine.createStream({ camera: { audio: false, video: true } }) as Promise<MediaStream>); }
        catch (error) { throw new Error(meetingDeviceError(error, false, true)); }
        if (this.disposed) { this.engine.destroyStream(captured); return; }
        this.cameraSource = captured;
        const video = captured.getVideoTracks()[0];
        try {
          const result = await meetingDiagnosticStep("device.addTrack", { kind: "video" }, () => this.engine.addTrack(local, video) as Promise<any>);
          if (result?.errorCode) throw new Error("无法开启摄像头");
          if (this.disposed) { this.engine.destroyStream(captured); return; }
        } catch (error) { this.engine.destroyStream(captured); this.cameraSource = undefined; throw error; }
      }
      this.cameraEnabled = camera;
      this.cameraCaptured = this.cameraCaptured || camera;
      return;
    }
    if (mic || camera) await this.publish(mic, camera);
  }

  renew(token: string) {
    meetingDiagnostic("rtc.renew", { disposed: this.disposed });
    if (this.joinInfo && !this.disposed)
      this.engine.renewToken(token, this.joinInfo.roomId);
  }
  async startShare(devices: MediaDevices = navigator.mediaDevices, prepareWindow?: (capture: MediaStream) => Promise<WindowComposition | undefined>) {
    if (this.share || this.shareStarting || this.disposed || !this.engine) return;
    const run = ++this.shareGeneration;
    this.shareStarting = true;
    try {
      let capture: MediaStream;
      try {
        // Call the requesting window immediately, while its user gesture is active.
        capture = await meetingDiagnosticStep("rtc.share.capture", {}, () => devices.getDisplayMedia({ video: true, audio: false }));
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === "AbortError") return;
        if (name === "NotAllowedError") {
          await handleScreenCaptureDenied();
          return;
        }
        if (name === "InvalidStateError")
          throw new Error("请返回会议窗口，再点击共享屏幕并选择共享内容。");
        if (name === "NotReadableError")
          throw new Error(/Mac/.test(navigator.userAgent)
            ? "系统未能启动屏幕采集。请检查 macOS「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中的当前应用权限（开发版为 Electron），更改后完全退出并重新打开应用；若已授权，请重新选择共享窗口。"
            : "系统未能启动屏幕采集。请确认所选窗口仍然可见，并重新选择共享内容。");
        throw new Error("无法读取共享画面，请重新选择屏幕或窗口后重试。");
      }
      if (this.disposed || run !== this.shareGeneration) {
        capture.getTracks().forEach(track => track.stop());
        return;
      }
      let composition: WindowComposition | undefined;
      // Keep the original capture independently owned, including while preparation is pending.
      this.shareCapture = capture;
      if (prepareWindow && capture.getVideoTracks()[0]?.getSettings().displaySurface === "window") {
        try { composition = await prepareWindow(capture); }
        catch (error) { meetingDiagnostic("rtc.share.composition.unavailable", meetingDiagnosticError(error)); }
      }
      if (this.disposed || run !== this.shareGeneration) {
        composition?.compositor.dispose();
        return;
      }
      this.windowComposition = composition;
      await this.publishShare(capture, run, "屏幕画面已采集", composition);
    } finally {
      if (run === this.shareGeneration) this.shareStarting = false;
    }
  }
  /** Publish an in-app video source (the meeting whiteboard) on the same `_screen` stream. */
  async startCustomShare(capture: MediaStream) {
    if (this.share || this.shareStarting || this.disposed || !this.engine) {
      capture.getTracks().forEach(track => track.stop());
      return;
    }
    const run = ++this.shareGeneration;
    this.shareStarting = true;
    try {
      await this.publishShare(capture, run, "白板画面已就绪");
    } finally {
      if (run === this.shareGeneration) this.shareStarting = false;
    }
  }
  getWindowShareCompositor(captureId: string) {
    return this.share && !this.cancelWindowPublication && this.windowComposition?.captureId === captureId ? this.windowComposition.compositor : undefined;
  }
  clearWindowShareOverlay(captureId: string) {
    const compositor = this.getWindowShareCompositor(captureId);
    if (!compositor) return false;
    compositor.setOverlay(null);
    return true;
  }
  private startWindowPublication(id: string, stream: MediaStream, run: number) {
    return new Promise<boolean>((resolve, reject) => {
      // ZEGO 3.12 queues callbacks for the listeners present when emitting. An
      // attempt-scoped listener rejects queued callbacks from previous attempts.
      // If ZEGO emits an old event *after* the same ID is reused, its payload
      // has no attempt ID with which to distinguish it from the current share.
      const onState = (event: { streamID: string; state: string; errorCode: number }) => {
        if (this.disposed || run !== this.shareGeneration || event?.streamID !== id) return;
        if (event.state === "PUBLISHING") resolve(true);
        else if (event.state === "NO_PUBLISH") reject({ errorCode: event.errorCode || undefined });
      };
      const timer = setTimeout(() => reject({ timedOut: true }), WINDOW_PUBLICATION_TIMEOUT_MS);
      this.cancelWindowPublication = () => {
        this.cancelWindowPublication = undefined;
        clearTimeout(timer);
        this.engine.off("publisherStateUpdate", onState);
        resolve(false);
      };
      this.engine.on("publisherStateUpdate", onState);
      if (this.engine.startPublishingStream(id, stream) === false) throw new Error("共享发布失败");
      // Own the accepted stream so stopShare can release it before confirmation.
      this.share = stream;
    });
  }
  private async publishShare(capture: MediaStream, run: number, capturedLabel: string, composition?: WindowComposition) {
    this.shareCapture = capture;
    let stream: MediaStream | undefined;
    let confirmation: Promise<boolean> | undefined;
    try {
      // ZEGO 3.12 rejects raw getDisplayMedia streams (1103044). Wrap the
      // child-window tracks in this renderer's realm, then register a custom
      // preview with the SDK before publishing. This does not recapture media.
      const output = composition?.compositor.stream ?? capture;
      const source = new MediaStream(output.getVideoTracks());
      stream = await meetingDiagnosticStep("rtc.share.register", {}, () => this.engine.createStream({
        custom: { source, videoOptimizationMode: "detail" },
      }) as Promise<MediaStream>);
      if (this.disposed || run !== this.shareGeneration || !capture.getVideoTracks().some(t => t.readyState === "live")) {
        this.clearShareCapture(capture, composition);
        this.releaseShare(stream, capture);
        return;
      }
      const id = this.streamId(true);
      confirmation = composition ? this.startWindowPublication(id, stream, run) : undefined;
      if (!confirmation) {
        if (this.engine.startPublishingStream(id, stream) === false) throw new Error("共享发布失败");
        this.share = stream;
      }
      const published = stream;
      for (const track of new Set([...capture.getVideoTracks(), ...output.getVideoTracks(), ...stream.getVideoTracks()]))
        track.addEventListener("ended", () => { if (this.share === published) this.stopShare(); }, { once: true });
      if (confirmation) {
        if (!await confirmation || this.disposed || run !== this.shareGeneration) return;
        this.cancelWindowPublication?.();
      }
      this.diagnosticStreams.set("share", stream);
      meetingDiagnostic("rtc.share.published", { tracks: meetingTrackSnapshot(stream) });
      this.update({ id: "share", userId: this.joinInfo!.userId, stream, screen: true }, "share");
    } catch (error) {
      // stopShare already released this attempt, even if a failure won the
      // promise race just before we stopped and is only now being handled.
      if (confirmation && run !== this.shareGeneration) return;
      if (confirmation && this.share === stream) {
        try { this.stopShare(); }
        catch (error) { meetingDiagnostic("rtc.share.stop.failed", meetingDiagnosticError(error)); }
      } else {
        if (run === this.shareGeneration) this.cancelWindowPublication?.();
        this.clearShareCapture(capture, composition);
        this.releaseShare(stream, capture);
      }
      const failure = error as { errorCode?: number; timedOut?: boolean } | null;
      const timedOut = failure?.timedOut === true;
      meetingDiagnostic("rtc.share.publish.failed", { ...meetingDiagnosticError(error), timedOut });
      const code = failure?.errorCode;
      const reason = timedOut ? "（等待发布确认超时）" : typeof code === "number" ? `（${code}）` : "";
      throw new Error(`${capturedLabel}，但共享发布失败${reason}，请重试。`);
    }
  }
  private clearShareCapture(capture: MediaStream, composition?: WindowComposition) {
    if (this.shareCapture === capture) this.shareCapture = undefined;
    if (composition && this.windowComposition === composition) {
      this.windowComposition = undefined;
      composition.compositor.dispose();
    }
  }
  private releaseShare(stream: MediaStream | undefined, capture: MediaStream | undefined) {
    capture?.getTracks().forEach(track => track.stop());
    if (!stream) return;
    try { this.engine.destroyStream(stream); }
    catch (error) { meetingDiagnostic("rtc.share.destroy.failed", meetingDiagnosticError(error)); }
    finally { stream.getTracks().forEach(track => track.stop()); }
  }
  stopShare() {
    this.shareGeneration++;
    this.shareStarting = false;
    const pending = !!this.cancelWindowPublication;
    this.cancelWindowPublication?.();
    const stream = this.share, capture = this.shareCapture;
    const composition = this.windowComposition;
    this.windowComposition = undefined;
    this.share = undefined;
    this.shareCapture = undefined;
    this.diagnosticStreams.delete("share");
    try { if (stream) this.engine.stopPublishingStream(this.streamId(true)); }
    finally {
      composition?.compositor.dispose();
      this.releaseShare(stream, capture);
      if (stream && !pending) this.update(null, "share");
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    meetingDiagnostic("rtc.dispose");
    clearInterval(this.diagnosticTimer);
    this.diagnosticStreams.clear();
    this.stopShare();
    if (this.local) {
      this.engine.stopPublishingStream(this.streamId());
      this.engine.destroyStream(this.local);
      this.local = undefined;
      this.microphoneCaptured = false;
    }
    if (this.cameraSource) {
      this.engine.destroyStream(this.cameraSource);
      this.cameraSource = undefined;
    }
    for (const id of this.remote) this.engine?.stopPlayingStream(id);
    this.remote.clear();
    if (this.joinInfo) this.engine?.logoutRoom(this.joinInfo.roomId);
    this.engine?.destroyEngine?.();
  }
}
