/** Bounded local metadata only: never serialize SDK arguments, credentials or chat. */
const KEY = "jugglework.meeting.diagnostics.v1";
const LIMIT = 1200;
type Entry = { at: string; clock: number; endpoint: string; event: string; data: unknown };
const endpoint = globalThis.crypto.randomUUID();
let entries: Entry[] = [];
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || "[]");
  if (Array.isArray(saved)) entries = saved.slice(-LIMIT);
} catch { /* Storage may be unavailable. Keep recording in memory. */ }
let storageAvailable = true;
let sequence = 0;
export function meetingDiagnostic(event: string, data: unknown = {}) {
  entries.push({ at: new Date().toISOString(), clock: performance.now(), endpoint, event, data });
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
  try { localStorage.setItem(KEY, JSON.stringify(entries)); }
  catch { storageAvailable = false; }
}
export function meetingDiagnosticError(error: unknown) {
  // Error messages from providers can contain URLs/tokens. Only retain machine codes.
  const e = error as { name?: unknown; code?: unknown; errorCode?: unknown } | null;
  return { name: typeof e?.name === "string" ? e.name.slice(0, 80) : "Error",
    code: typeof e?.code === "number" ? e.code : undefined,
    errorCode: typeof e?.errorCode === "number" ? e.errorCode : undefined };
}
export function meetingTrackSnapshot(stream: MediaStream) {
  return stream.getTracks().map(t => {
    const s = t.getSettings?.() || {};
    return { id: t.id, kind: t.kind, enabled: t.enabled, muted: t.muted, state: t.readyState,
      sampleRate: s.sampleRate, channelCount: s.channelCount, echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl,
      width: s.width, height: s.height, frameRate: s.frameRate };
  });
}
// Quality objects vary by SDK version. Keep numeric/bool metrics, never arbitrary text.
export function meetingNumericMetrics(value: unknown, depth = 0): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/token|secret|password|authorization|deviceId|groupId|url|address|candidate|sdp/i.test(key)) continue;
    const safe = meetingNumericMetrics(item, depth + 1);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}
export async function meetingDiagnosticStep<T>(name: string, data: unknown, run: () => Promise<T>): Promise<T> {
  const operation = ++sequence;
  const start = performance.now();
  meetingDiagnostic(`${name}.start`, { operation, data });
  // Observe a stalled promise without pretending cancellation is supported by the SDK.
  const pending = setTimeout(() => meetingDiagnostic(`${name}.pending`, { operation, elapsedMs: performance.now() - start }), 8000);
  try {
    const result = await run();
    const code = (result as { errorCode?: unknown } | null)?.errorCode;
    meetingDiagnostic(`${name}.done`, { operation, elapsedMs: performance.now() - start,
      result: typeof result === "boolean" ? result : undefined, errorCode: typeof code === "number" ? code : undefined });
    return result;
  } catch (error) {
    meetingDiagnostic(`${name}.failed`, { operation, elapsedMs: performance.now() - start, ...meetingDiagnosticError(error) });
    throw error;
  } finally { clearTimeout(pending); }
}
export function meetingDiagnosticsJson() {
  return JSON.stringify({ format: 1, instrumentation: "meeting-trace-20261110-1", exportedAt: new Date().toISOString(),
    endpoint, userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    storageAvailable, note: "Metadata only; no audio, video, chat text or credentials. UTC timestamps plus monotonic clock per endpoint.", entries }, null, 2);
}
