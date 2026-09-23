/** Per-session agent choices. An absent entry uses the engine's default agent. */
import { useSyncExternalStore } from "react";

export type SessionAgentChoices = Record<string, string>;

const STORAGE_PREFIX = "jugglework.sessionAgents";
const EMPTY_CHOICES: SessionAgentChoices = {};
const cache = new Map<string, SessionAgentChoices>();
const listeners = new Set<() => void>();

const storageKey = (workspaceId: string) => `${STORAGE_PREFIX}.${workspaceId}`;

function parseChoices(raw: string | null): SessionAgentChoices {
  if (!raw) return EMPTY_CHOICES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_CHOICES;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([sessionId, agent]) => {
        const name = typeof agent === "string" ? agent.trim() : "";
        return sessionId.trim() && name ? [[sessionId, name]] : [];
      }),
    );
  } catch {
    return EMPTY_CHOICES;
  }
}

function notifyListeners() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readSessionAgentChoices(workspaceId: string): SessionAgentChoices {
  const id = workspaceId.trim();
  if (!id || typeof window === "undefined") return EMPTY_CHOICES;
  const cached = cache.get(id);
  if (cached) return cached;
  let choices = EMPTY_CHOICES;
  try {
    choices = parseChoices(window.localStorage.getItem(storageKey(id)));
  } catch {
    // An unavailable localStorage must not block selecting the default agent.
  }
  cache.set(id, choices);
  return choices;
}

export function readSessionAgentChoice(workspaceId: string, sessionId: string | null): string | null {
  if (!sessionId?.trim()) return null;
  const choices = readSessionAgentChoices(workspaceId);
  return Object.prototype.hasOwnProperty.call(choices, sessionId) ? choices[sessionId] : null;
}

function writeChoices(workspaceId: string, choices: SessionAgentChoices): void {
  const id = workspaceId.trim();
  if (!id) return;
  cache.set(id, choices);
  if (typeof window !== "undefined") {
    try {
      if (Object.keys(choices).length > 0) {
        window.localStorage.setItem(storageKey(id), JSON.stringify(choices));
      } else {
        window.localStorage.removeItem(storageKey(id));
      }
    } catch {
      // Keep the in-memory selection usable if persistence is unavailable.
    }
  }
  notifyListeners();
}

export function setSessionAgentChoice(workspaceId: string, sessionId: string, agent: string | null): void {
  const id = sessionId.trim();
  if (!workspaceId.trim() || !id) return;
  const current = readSessionAgentChoices(workspaceId);
  const name = agent?.trim() ?? "";
  if (name && current[id] === name) return;
  if (!name && !Object.prototype.hasOwnProperty.call(current, id)) return;
  const next = { ...current };
  if (name) next[id] = name;
  else delete next[id];
  writeChoices(workspaceId, next);
}

/** Move the former global preference to the active session once, without replacing an explicit choice. */
export function migrateLegacyAgentChoice(workspaceId: string, sessionId: string, agent: string): void {
  if (!workspaceId.trim() || !sessionId.trim() || !agent.trim()) return;
  const choices = readSessionAgentChoices(workspaceId);
  if (Object.prototype.hasOwnProperty.call(choices, sessionId)) return;
  setSessionAgentChoice(workspaceId, sessionId, agent);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    const key = event.key;
    if (!key?.startsWith(`${STORAGE_PREFIX}.`)) return;
    cache.delete(key.slice(STORAGE_PREFIX.length + 1));
    notifyListeners();
  });
}

export function useSessionAgentChoices(workspaceId: string): SessionAgentChoices {
  return useSyncExternalStore(
    subscribe,
    () => readSessionAgentChoices(workspaceId),
    () => EMPTY_CHOICES,
  );
}
