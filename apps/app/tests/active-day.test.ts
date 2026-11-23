import { expect, test } from "bun:test";
import { createActiveDayRecorder, listenForActiveDay } from "../src/app/lib/active-day";
import { createDenClient } from "../src/app/lib/den";

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) } as Storage;
}

test("only foreground trusted input triggers reporting; mount and unmount are inert", () => {
  let count = 0, focused = false;
  const listeners = new Map<string, (event: { isTrusted: boolean }) => void>();
  const doc = {
    visibilityState: "visible", hasFocus: () => focused,
    addEventListener: listeners.set.bind(listeners), removeEventListener: listeners.delete.bind(listeners),
  };
  const cleanup = listenForActiveDay(doc as unknown as Document, () => count++);
  expect([...listeners.keys()].sort()).toEqual(["keydown", "pointerdown"]);
  listeners.get("pointerdown")!({ isTrusted: true });
  focused = true;
  listeners.get("keydown")!({ isTrusted: false });
  doc.visibilityState = "hidden";
  listeners.get("keydown")!({ isTrusted: true });
  expect(count).toBe(0);
  doc.visibilityState = "visible";
  listeners.get("keydown")!({ isTrusted: true });
  listeners.get("pointerdown")!({ isTrusted: true });
  expect(count).toBe(2);
  cleanup();
  expect(listeners.size).toBe(0);
});

test("late A acknowledgement cannot mark B; receipts survive recreation and expire at UTC midnight", async () => {
  let now = Date.parse("2026-11-23T23:59:59.999Z");
  const clock = () => now, current = () => true, storage = memoryStorage();
  const record = createActiveDayRecorder(clock);
  let resolve!: () => void;
  const calls: string[] = [];
  const postB = async () => { calls.push("B"); };
  const a = record("A", () => { calls.push("A"); return new Promise<void>(r => { resolve = r; }); }, storage, current);
  await record("A", postB, storage, current);
  await record("B", postB, storage, () => false); // UI/session mismatch
  expect(calls).toEqual(["A"]);
  await record("B", postB, storage, current);
  resolve(); await a;
  const reopened = createActiveDayRecorder(clock);
  await reopened("B", postB, storage, current);
  await reopened("A", postB, storage, current);
  expect(calls).toEqual(["A", "B"]);
  now++;
  await reopened("B", postB, storage, current);
  expect(calls).toEqual(["A", "B", "B"]);
});

test("failures require fresh interaction after cooldown and stop after the third attempt", async () => {
  let now = 1, calls = 0;
  const record = createActiveDayRecorder(() => now), storage = memoryStorage();
  const input = () => record("account", async () => { calls++; throw Error(); }, storage, () => true);
  await input(); now += 29_999; await input(); expect(calls).toBe(1);
  now++; await input(); now += 59_999; await input(); expect(calls).toBe(2);
  now++; await input(); now += 3_600_000; await input(); expect(calls).toBe(3);
});

test("Den sends a bodyless scoped session POST over HTTP and rejects non-success", async () => {
  const received: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    received.push([request.method, request.url, request.headers.get("Authorization"), await request.text()]);
    return new Response(null, { status: received.length === 1 ? 204 : 503 });
  } });
  try {
    const baseUrl = server.url.origin;
    const client = createDenClient({ baseUrl, token: "test-session" });
    await client.recordActiveDay();
    await expect(client.recordActiveDay()).rejects.toThrow();
    expect(received[0]).toEqual(["POST", `${baseUrl}/jwork/api/v1/activity/active-day`, "Bearer test-session", ""]);
  } finally { server.stop(true); }
});

test("Desktop bridges the bearer POST without a body and does not revoke the session on a 401", async () => {
  const previousWindow = globalThis.window;
  const calls: unknown[][] = [];
  const events: Event[] = [];
  globalThis.window = {
    location: { origin: "http://127.0.0.1:5173" },
    dispatchEvent: (event: Event) => { events.push(event); return true; },
    __JUGGLEWORK_ELECTRON__: {
      invokeDesktop: async (...args: unknown[]) => {
        calls.push(args);
        return { status: 401, statusText: "Unauthorized", headers: [], body: '{"error":"invalid_session"}' };
      },
    },
  } as unknown as Window & typeof globalThis;
  try {
    const client = createDenClient({ baseUrl: "https://work.example", token: "test-session" });
    await expect(client.recordActiveDay()).rejects.toThrow("Active day request failed (401)");
    expect(calls).toEqual([["__fetch", "https://work.example/jwork/api/v1/activity/active-day", expect.objectContaining({
      method: "POST", headers: { accept: "application/json", authorization: "Bearer test-session" }, body: undefined, bodyBytes: undefined,
    })]]);
    expect(events).toEqual([]);
  } finally { globalThis.window = previousWindow; }
});
