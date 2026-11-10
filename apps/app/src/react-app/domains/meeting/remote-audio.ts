import { meetingDiagnostic, meetingDiagnosticError } from "./diagnostics";
/** One audio sink per remote stream, independent of video tiles and window visibility. */
export function bindRemoteAudio(
  element: HTMLAudioElement,
  stream: MediaStream,
  blocked: (value: boolean) => void,
) {
  let disposed = false;
  let attempt = 0;
  const snapshot = () => ({ streamId: stream.id, paused: element.paused, muted: element.muted,
    volume: element.volume, readyState: element.readyState, currentTime: element.currentTime,
    errorCode: element.error?.code, tracks: stream.getAudioTracks().map(t => ({ id: t.id, enabled: t.enabled, muted: t.muted, state: t.readyState })) });
  const sample = setInterval(() => meetingDiagnostic("audio.sink", snapshot()), 5000);
  meetingDiagnostic("audio.bind", { streamId: stream.id });
  element.srcObject = stream;
  element.muted = false;
  element.volume = 1;
  const play = async () => {
    const current = ++attempt;
    if (disposed || !stream.getAudioTracks().some(t => t.readyState === "live")) return;
    try {
      await element.play();
      if (!disposed) meetingDiagnostic("audio.playing", snapshot());
      if (!disposed && current === attempt) blocked(false);
    } catch (error) {
      if (!disposed) meetingDiagnostic("audio.blocked", { ...snapshot(), ...meetingDiagnosticError(error) });
      if (!disposed && current === attempt) blocked(true);
    }
  };
  const changed = () => {
    if (!stream.getAudioTracks().some(t => t.readyState === "live")) {
      attempt++;
      blocked(false);
    } else void play();
  };
  stream.addEventListener("addtrack", changed);
  stream.addEventListener("removetrack", changed);
  void play();
  return {
    play,
    dispose() {
      disposed = true;
      clearInterval(sample);
      meetingDiagnostic("audio.unbind", { streamId: stream.id });
      attempt++;
      stream.removeEventListener("addtrack", changed);
      stream.removeEventListener("removetrack", changed);
      element.pause();
      element.srcObject = null;
      blocked(false);
    },
  };
}
