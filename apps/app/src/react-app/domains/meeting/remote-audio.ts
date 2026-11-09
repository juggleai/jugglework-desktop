/** One audio sink per remote stream, independent of video tiles and window visibility. */
export function bindRemoteAudio(
  element: HTMLAudioElement,
  stream: MediaStream,
  blocked: (value: boolean) => void,
) {
  let disposed = false;
  let attempt = 0;
  element.srcObject = stream;
  element.muted = false;
  element.volume = 1;
  const play = async () => {
    const current = ++attempt;
    if (disposed || !stream.getAudioTracks().some(t => t.readyState === "live")) return;
    try {
      await element.play();
      if (!disposed && current === attempt) blocked(false);
    } catch {
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
      attempt++;
      stream.removeEventListener("addtrack", changed);
      stream.removeEventListener("removetrack", changed);
      element.pause();
      element.srcObject = null;
      blocked(false);
    },
  };
}
