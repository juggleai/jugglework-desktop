import { ensureMeetingMediaPermissions } from "./media-permission";
import { readMeetingPreferences } from "./meeting-preferences";
import { createMeetingEffectTrack } from "./video-effects";
import { readMeetingVideoEffects, subscribeMeetingVideoEffects } from "./video-effects-preferences";

/** Owns both capture and processed tracks. The element never receives the capture stream. */
export function startPrejoinPreview(element: HTMLVideoElement, mic: boolean, camera: boolean, onError: (cause: unknown) => void) {
  let stopped = false;
  let capture: MediaStream | undefined;
  let processor: Awaited<ReturnType<typeof createMeetingEffectTrack>> | undefined;
  let unsubscribe: (() => void) | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    element.srcObject = null;
    unsubscribe?.();
    processor?.stop();
    capture?.getTracks().forEach(track => track.stop());
  };
  async function start() {
    if (!mic && !camera) return;
    await ensureMeetingMediaPermissions(mic, camera);
    if (stopped) return;
    const { microphoneId, cameraId } = readMeetingPreferences();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: mic && (microphoneId ? { deviceId: { exact: microphoneId } } : true),
      video: camera && (cameraId ? { deviceId: { exact: cameraId } } : true),
    });
    if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
    capture = stream;
    if (!camera) return;
    const raw = stream.getVideoTracks()[0];
    if (!raw) throw new Error("摄像头没有返回视频画面。");
    let effects = readMeetingVideoEffects();
    unsubscribe = subscribeMeetingVideoEffects(() => { effects = readMeetingVideoEffects(); });
    const result = await createMeetingEffectTrack(raw, () => effects);
    if (stopped) { result.stop(); return; }
    processor = result;
    element.srcObject = new MediaStream([result.track]);
  }
  void start().catch(cause => {
    if (!stopped) { stop(); onError(cause); }
  });
  return stop;
}
