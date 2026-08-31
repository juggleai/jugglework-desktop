export interface SessionAncestryRecord {
  id: string;
  parentId: string | null;
  valid: boolean;
}

export interface SessionAncestry {
  has(sessionId: string): boolean;
  parentOf(sessionId: string): string | null;
  rootOf(sessionId: string): string | null;
  pathOf(sessionId: string): string[] | null;
  descendantsOf(rootSessionId: string): string[];
}

export function buildSessionAncestry(records: SessionAncestryRecord[]): SessionAncestry {
  const sessions = new Map<string, SessionAncestryRecord>();
  for (const record of records) {
    const existing = sessions.get(record.id);
    sessions.set(record.id, existing ? { ...record, valid: false } : record);
  }

  const roots = new Map<string, string | null>();

  function rootOf(sessionId: string): string | null {
    if (roots.has(sessionId)) return roots.get(sessionId) ?? null;

    const path: string[] = [];
    const seen = new Set<string>();
    let currentId = sessionId;
    let root: string | null = null;

    while (true) {
      const cached = roots.get(currentId);
      if (cached !== undefined || roots.has(currentId)) {
        root = cached ?? null;
        break;
      }
      const current = sessions.get(currentId);
      if (!current?.valid || seen.has(currentId)) break;
      seen.add(currentId);
      path.push(currentId);
      if (current.parentId === null) {
        root = currentId;
        break;
      }
      currentId = current.parentId;
    }

    for (const id of path) roots.set(id, root);
    return root;
  }

  return Object.freeze({
    has: (sessionId: string) => sessions.has(sessionId),
    parentOf: (sessionId: string) => sessions.get(sessionId)?.parentId ?? null,
    rootOf,
    pathOf: (sessionId: string) => {
      const root = rootOf(sessionId);
      if (!root) return null;
      const path: string[] = [];
      let currentId = sessionId;
      while (true) {
        path.push(currentId);
        if (currentId === root) return path.reverse();
        const parentId = sessions.get(currentId)?.parentId;
        if (!parentId) return null;
        currentId = parentId;
      }
    },
    descendantsOf: (rootSessionId: string) => {
      if (rootOf(rootSessionId) !== rootSessionId) return [];
      return [...sessions.keys()].filter((sessionId) => rootOf(sessionId) === rootSessionId);
    },
  });
}
