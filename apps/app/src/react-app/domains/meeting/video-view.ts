/** A child-window muted video must never consume the stream's audio tracks.
 * The ZEGO/Electron cross-window path can propagate that child's mute to audio.
 */
export function bindMeetingVideo(element: HTMLVideoElement, source: MediaStream) {
  const view = new MediaStream();
  const watched = new Set<MediaStreamTrack>();
  let disposed = false;
  element.muted = true;
  element.srcObject = view;
  const sync = () => {
    if (disposed) return;
    const tracks = source.getVideoTracks().filter(track => track.readyState !== "ended");
    let changed = false;
    for (const track of view.getTracks()) {
      if (!tracks.includes(track)) { view.removeTrack(track); changed = true; }
    }
    for (const track of watched) {
      if (!tracks.includes(track)) { track.removeEventListener("ended", sync); watched.delete(track); }
    }
    for (const track of tracks) {
      if (!view.getTracks().includes(track)) { view.addTrack(track); changed = true; }
      if (!watched.has(track)) { watched.add(track); track.addEventListener("ended", sync); }
    }
    if (tracks.length && (changed || element.paused)) void element.play().catch(() => {});
  };
  source.addEventListener("addtrack", sync);
  source.addEventListener("removetrack", sync);
  sync();
  return {
    sync,
    dispose() {
      disposed = true;
      source.removeEventListener("addtrack", sync);
      source.removeEventListener("removetrack", sync);
      for (const track of watched) track.removeEventListener("ended", sync);
      watched.clear();
      // Detach the view only; these tracks still belong to the RTC publisher/player.
      element.pause();
      if (element.srcObject === view) element.srcObject = null;
      for (const track of view.getTracks()) view.removeTrack(track);
    },
  };
}
