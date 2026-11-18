import { useEffect, useRef } from "react";
import type { Meeting } from "./types";

// Playback only. If autoplay is blocked, drop the cue rather than resuming or
// queuing audio that might play unexpectedly after the next user gesture.
function playCue(joined: boolean) {
  let audio: AudioContext | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const close = () => { clearTimeout(deadline); void audio?.close().catch(() => {}); };
  try {
    audio = new AudioContext();
    // New contexts can start asynchronously even when playback is allowed.
    // A suspended context never fires `ended`, so bound its lifetime as well.
    deadline = setTimeout(close, 250);
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    const now = audio.currentTime;
    tone.frequency.setValueAtTime(joined ? 440 : 660, now);
    tone.frequency.exponentialRampToValueAtTime(joined ? 660 : 440, now + 0.12);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.06, now + 0.015);
    gain.gain.linearRampToValueAtTime(0, now + 0.14);
    tone.connect(gain).connect(audio.destination);
    tone.onended = close;
    tone.start(now);
    tone.stop(now + 0.15);
  } catch { close(); }
}

/** Pass null until admission completes. Call once in the persistent room host. */
export function useParticipantSounds(meeting: Meeting | null, selfId: string, enabled: boolean) {
  const previous = useRef<{ scope: string; ids: Set<string>; lastCue: number } | null>(null);
  useEffect(() => {
    const self = meeting?.participants[selfId];
    if (!enabled || !meeting || !self) { previous.current = null; return; }
    const scope = JSON.stringify([meeting.organizationId, meeting.id, selfId, self.sessionId]);
    const ids = new Set(Object.keys(meeting.participants));
    const before = previous.current;
    if (before?.scope !== scope) { previous.current = { scope, ids, lastCue: -Infinity }; return; }
    const joined = [...ids].some(id => !before.ids.has(id));
    const changed = joined || ids.size !== before.ids.size;
    before.ids = ids;
    const now = performance.now();
    if (changed && now - before.lastCue >= 1000) {
      before.lastCue = now;
      playCue(joined);
    }
  }, [meeting, selfId, enabled]);
}
