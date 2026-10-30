import { expect, test } from "bun:test";
import { createSessionCreationLedger } from "../src/session-create-idempotency.js";
import { createSessionIntentTransport } from "../../app/src/app/lib/session-create-intent.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const key = () => `${Date.now()}.${crypto.randomUUID()}`;
const request = (workspace = "a", token = "one", body = "{}") => new Request(`http://runtime/w/${workspace}/opencode/session`, {
  method: "POST", headers: { Authorization: `Bearer ${token}` }, body,
});

test("client timeout then late server success: retry/concurrent same intent, next success new intent", async () => {
  const transport = createSessionIntentTransport();
  const ledger = createSessionCreationLedger();
  const engine = deferred<Response>();
  const admitted = deferred<void>();
  const retriesAdmitted = deferred<void>();
  const timeout = deferred<Response>();
  const keys: string[] = [];
  let posts = 0;
  let serverWork!: Promise<Response>;
  const send = async (req: Request) => {
    keys.push(req.headers.get("x-jugglework-create-intent")!);
    const work = ledger({ key: keys.at(-1)!, scope: req.url, payload: await req.text(), execute: () => {
      posts++; admitted.resolve(); return engine.promise;
    } });
    if (keys.length === 3) retriesAdmitted.resolve();
    if (keys.length === 1) { serverWork = work; return Promise.race([work, timeout.promise]); }
    return work;
  };
  const first = transport(request(), send);
  await admitted.promise;
  timeout.reject(new Error("fake client timeout"));
  await expect(first).rejects.toThrow("fake client timeout");
  const retry = transport(request(), send);
  const concurrent = transport(request(), send);
  await retriesAdmitted.promise;
  engine.resolve(Response.json({ id: "ses_late" }));
  expect(await (await retry).json()).toEqual({ id: "ses_late" });
  expect(await (await concurrent).json()).toEqual({ id: "ses_late" });
  await serverWork;
  expect(new Set(keys).size).toBe(1);
  expect(posts).toBe(1);
  await transport(request(), async (req) => { keys.push(req.headers.get("x-jugglework-create-intent")!); return Response.json({ id: "ses_new" }); });
  expect(keys.at(-1)).not.toBe(keys[0]);
});

test("independent workspace and credentials, unresolved payload changes blocked", async () => {
  const transport = createSessionIntentTransport();
  const seen: string[] = [];
  const fail = async (req: Request): Promise<Response> => { seen.push(req.headers.get("x-jugglework-create-intent")!); throw new Error("offline"); };
  for (const req of [request(), request("b"), request("a", "two"), request()]) await expect(transport(req, fail)).rejects.toThrow("offline");
  expect(new Set(seen.slice(0, 3)).size).toBe(3);
  expect(seen[3]).toBe(seen[0]);
  await expect(transport(request("a", "one", '{"title":"changed"}'), fail)).rejects.toThrow("original payload");
  expect(seen).toHaveLength(4);
});

test("ledger scopes, conflicts, definitive errors, unknown outcome, TTL and capacity", async () => {
  let now = Date.now();
  const ledger = createSessionCreationLedger({ now: () => now, capacity: 3 });
  let posts = 0;
  const input = { key: key(), scope: "workspace/account/permission", payload: "{}", execute: async () => { posts++; return Response.json({ id: "s" }); } };
  await ledger(input);
  await ledger(input);
  expect(posts).toBe(1);
  await expect(ledger({ ...input, payload: "different" })).rejects.toThrow("payload differs");
  await ledger({ ...input, scope: "other-workspace/account/permission" });
  await ledger({ ...input, scope: "workspace/other-account/permission" });
  expect(posts).toBe(3);
  await expect(ledger({ ...input, key: key() })).rejects.toThrow("full");
  now += 24 * 60 * 60 * 1000;
  await expect(ledger(input)).rejects.toThrow("expired");
  const failures = createSessionCreationLedger();
  const rejected = { ...input, key: key(), execute: async () => { posts++; return new Response(null, { status: 400 }); } };
  await failures(rejected); await failures(rejected);
  expect(posts).toBe(5);
  const unknown = { ...input, key: key(), execute: async (): Promise<Response> => { posts++; throw new Error("upstream disconnected after commit"); } };
  await expect(failures(unknown)).rejects.toThrow("unknown");
  await expect(failures(unknown)).rejects.toThrow("unknown");
  expect(posts).toBe(6);
});

test("pending admission survives fake ten-second timeout and cannot be evicted at capacity", async () => {
  let now = Date.now();
  const ledger = createSessionCreationLedger({ now: () => now, capacity: 1 });
  const gate = deferred<Response>();
  let posts = 0;
  const input = { key: key(), scope: "a", payload: "{}", execute: () => { posts++; return gate.promise; } };
  const first = ledger(input);
  now += 10_001;
  const retry = ledger(input);
  await expect(ledger({ ...input, key: key() })).rejects.toThrow("full");
  gate.resolve(Response.json({ id: "late" }));
  expect(await (await first).json()).toEqual({ id: "late" });
  expect(await (await retry).json()).toEqual({ id: "late" });
  expect(posts).toBe(1);
});
