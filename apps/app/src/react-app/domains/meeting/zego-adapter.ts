import { meetingDiagnostic, meetingDiagnosticError, meetingDiagnosticStep, meetingNumericMetrics, meetingTrackSnapshot } from "./diagnostics";
import { ensureMeetingMediaPermissions, handleScreenCaptureDenied, meetingDeviceError } from "./media-permission";
import { readMeetingPreferences } from "./meeting-preferences";
import type { MeetingJoin } from "./types";
import { createMeetingEffectTrack } from "./video-effects";
import { readMeetingVideoEffects, subscribeMeetingVideoEffects } from "./video-effects-preferences";

function wantsEffects({ background, avatar, filter, beauty }: ReturnType<typeof readMeetingVideoEffects>) {
  return background !== "none" || avatar !== "none" || filter !== "none" || beauty !== 0;
}
function cameraConfig(audio: boolean, video: boolean, { microphoneId, cameraId }: ReturnType<typeof readMeetingPreferences>) {
  return { audio, video, ...(audio && microphoneId ? { audioInput: microphoneId } : {}), ...(video && cameraId ? { videoInput: cameraId } : {}) };
}
const shareProfiles = {
  balanced: { width: 1920, height: 1080, frameRate: 24, hint: "" },
  detail: { width: 2560, height: 1440, frameRate: 15, hint: "detail" },
  motion: { width: 1920, height: 1080, frameRate: 30, hint: "motion" },
} as const;
const effectFailure = "摄像头特效未能发布，已停止输出摄像头画面。请重新开启摄像头。";
class CameraEffectError extends Error {}
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
  private shareStarting = false;
  private shareGeneration = 0;
  // Keep SDK-created source previews alive while their tracks are published.
  private cameraSource?: MediaStream;
  // Only this raw track may be offered to ZEGO. The compositor reads an
  // independent clone so we never have to unmute a previous sender.
  private rawCandidate?: MediaStreamTrack;
  private effectInput?: MediaStreamTrack;
  private effect?: Awaited<ReturnType<typeof createMeetingEffectTrack>>;
  private effectPreview?: MediaStream;
  private pendingLocal?: MediaStream;
  private unsubscribeEffects?: () => void;
  private preferences = readMeetingVideoEffects();
  private cameraWork: Promise<void> = Promise.resolve();
  private disposed = false;
  private cameraEnabled = false;
  // ZEGO creates a live silent WebAudio track even when camera.audio is false.
  // Track presence alone does not mean that microphone capture was authorized.
  private microphoneCaptured = false;
  private capturedMicrophoneId = "";
  private diagnosticTimer?: ReturnType<typeof setInterval>;
  private diagnosticStreams = new Map<string, MediaStream>();
  private remote = new Set<string>();
  private remoteEpoch = new Map<string, number>();
  constructor(
    private update: (tile: MediaTile | null, id: string) => void,
    private error: (message: string, cameraStopped?: boolean) => void,
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
    this.unsubscribeEffects = subscribeMeetingVideoEffects(() => {
      this.preferences = readMeetingVideoEffects();
      if (this.disposed || !this.rawCandidate || !wantsEffects(this.preferences)) return;
      // Synchronous, including while addTrack/replaceTrack is awaiting the SDK.
      this.rawCandidate.enabled = false;
      void this.queueCamera(async () => {
        if (this.cameraEnabled && this.local && this.rawCandidate)
          await this.installEffects(this.local, this.rawCandidate, "replaceTrack");
      }).catch(() => this.reportCameraStopped());
    });
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
      // A stopped canvas track does not dispatch 'ended' when its renderer
      // calls stop() (e.g. context loss). Never fall back to the raw camera.
      if (this.cameraEnabled && this.effect && this.effect.track.readyState === "ended") {
        this.releaseCamera();
        this.reportCameraStopped();
      }
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
      if (!this.disposed) await this.queueCamera(async () => {
        try { await this.publish(mic, camera); }
        catch (error) {
          if (!(error instanceof CameraEffectError)) throw error;
          if (this.disposed) return;
          // The failed camera publisher was never started. Join with the
          // requested microphone, without offering even a stopped raw track.
          if (mic) await this.publish(true, false);
          if (!this.disposed) this.error(effectFailure, true);
        }
      });
    }
  }
  private streamId(screen = false) {
    return `${this.joinInfo!.roomId}_${this.joinInfo!.userId}_${this.joinInfo!.sessionId}_${screen ? "screen" : "camera"}`;
  }
  private queueCamera(work: () => Promise<void>) {
    const next = this.cameraWork.then(() => this.disposed ? undefined : work());
    this.cameraWork = next.catch(() => {});
    return next;
  }
  private reportCameraStopped() {
    if (!this.cameraEnabled || this.disposed) return;
    this.cameraEnabled = false;
    this.error(effectFailure, true);
  }
  private destroyPreview(stream: MediaStream) {
    try { this.engine.destroyStream(stream); }
    catch (error) { meetingDiagnostic("device.destroy.failed", meetingDiagnosticError(error)); }
    finally { stream.getTracks().forEach(track => track.stop()); }
  }
  private releaseCamera() {
    this.rawCandidate?.stop();
    this.rawCandidate = undefined;
    this.effectInput?.stop();
    this.effectInput = undefined;
    this.effect?.stop();
    this.effect = undefined;
    if (this.effectPreview) this.destroyPreview(this.effectPreview);
    this.effectPreview = undefined;
    if (this.cameraSource) this.destroyPreview(this.cameraSource);
    this.cameraSource = undefined;
  }
  private async installEffects(local: MediaStream, raw: MediaStreamTrack, method: "addTrack" | "replaceTrack") {
    raw.enabled = false;
    const stalled = setTimeout(() => {
      if (!this.disposed && this.effectInput) this.error("摄像头特效切换超时，尚未确认发布。请关闭后重新开启摄像头。");
    }, 8000);
    try {
      const input = this.effectInput = raw.clone();
      input.enabled = true;
      raw.stop();
      this.rawCandidate = undefined;
      const effect = await createMeetingEffectTrack(input, () => this.preferences);
      if (this.effectInput !== input) { effect.stop(); return; }
      this.effect = effect;
      if (effect.track === input || effect.track === raw || effect.track.readyState !== "live") throw Error(effectFailure);
      // addTrack looks up videoInfo in the SDK preview list. Keep the
      // video-only custom preview alive for the lifetime of this camera.
      const preview: MediaStream = await this.engine.createStream({ custom: { source: new MediaStream([effect.track]) } });
      if (this.effectInput !== input) { this.destroyPreview(preview); return; }
      this.effectPreview = preview;
      const [track] = preview.getVideoTracks();
      if (!track || track.readyState !== "live" || track === raw || track === input) throw Error(effectFailure);
      const result = await this.engine[method](local, track);
      if (this.effectInput !== input) return;
      if (result?.errorCode !== 0 || local.getVideoTracks().length !== 1 || local.getVideoTracks()[0] !== track || !track.enabled || track.readyState !== "live")
        throw Error(effectFailure);
      if (this.local === local) this.update({ id: "local", userId: this.joinInfo!.userId, stream: local, screen: false }, "local");
    } catch (error) {
      raw.stop();
      this.releaseCamera();
      meetingDiagnostic("device.effects.failed", meetingDiagnosticError(error));
      throw new CameraEffectError(effectFailure);
    } finally { clearTimeout(stalled); }
  }
  private async publish(mic: boolean, camera: boolean) {
    if (this.disposed) return;
    let stream: MediaStream;
    const devices = readMeetingPreferences();
    try {
      stream = await meetingDiagnosticStep("device.create", { mic, camera }, () => this.engine.createStream({ camera: cameraConfig(mic, camera, devices) }) as Promise<MediaStream>);
    } catch (error) {
      throw new Error(meetingDeviceError(error, mic, camera));
    }
    if (this.disposed) {
      this.destroyPreview(stream);
      return;
    }
    this.pendingLocal = stream;
    try {
      if (camera) {
        const raw = this.rawCandidate = stream.getVideoTracks()[0];
        if (!raw) throw new Error("未获得摄像头画面");
        this.preferences = readMeetingVideoEffects();
        if (wantsEffects(this.preferences)) await this.installEffects(stream, raw, "replaceTrack");
      }
      if (this.disposed) return;
      meetingDiagnostic("rtc.publish.start", { id: this.streamId(), tracks: meetingTrackSnapshot(stream) });
      this.engine.muteMicrophone(!mic);
      if (this.engine.startPublishingStream(this.streamId(), stream) === false) throw new Error("无法发布音视频。");
    } catch (error) {
      this.releaseCamera();
      if (this.pendingLocal === stream) this.destroyPreview(stream);
      throw error;
    } finally { this.pendingLocal = undefined; }
    this.local = stream;
    this.diagnosticStreams.set("local", stream);
    this.cameraEnabled = camera;
    this.microphoneCaptured = mic;
    this.capturedMicrophoneId = mic ? devices.microphoneId : "";
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
      const microphoneId = mic ? readMeetingPreferences().microphoneId : "";
      if (mic && (!this.microphoneCaptured || !track || track.readyState === "ended")) {
        let captured: MediaStream;
        try {
          captured = await meetingDiagnosticStep("device.getUserMedia", { mic: true, camera: false }, () => navigator.mediaDevices.getUserMedia({ audio: microphoneId ? { deviceId: { exact: microphoneId } } : true, video: false }));
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
          this.capturedMicrophoneId = microphoneId;
        } catch (error) {
          captured.getTracks().forEach((t) => t.stop());
          throw error;
        }
      } else if (mic && microphoneId !== this.capturedMicrophoneId) {
        // The muted publisher still owns a real microphone. Let ZEGO retire
        // that input (which may be behind a WebAudio mix) without touching video.
        const result = await this.engine.useAudioDevice(local, microphoneId || "default");
        if (this.disposed) return;
        if (result?.errorCode !== 0) throw new Error("无法切换麦克风，请检查所选设备。");
        this.capturedMicrophoneId = microphoneId;
        track = local.getAudioTracks()[0];
      }
      if (this.engine.muteMicrophone(!mic) === false)
        throw new Error("无法切换麦克风，请重试");
      if (track) track.enabled = mic;
      return;
    }
    if (this.local && !camera) {
      // Never resume SDK camera capture on this publisher: it can install a
      // fresh raw track internally before giving the caller control again.
      this.cameraEnabled = false;
      this.local.getVideoTracks().forEach(track => track.stop());
      this.releaseCamera();
      return;
    }
    await this.queueCamera(async () => {
      const local = this.local;
      if (!local) { if (mic || camera) await this.publish(mic, camera); return; }
      let captured: MediaStream;
      try { captured = await meetingDiagnosticStep("device.createCamera", {}, () => this.engine.createStream({ camera: cameraConfig(false, true, readMeetingPreferences()) }) as Promise<MediaStream>); }
      catch (error) { throw new Error(meetingDeviceError(error, false, true)); }
      if (this.disposed) { this.destroyPreview(captured); return; }
      this.cameraSource = captured;
      try {
        const raw = this.rawCandidate = captured.getVideoTracks()[0];
        if (!raw) throw new Error("未获得摄像头画面");
        const method = local.getVideoTracks().length ? "replaceTrack" : "addTrack";
        this.preferences = readMeetingVideoEffects();
        if (wantsEffects(this.preferences)) await this.installEffects(local, raw, method);
        else {
          const result = await this.engine[method](local, raw);
          if (result?.errorCode !== 0) throw new Error("无法开启摄像头");
          if (!this.disposed && (!raw.enabled || wantsEffects(this.preferences))) await this.installEffects(local, raw, "replaceTrack");
        }
        if (!this.disposed) this.cameraEnabled = true;
      } catch (error) { this.releaseCamera(); throw error; }
    });
  }

  renew(token: string) {
    meetingDiagnostic("rtc.renew", { disposed: this.disposed });
    if (this.joinInfo && !this.disposed)
      this.engine.renewToken(token, this.joinInfo.roomId);
  }
  async startShare(devices: MediaDevices = navigator.mediaDevices) {
    if (this.share || this.shareStarting || this.disposed || !this.engine) return;
    const run = ++this.shareGeneration;
    this.shareStarting = true;
    try {
      let capture: MediaStream;
      const { width, height, frameRate, hint } = shareProfiles[readMeetingPreferences().shareQuality];
      try {
        // Call the requesting window immediately, while its user gesture is active.
        capture = await meetingDiagnosticStep("rtc.share.capture", {}, () => devices.getDisplayMedia({
          video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: frameRate, max: frameRate } }, audio: false,
        }));
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
      this.shareCapture = capture;
      let stream: MediaStream | undefined;
      try {
        // ZEGO 3.12 rejects raw getDisplayMedia streams (1103044). Wrap the
        // child-window tracks in this renderer's realm, then register a custom
        // preview with the SDK before publishing. This does not recapture media.
        const source = new MediaStream(capture.getVideoTracks());
        for (const track of source.getVideoTracks()) if ("contentHint" in track) track.contentHint = hint;
        stream = await meetingDiagnosticStep("rtc.share.register", {}, () => this.engine.createStream({
          custom: { source, videoOptimizationMode: hint || "default" },
        }) as Promise<MediaStream>);
        if (this.disposed || run !== this.shareGeneration || !capture.getVideoTracks().some(t => t.readyState === "live")) {
          if (this.shareCapture === capture) this.shareCapture = undefined;
          this.releaseShare(stream, capture);
          return;
        }
        if (this.engine.startPublishingStream(this.streamId(true), stream) === false)
          throw new Error("共享发布失败");
        this.share = stream;
        this.diagnosticStreams.set("share", stream);
        const published = stream;
        for (const track of new Set([...capture.getVideoTracks(), ...stream.getVideoTracks()]))
          track.addEventListener("ended", () => { if (this.share === published) this.stopShare(); }, { once: true });
        meetingDiagnostic("rtc.share.published", { tracks: meetingTrackSnapshot(stream) });
        this.update({ id: "share", userId: this.joinInfo!.userId, stream, screen: true }, "share");
      } catch (error) {
        if (this.shareCapture === capture) this.shareCapture = undefined;
        this.releaseShare(stream, capture);
        meetingDiagnostic("rtc.share.publish.failed", meetingDiagnosticError(error));
        const code = (error as { errorCode?: number })?.errorCode;
        throw new Error(`屏幕画面已采集，但共享发布失败${typeof code === "number" ? `（${code}）` : ""}，请重试。`);
      }
    } finally {
      if (run === this.shareGeneration) this.shareStarting = false;
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
    const stream = this.share, capture = this.shareCapture;
    this.share = undefined;
    this.shareCapture = undefined;
    this.diagnosticStreams.delete("share");
    try { if (stream) this.engine.stopPublishingStream(this.streamId(true)); }
    finally {
      this.releaseShare(stream, capture);
      if (stream) this.update(null, "share");
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeEffects?.();
    this.releaseCamera();
    if (this.pendingLocal) this.destroyPreview(this.pendingLocal);
    this.pendingLocal = undefined;
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
    for (const id of this.remote) this.engine?.stopPlayingStream(id);
    this.remote.clear();
    if (this.joinInfo) this.engine?.logoutRoom(this.joinInfo.roomId);
    this.engine?.destroyEngine?.();
  }
}
