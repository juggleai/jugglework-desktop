// @ts-ignore -- Bun executes colocated behavior tests; the app targets browser types.
import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createJuggleWorkServerClient } from "@/app/lib/jugglework-server";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
const input = { turnKey: "user-id", model: { providerID: "provider", modelID: "model" } };

test("client uses scoped endpoint, strict payload and existing client/host authentication", async () => {
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://remote.test/prefix/workspace/ws%2Fa/sessions/ses%2Fb/prompt-suggestions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-client");
    expect(new Headers(init?.headers).get("x-jugglework-host-token")).toBe("test-host");
    expect(JSON.parse(String(init?.body))).toEqual(input);
    return Response.json({ turnKey: input.turnKey, suggestion: "请补充测试" });
  }) as typeof fetch;
  const client = createJuggleWorkServerClient({ baseUrl: "https://remote.test/prefix/", token: "test-client", hostToken: "test-host" });
  expect(await client.getPromptSuggestion("ws/a", "ses/b", { ...input, extra: "discard" } as typeof input, { signal: new AbortController().signal }))
    .toEqual({ turnKey: input.turnKey, suggestion: "请补充测试" });
  expect(calls).toBe(1);
});

for (const status of [404, 501]) test(`${status} disables only this connection even for non-JSON legacy errors`, async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("legacy route missing", { status }); }) as typeof fetch;
  const client = createJuggleWorkServerClient({ baseUrl: "https://remote.test" });
  const options = { signal: new AbortController().signal };
  await expect(client.getPromptSuggestion("ws", "a", input, options)).rejects.toMatchObject({ status });
  expect(client.supportsPromptSuggestions()).toBe(false);
  await client.getPromptSuggestion("ws", "b", input, options);
  expect(calls).toBe(1);
  const reconnected = createJuggleWorkServerClient({ baseUrl: "https://remote.test" });
  expect(reconnected.supportsPromptSuggestions()).toBe(true);
});

test("desktop cancellation reaches native transport instead of renderer-only IPC rejection", async () => {
  let transportSignal!: AbortSignal;
  let aborted = false;
  const native = (async (_url: unknown, init?: RequestInit) => {
    transportSignal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => transportSignal.addEventListener("abort", () => {
      aborted = true; reject(new DOMException("aborted", "AbortError"));
    }, { once: true }));
  }) as typeof fetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    fetch: native,
    __JUGGLEWORK_ELECTRON__: { invokeDesktop: () => { throw new Error("IPC cannot cancel network I/O"); } },
  } });
  const client = createJuggleWorkServerClient({ baseUrl: "http://127.0.0.1:1234" });
  const controller = new AbortController();
  const pending = client.getPromptSuggestion("ws", "ses", input, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(aborted).toBe(true); expect(transportSignal.aborted).toBe(true);
});

test("real HTTP response-body reading rejects when caller aborts after headers", async () => {
  let headersReceived!: () => void;
  const received = new Promise<void>((resolve) => { headersReceived = resolve; });
  globalThis.fetch = (async (url, init) => {
    const response = await originalFetch(url, init);
    headersReceived();
    return response;
  }) as typeof fetch;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"turnKey":"user-id","suggestion":"');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createJuggleWorkServerClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const controller = new AbortController();
    const pending = client.getPromptSuggestion("ws", "ses", input, { signal: controller.signal });
    await received; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  } finally { server.closeAllConnections(); server.close(); }
});

test("mismatched turns and malformed/oversized/multiline responses never reach presentation", async () => {
  for (const response of [{ turnKey: "other", suggestion: "test" }, { turnKey: input.turnKey, suggestion: "a\nb" },
    { turnKey: input.turnKey, suggestion: "a".repeat(241) }, { turnKey: input.turnKey }, { turnKey: input.turnKey, suggestion: " " }]) {
    globalThis.fetch = (async () => Response.json(response)) as typeof fetch;
    const client = createJuggleWorkServerClient({ baseUrl: "https://remote.test" });
    await expect(client.getPromptSuggestion("ws", "ses", input, { signal: new AbortController().signal })).rejects.toThrow();
  }
});
