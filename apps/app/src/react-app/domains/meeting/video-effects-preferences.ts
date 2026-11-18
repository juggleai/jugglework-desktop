import type { MeetingVideoEffects } from "./video-effects";
import { isMeetingAvatar } from "./meeting-avatar-catalog";
import { MEETING_BACKGROUND_PRESETS } from "./meeting-background-catalog";

// Device preferences only: no images, account identifiers, or captured frames.
const key = "jugglework.meeting.video-effects.v1";
const changed = "jugglework:meeting-video-effects";
const defaults: MeetingVideoEffects = { background: "none", avatar: "none", filter: "none", beauty: 0 };
let volatile: MeetingVideoEffects = defaults;

function normalizeBackground(id: unknown): MeetingVideoEffects["background"] {
  if (id === "sky" || id === "studio" || id === "blur") return id;
  if (typeof id !== "string") return "none";
  if (id.startsWith("scene-") && MEETING_BACKGROUND_PRESETS.some(p => p.id === id)) return id as `scene-${string}`;
  // Keep only an opaque local identifier, never a URL, path or image payload.
  if (/^custom-[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) return id as `custom-${string}`;
  return "none";
}

function normalize(input: Partial<MeetingVideoEffects> | null): MeetingVideoEffects {
  return {
    background: normalizeBackground(input?.background),
    avatar: isMeetingAvatar(input?.avatar) ? input.avatar : "none",
    filter: input?.filter === "warm" || input?.filter === "cool" || input?.filter === "mono" ? input.filter : "none",
    beauty: typeof input?.beauty === "number" && Number.isFinite(input.beauty) ? Math.max(0, Math.min(100, Math.round(input.beauty))) : 0,
  };
}

export function readMeetingVideoEffects(): MeetingVideoEffects {
  try {
    const serialized = window.localStorage.getItem(key);
    return serialized === null ? { ...defaults } : normalize(JSON.parse(serialized));
  } catch { return { ...volatile }; }
}

export function writeMeetingVideoEffects(value: MeetingVideoEffects): void {
  const prefs = normalize(value);
  // Do not report a privacy effect as applied if another window cannot read it.
  window.localStorage.setItem(key, JSON.stringify(prefs));
  volatile = prefs;
  window.dispatchEvent(new Event(changed));
}

export function subscribeMeetingVideoEffects(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const otherWindow = (event: StorageEvent) => { if (event.key === key || event.key === null) callback(); };
  window.addEventListener(changed, callback);
  window.addEventListener("storage", otherWindow);
  return () => { window.removeEventListener(changed, callback); window.removeEventListener("storage", otherWindow); };
}
