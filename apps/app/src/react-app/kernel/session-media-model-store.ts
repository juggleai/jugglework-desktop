import { useSyncExternalStore } from "react";
import type { ModelRef } from "../../app/types";
import { SESSION_MEDIA_MODEL_PREF_KEY } from "../../app/constants";

export type SessionMediaModelChoices = Record<string, ModelRef>;
const EMPTY: SessionMediaModelChoices = {};
const cache = new Map<string, SessionMediaModelChoices>();
const listeners = new Set<() => void>();
const key = (workspaceId: string) => `${SESSION_MEDIA_MODEL_PREF_KEY}.${workspaceId}`;

function parse(raw: string | null): SessionMediaModelChoices {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
    return Object.fromEntries(Object.entries(value).flatMap(([sessionId, model]) => {
      if (!model || typeof model !== "object" || Array.isArray(model)) return [];
      const record = model as Record<string, unknown>;
      return typeof record.providerID === "string" && record.providerID.trim() && typeof record.modelID === "string" && record.modelID.trim()
        ? [[sessionId, { providerID: record.providerID.trim(), modelID: record.modelID.trim() }]] : [];
    }));
  } catch { return EMPTY; }
}

export function readSessionMediaModelChoices(workspaceId: string): SessionMediaModelChoices {
  if (!workspaceId || typeof window === "undefined") return EMPTY;
  const cached = cache.get(workspaceId); if (cached) return cached;
  const value = parse(window.localStorage.getItem(key(workspaceId))); cache.set(workspaceId, value); return value;
}
function write(workspaceId: string, choices: SessionMediaModelChoices) {
  cache.set(workspaceId, choices);
  if (Object.keys(choices).length) window.localStorage.setItem(key(workspaceId), JSON.stringify(choices)); else window.localStorage.removeItem(key(workspaceId));
  for (const listener of listeners) listener();
}
export function setSessionMediaModelChoice(workspaceId: string, sessionId: string, model: ModelRef) { if (workspaceId && sessionId) write(workspaceId, { ...readSessionMediaModelChoices(workspaceId), [sessionId]: model }); }
export function clearSessionMediaModelChoice(workspaceId: string, sessionId: string) { const next = { ...readSessionMediaModelChoices(workspaceId) }; delete next[sessionId]; write(workspaceId, next); }
export function resolveVideoModelPreference(input: { explicit?: ModelRef | null; session?: ModelRef | null; workspace?: ModelRef | null; global?: ModelRef | null; ready: ModelRef[] }): { model: ModelRef | null; fallbackFrom: ModelRef[] } {
  const candidates = [input.explicit, input.session, input.workspace, input.global].filter((model): model is ModelRef => Boolean(model));
  const ready = (model: ModelRef) => input.ready.some((item) => item.providerID === model.providerID && item.modelID === model.modelID);
  const selected = candidates.find(ready) ?? input.ready[0] ?? null;
  return { model: selected, fallbackFrom: candidates.filter((candidate) => !ready(candidate)) };
}
export function useSessionMediaModelChoices(workspaceId: string) { return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => readSessionMediaModelChoices(workspaceId), () => EMPTY); }
