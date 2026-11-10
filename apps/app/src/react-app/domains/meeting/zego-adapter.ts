import { ensureMeetingMediaPermissions, meetingDeviceError } from "./media-permission";
import type { MeetingJoin } from "./types";
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
  private disposed = false;
  private cameraEnabled = false;
  // ZEGO creates a live silent WebAudio track even when camera.audio is false.
  // Track presence alone does not mean that microphone capture was authorized.
  private microphoneCaptured = false;
  private remote = new Set<string>();
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
    this.engine.on(
      "roomStreamUpdate",
      (
        _room: string,
        type: string,
        streams: Array<{ streamID: string; user: { userID: string } }>,
      ) => {
        for (const stream of streams) {
          const id = stream.streamID;
          if (stream.user.userID === info.userId) continue;
          if (type === "ADD") {
            this.remote.add(id);
            void this.engine
              .startPlayingStream(id)
              .then((media: MediaStream) => {
                if (this.disposed || !this.remote.has(id)) {
                  media.getTracks().forEach((t) => t.stop());
                  return;
                }
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
          } else {
            this.remote.delete(id);
            this.engine.stopPlayingStream(id);
            this.update(null, id);
          }
        }
      },
    );
    this.engine.on("roomStateUpdate", (_room: string, state: string) => {
      if (state === "DISCONNECTED" && !this.disposed) this.disconnected();
    });
    const ok = await this.engine.loginRoom(
      info.roomId,
      info.token,
      { userID: info.userId, userName: info.userName },
      { userUpdate: true },
    );
    if (ok === false) throw new Error("音视频房间登录失败。");
    if (this.disposed) {
      this.engine.logoutRoom(info.roomId);
      return;
    }
    if (mic || camera) await this.publish(mic, camera);
  }
  private streamId(screen = false) {
    return `${this.joinInfo!.roomId}_${this.joinInfo!.userId}_${this.joinInfo!.sessionId}_${screen ? "screen" : "camera"}`;
  }
  private async publish(mic: boolean, camera: boolean) {
    await ensureMeetingMediaPermissions(mic, camera);
    if (this.disposed) return;
    let stream: MediaStream;
    try {
      stream = await this.engine.createStream({ camera: { audio: mic, video: camera } });
    } catch (error) {
      throw new Error(meetingDeviceError(error, mic, camera));
    }
    if (this.disposed) {
      this.engine.destroyStream(stream);
      return;
    }
    this.engine.muteMicrophone(!mic);
    if (this.engine.startPublishingStream(this.streamId(), stream) === false) {
      this.engine.destroyStream(stream);
      throw new Error("无法发布音视频。");
    }
    this.local = stream;
    this.cameraEnabled = camera;
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
        await ensureMeetingMediaPermissions(true, false);
        if (this.disposed) return;
        let captured: MediaStream;
        try {
          captured = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
            ? await this.engine.replaceTrack(local, audio)
            : await this.engine.addTrack(local, audio);
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
    // A camera change may recreate capture; a microphone change never does.
    if (this.local) {
      this.engine.stopPublishingStream(this.streamId());
      this.engine.destroyStream(this.local);
      this.local = undefined;
      this.microphoneCaptured = false;
      this.update(null, "local");
    }
    if (mic || camera) await this.publish(mic, camera);
  }
  renew(token: string) {
    if (this.joinInfo && !this.disposed)
      this.engine.renewToken(token, this.joinInfo.roomId);
  }
  async startShare(devices: MediaDevices = navigator.mediaDevices) {
    if (this.share || !this.engine) return;
    let stream: MediaStream;
    try {
      stream = await devices.getDisplayMedia({ video: true, audio: false });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "AbortError") return;
      if (name === "NotAllowedError") {
        throw new Error(/Mac/.test(navigator.userAgent)
          ? "未获得屏幕共享权限，或已取消选择。请在 macOS「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许当前应用（开发版为 Electron），完全退出并重新打开应用后重试。"
          : "未获得屏幕共享权限，或已取消选择。请允许屏幕录制并重新选择要共享的屏幕或窗口。");
      }
      if (name === "InvalidStateError")
        throw new Error("请返回会议窗口，再点击共享屏幕并选择共享内容。");
      throw new Error("无法读取共享画面，请检查屏幕录制权限后重试。");
    }
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    if (
      this.engine.startPublishingStream(this.streamId(true), stream) === false
    ) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("共享发布失败。");
    }
    this.share = stream;
    stream
      .getVideoTracks()[0]
      ?.addEventListener("ended", () => this.stopShare(), { once: true });
    this.update(
      { id: "share", userId: this.joinInfo!.userId, stream, screen: true },
      "share",
    );
  }
  stopShare() {
    if (!this.share) return;
    const stream = this.share;
    this.share = undefined;
    this.engine.stopPublishingStream(this.streamId(true));
    stream.getTracks().forEach((track) => track.stop());
    this.update(null, "share");
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
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
