export type MeetingPreferences = {
  meetingReminders: boolean; participantSounds: boolean; defaultMic: boolean; defaultCamera: boolean; mirrorPreview: boolean;
  microphoneId: string; cameraId: string; speakerId: string; outputVolume: number;
  shareQuality: "balanced" | "detail" | "motion";
};

const key = "jugglework.meeting.preferences.v1";
const changed = "jugglework:meeting-preferences-changed";
const defaults: MeetingPreferences = {
  meetingReminders: true, participantSounds: false, defaultMic: false, defaultCamera: false, mirrorPreview: true,
  microphoneId: "", cameraId: "", speakerId: "", outputVolume: 100, shareQuality: "balanced",
};

function normalize(input: Partial<MeetingPreferences> | null): MeetingPreferences {
  const p = { ...defaults };
  for (const k of ["meetingReminders", "participantSounds", "defaultMic", "defaultCamera", "mirrorPreview"] as const) {
    if (typeof input?.[k] === "boolean") p[k] = input[k];
  }
  for (const k of ["microphoneId", "cameraId", "speakerId"] as const) {
    if (typeof input?.[k] === "string") p[k] = input[k];
  }
  if (typeof input?.outputVolume === "number" && Number.isFinite(input.outputVolume)) p.outputVolume = Math.max(0, Math.min(100, Math.round(input.outputVolume)));
  if (input?.shareQuality === "motion" || input?.shareQuality === "detail") p.shareQuality = input.shareQuality;
  return p;
}

export function readMeetingPreferences(): MeetingPreferences {
  try { return normalize(JSON.parse(window.localStorage.getItem(key) ?? "null")); }
  catch { return { ...defaults }; }
}

export function updateMeetingPreferences(patch: Partial<MeetingPreferences>): void {
  window.localStorage.setItem(key, JSON.stringify(normalize({ ...readMeetingPreferences(), ...patch })));
  window.dispatchEvent(new Event(changed));
}

export function subscribeMeetingPreferences(update: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const storage = (e: StorageEvent) => { if (e.key === key || e.key === null) update(); };
  window.addEventListener(changed, update);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(changed, update); window.removeEventListener("storage", storage); };
}
