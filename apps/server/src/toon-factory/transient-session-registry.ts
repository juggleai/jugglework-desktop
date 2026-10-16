const MAX_TRANSIENT_SESSIONS = 10_000;
const sessions = new Map<string, "transient" | "visible">();

function key(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\0${sessionId}`;
}

export function registerToonFactoryTransientSession(workspaceId: string, sessionId: string): void {
  if (!sessionId) return;
  const registryKey = key(workspaceId, sessionId);
  sessions.delete(registryKey);
  sessions.set(registryKey, "transient");
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
  sessions.set(registryKey, "visible");
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
  return sessions.get(key(workspaceId, sessionId)) === "transient";
}

export function isRegisteredVisibleSession(workspaceId: string, sessionId: string): boolean {
  return sessions.get(key(workspaceId, sessionId)) === "visible";
}
