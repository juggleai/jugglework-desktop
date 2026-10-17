import type { ToonSessionVisibility } from "@jugglework/types/toon-assistant";

const MAX_TRANSIENT_SESSIONS = 10_000;
const sessions = new Map<string, ToonSessionVisibility>();

function key(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\0${sessionId}`;
}

export function registerToonFactoryTransientSession(workspaceId: string, sessionId: string): void {
  if (!sessionId) return;
  const registryKey = key(workspaceId, sessionId);
  sessions.delete(registryKey);
  sessions.set(registryKey, "toon_transient_generation");
  while (sessions.size > MAX_TRANSIENT_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (typeof oldest !== "string") break;
    sessions.delete(oldest);
  }
}

export function registerVisibleSession(workspaceId: string, sessionId: string): void {
  if (!sessionId || isRegisteredToonFactoryTransientSession(workspaceId, sessionId)) return;
  const registryKey = key(workspaceId, sessionId);
  sessions.delete(registryKey);
  sessions.set(registryKey, "normal");
  while (sessions.size > MAX_TRANSIENT_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (typeof oldest !== "string") break;
    sessions.delete(oldest);
  }
}

export function unregisterSession(workspaceId: string, sessionId: string): void {
  sessions.delete(key(workspaceId, sessionId));
}

export function clearWorkspaceSessionRegistry(workspaceId: string): void {
  const prefix = `${workspaceId}\0`;
  for (const registryKey of sessions.keys()) {
    if (registryKey.startsWith(prefix)) sessions.delete(registryKey);
  }
}

export function isRegisteredToonFactoryTransientSession(workspaceId: string, sessionId: string): boolean {
  return sessions.get(key(workspaceId, sessionId)) === "toon_transient_generation";
}

export function isRegisteredVisibleSession(workspaceId: string, sessionId: string): boolean {
  return sessions.get(key(workspaceId, sessionId)) === "normal";
}

export function registerToonProjectSession(workspaceId: string, sessionId: string, visibility: "toon_project_assistant" | "toon_project_subagent"): void {
  if (!sessionId) return;
  const registryKey = key(workspaceId, sessionId);
  sessions.delete(registryKey);
  sessions.set(registryKey, visibility);
}

export function registeredSessionVisibility(workspaceId: string, sessionId: string): ToonSessionVisibility | null {
  return sessions.get(key(workspaceId, sessionId)) ?? null;
}

export function isRegisteredHiddenToonSession(workspaceId: string, sessionId: string): boolean {
  const visibility = registeredSessionVisibility(workspaceId, sessionId);
  return visibility !== null && visibility !== "normal";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function sessionMetadataVisibility(value: unknown): ToonSessionVisibility {
  const session = record(value);
  const metadata = record(session?.metadata);
  if (metadata?.visibility === "normal") return "normal";
  if (!metadata || metadata.kind !== "toon-factory") return "normal";
  if (metadata.visibility === "toon_project_assistant" || metadata.surface === "project-assistant") return "toon_project_assistant";
  if (metadata.visibility === "toon_project_subagent" || metadata.surface === "project-subagent") return "toon_project_subagent";
  if (metadata.visibility === "toon_transient_generation" || metadata.transient === true) return "toon_transient_generation";
  // Unknown Toon metadata is hidden rather than promoted into ordinary chat.
  return "toon_transient_generation";
}

function explicitSessionMetadataVisibility(value: unknown): ToonSessionVisibility | null {
  const session = record(value);
  const metadata = record(session?.metadata);
  if (metadata?.visibility === "normal") return "normal";
  if (!metadata || metadata.kind !== "toon-factory") return null;
  return sessionMetadataVisibility(value);
}

export function sessionIsNormal(value: unknown): boolean {
  return sessionMetadataVisibility(value) === "normal";
}

export function classifySessionVisibilityFamily(
  values: unknown[],
  workspaceId?: string,
  failClosedMissingParent = false,
  readPersistent?: (sessionId: string) => ToonSessionVisibility | null,
): Map<string, ToonSessionVisibility> {
  const sessionsById = new Map<string, { value: unknown; parentId: string | null }>();
  for (const value of values) {
    const session = record(value);
    if (!session || typeof session.id !== "string" || !session.id) continue;
    sessionsById.set(session.id, { value, parentId: typeof session.parentID === "string" && session.parentID ? session.parentID : null });
  }
  const result = new Map<string, ToonSessionVisibility>();
  const resolving = new Set<string>();
  const resolveVisibility = (sessionId: string): ToonSessionVisibility => {
    const resolved = result.get(sessionId);
    if (resolved) return resolved;
    const candidate = sessionsById.get(sessionId);
    if (!candidate || resolving.has(sessionId)) {
      const registered = workspaceId ? registeredSessionVisibility(workspaceId, sessionId) : null;
      return readPersistent?.(sessionId)
        ?? (registered !== "normal" ? registered : null)
        ?? (failClosedMissingParent ? "toon_project_subagent" : "normal");
    }
    resolving.add(sessionId);
    const authoritative = readPersistent?.(sessionId);
    const registered = workspaceId ? registeredSessionVisibility(workspaceId, sessionId) : null;
    const own = authoritative
      ?? (registered !== "normal" ? registered : null)
      ?? explicitSessionMetadataVisibility(candidate.value)
      ?? registered
      ?? "normal";
    let visibility = own;
    if (own === "normal" && candidate.parentId) {
      const parent = readPersistent?.(candidate.parentId) ?? resolveVisibility(candidate.parentId);
      visibility = parent === "toon_project_assistant" || parent === "toon_project_subagent" ? "toon_project_subagent" : parent === "toon_transient_generation" ? "toon_transient_generation" : "normal";
    }
    resolving.delete(sessionId);
    result.set(sessionId, visibility);
    return visibility;
  };
  for (const sessionId of sessionsById.keys()) resolveVisibility(sessionId);
  return result;
}

export async function resolveSessionVisibility(
  workspaceId: string,
  value: unknown,
  readSession: (sessionId: string) => Promise<unknown | null>,
  readPersistent?: (sessionId: string) => ToonSessionVisibility | null,
): Promise<ToonSessionVisibility | "unknown"> {
  const seen = new Set<string>();
  let current: unknown = value;
  for (let depth = 0; depth < 64; depth += 1) {
    const session = record(current);
    const sessionId = typeof session?.id === "string" ? session.id : "";
    const parentId = typeof session?.parentID === "string" && session.parentID ? session.parentID : null;
    let ownVisibility: ToonSessionVisibility | null = null;
    if (sessionId) {
      if (seen.has(sessionId)) return "unknown";
      seen.add(sessionId);
      const registered = registeredSessionVisibility(workspaceId, sessionId);
      ownVisibility = readPersistent?.(sessionId)
        ?? (registered !== "normal" ? registered : null)
        ?? explicitSessionMetadataVisibility(current)
        ?? registered;
      if (ownVisibility && ownVisibility !== "normal") {
        if (depth === 0 || ownVisibility === "toon_transient_generation") return ownVisibility;
        return "toon_project_subagent";
      }
    }
    if (!parentId) return ownVisibility ?? explicitSessionMetadataVisibility(current) ?? "normal";
    const parentPersistent = readPersistent?.(parentId);
    if (parentPersistent === "toon_project_assistant" || parentPersistent === "toon_project_subagent") return "toon_project_subagent";
    if (parentPersistent === "toon_transient_generation") return "toon_transient_generation";
    if (parentPersistent === "normal") return "normal";
    const parentRegistered = registeredSessionVisibility(workspaceId, parentId);
    if (parentRegistered === "toon_project_assistant" || parentRegistered === "toon_project_subagent") return "toon_project_subagent";
    if (parentRegistered === "toon_transient_generation") return "toon_transient_generation";
    try {
      current = await readSession(parentId);
    } catch {
      return "unknown";
    }
    if (!current) return "unknown";
  }
  return "unknown";
}
