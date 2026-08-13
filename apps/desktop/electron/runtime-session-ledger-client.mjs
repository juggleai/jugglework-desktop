const MAX_PENDING_PER_SESSION = 1_000;

function access(value) {
  const baseUrl = String(value?.baseUrl ?? "").trim();
  const hostToken = String(value?.hostToken ?? "").trim();
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error("Runtime ledger is unavailable."); }
  if (!hostToken || !["http:", "https:"].includes(url.protocol)) throw new Error("Runtime ledger is unavailable.");
  return { baseUrl: url.toString().replace(/\/+$/, ""), hostToken };
}

export function createRuntimeSessionLedgerClient({ getAccess, fetcher = fetch }) {
  const known = new Set();
  const pending = new Map();
  const chains = new Map();

  async function request(method, path, body) {
    const current = access(await getAccess());
    const url = new URL(path, `${current.baseUrl}/`);
    if (url.origin !== new URL(current.baseUrl).origin) throw new Error("Runtime ledger path escaped its origin.");
    const response = await fetcher(url, {
      method, redirect: "manual", credentials: "omit", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-JuggleWork-Host-Token": current.hostToken },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Runtime ledger request failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  }

  function key(orgId, workspaceId, sessionId) { return `${orgId}\0${workspaceId}\0${sessionId}`; }
  function enqueue(sessionKey, action) {
    const next = (chains.get(sessionKey) ?? Promise.resolve()).then(action, action);
    const tracked = next.finally(() => { if (chains.get(sessionKey) === tracked) chains.delete(sessionKey); });
    chains.set(sessionKey, tracked);
    return next;
  }

  async function register(record) {
    const sessionKey = key(record.orgId, record.workspaceId, record.id);
    return enqueue(sessionKey, async () => {
      await request("PUT", `/workspace/${encodeURIComponent(record.workspaceId)}/runtime-session/${encodeURIComponent(record.id)}`, { record });
      known.add(sessionKey);
      const buffered = pending.get(sessionKey) ?? [];
      pending.delete(sessionKey);
      for (const event of buffered) await appendNow(event);
    });
  }

  async function bind(thread) {
    const sessionKey = key(thread.orgId, thread.workspaceId, thread.sessionId);
    return enqueue(sessionKey, async () => {
      await request("POST", `/workspace/${encodeURIComponent(thread.workspaceId)}/runtime-session/${encodeURIComponent(thread.sessionId)}/backend-thread`, {
        orgId: thread.orgId, runtimeKind: thread.runtimeKind, backendThreadId: thread.backendThreadId,
      });
      known.add(sessionKey);
      const buffered = pending.get(sessionKey) ?? [];
      pending.delete(sessionKey);
      for (const event of buffered) await appendNow(event);
    });
  }

  async function appendNow(event) {
    if (!("sessionId" in event)) return;
    await request("POST", `/workspace/${encodeURIComponent(event.workspaceId)}/runtime-session/${encodeURIComponent(event.sessionId)}/event`, {
      orgId: event.orgId, backendEventId: event.eventId, event,
    });
  }

  function accept(event) {
    if (!("sessionId" in event)) return Promise.resolve();
    const sessionKey = key(event.orgId, event.workspaceId, event.sessionId);
    if (!known.has(sessionKey)) {
      const values = pending.get(sessionKey) ?? [];
      values.push(event);
      if (values.length > MAX_PENDING_PER_SESSION) values.shift();
      pending.set(sessionKey, values);
      return Promise.resolve();
    }
    return enqueue(sessionKey, () => appendNow(event));
  }

  function archive(input) {
    const sessionKey = key(input.orgId, input.workspaceId, input.sessionId);
    return enqueue(sessionKey, async () => {
      await request("POST", `/workspace/${encodeURIComponent(input.workspaceId)}/runtime-session/${encodeURIComponent(input.sessionId)}/archive`, {
        orgId: input.orgId, archived: input.archived !== false,
      });
      if (input.archived !== false) known.delete(sessionKey);
    });
  }

  async function list(input) {
    return request("POST", `/workspace/${encodeURIComponent(input.workspaceId)}/runtime-sessions/query`, {
      orgId: input.orgId, search: input.search ?? "", includeArchived: input.includeArchived === true, limit: input.limit ?? 100,
    });
  }

  async function snapshot(input) {
    return request("POST", `/workspace/${encodeURIComponent(input.workspaceId)}/runtime-session/${encodeURIComponent(input.sessionId)}/snapshot`, {
      orgId: input.orgId,
    });
  }

  return Object.freeze({ register, bind, archive, list, snapshot, accept });
}
