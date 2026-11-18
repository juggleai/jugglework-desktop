import { meetingDiagnostic, meetingDiagnosticError } from "./diagnostics";
import { readMeetingPreferences, subscribeMeetingPreferences } from "./meeting-preferences";

// setSinkId is asynchronous; serialize per element, including across stream rebinds.
const pendingRoutes = new WeakMap<HTMLAudioElement, Promise<void>>();

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
  let requestedSpeaker: string | undefined;
  const applyOutput = () => {
    const { outputVolume, speakerId } = readMeetingPreferences();
    element.volume = outputVolume / 100;
    if (requestedSpeaker === speakerId || typeof element.setSinkId !== "function") return;
    requestedSpeaker = speakerId;
    const route = async () => {
      if (disposed || requestedSpeaker !== speakerId || element.sinkId === speakerId) return;
      try { await element.setSinkId(speakerId); } // Empty string restores system routing.
      catch (error) {
        if (!disposed && requestedSpeaker === speakerId) {
          requestedSpeaker = undefined;
          meetingDiagnostic("audio.route.failed", meetingDiagnosticError(error));
        }
      }
    };
    const pending = pendingRoutes.get(element);
    pendingRoutes.set(element, pending ? pending.then(route) : route());
  };
  applyOutput();
  const unsubscribe = subscribeMeetingPreferences(applyOutput);
  element.muted = false;
  element.srcObject = stream;
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
      unsubscribe();
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
