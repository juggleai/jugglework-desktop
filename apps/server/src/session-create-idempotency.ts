import { createHash } from "node:crypto";
import { ApiError } from "./errors.js";

const TTL = 24 * 60 * 60 * 1000;
type Result = { status: number; headers: Headers; body: ArrayBuffer };
type Entry = { fingerprint: string; expires: number; pending?: Promise<Result>; result?: Result; unknown?: boolean };

/** Process-local ledger. Expired timestamped keys are rejected, never readmitted. */
export function createSessionCreationLedger(options: { now?: () => number; capacity?: number } = {}) {
  const entries = new Map<string, Entry>();
  const now = options.now ?? Date.now;
  return async (input: { key: string; scope: string; payload: string; execute: () => Promise<Response> }) => {
    const match = /^(\d{13})\.[0-9a-f-]{36}$/.exec(input.key);
    if (!match) throw new ApiError(400, "invalid_create_intent", "Invalid session creation intent");
    const timestamp = Number(match[1]);
    if (timestamp > now() + 60_000 || timestamp + TTL <= now()) throw new ApiError(409, "create_intent_expired", "Creation intent expired; reconcile the session list before creating again");
    const id = JSON.stringify([input.scope, input.key]);
    const fingerprint = createHash("sha256").update(input.payload).digest("hex");
    let entry = entries.get(id);
    if (entry && entry.fingerprint !== fingerprint) throw new ApiError(409, "create_intent_conflict", "Creation intent payload differs");
    if (!entry) {
      for (const [key, value] of entries) if (!value.pending && value.expires <= now()) entries.delete(key);
      if (entries.size >= (options.capacity ?? 1024)) throw new ApiError(503, "create_intent_capacity", "Session creation ledger is full");
      entry = { fingerprint, expires: timestamp + TTL };
      entries.set(id, entry);
    }
    if (entry.unknown) throw new ApiError(409, "create_outcome_unknown", "Creation outcome unknown; reconcile the session list before creating again");
    const current = entry;
    if (!current.result && !current.pending) {
      current.pending = Promise.resolve().then(input.execute).then(async (response) => {
        const result = { status: response.status, headers: new Headers(response.headers), body: await response.arrayBuffer() };
        if (response.ok) current.result = result;
        // Definitive rejections retain fingerprint only, never cache failures.
        else if (![400, 401, 403, 404, 422, 429].includes(response.status)) current.unknown = true;
        return result;
      }).catch(() => {
        current.unknown = true;
        throw new ApiError(409, "create_outcome_unknown", "Creation outcome unknown; reconcile the session list before creating again");
      }).finally(() => { current.pending = undefined; });
    }
    const result = current.result ?? await current.pending!;
    return new Response(result.body.slice(0), { status: result.status, headers: result.headers });
  };
}
