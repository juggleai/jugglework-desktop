import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JuggleWorkContextOverflow } from "./jugglework-context-overflow.js";

const originalFetch = globalThis.fetch;
let nextResponse = new Response("ok");
const fakeBase = Object.assign(async (): Promise<Response> => nextResponse, originalFetch);
let patchedFetch: typeof fetch;

beforeAll(async () => {
  globalThis.fetch = fakeBase;
  await JuggleWorkContextOverflow();
  patchedFetch = globalThis.fetch;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("JuggleWorkContextOverflow fetch patch", () => {
  test("normalizes a plain context overflow response", async () => {
    nextResponse = new Response("Your input exceeds the context window of this model.", {
      status: 400,
      statusText: "Bad Request",
      headers: { "x-request-id": "req_1" },
    });
    const response = await patchedFetch("https://provider.test/v1/chat/completions");
    expect(response.status).toBe(400);
    expect(response.statusText).toBe("Bad Request");
    expect(response.headers.get("x-request-id")).toBe("req_1");
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        code: "context_length_exceeded",
        type: "invalid_request_error",
        message: "Your input exceeds the context window of this model.",
      },
    });
  });

  test("leaves successful, structured, rate-limit, and oversized responses untouched", async () => {
    const values = [
      new Response("ok", { status: 200 }),
      new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }), { status: 400 }),
      new Response("Too many requests: rate limit exceeded", { status: 429 }),
      new Response("Prompt is too long", { status: 400, headers: { "content-length": "100000" } }),
    ];
    for (const value of values) {
      nextResponse = value;
      expect(await patchedFetch("https://provider.test/v1/chat/completions")).toBe(value);
    }
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./jugglework-context-overflow.js");
    expect(Object.keys(mod)).toEqual(["JuggleWorkContextOverflow"]);
  });
});
