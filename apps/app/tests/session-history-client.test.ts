import { afterEach, describe, expect, test } from "bun:test";

import { createJuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import { createClient } from "../src/app/lib/opencode";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("session history clients", () => {
  test("server client sends an opaque before cursor and forwards cancellation", async () => {
    let request: Request | undefined;
    let complete!: () => void;
    globalThis.fetch = ((input, init) => {
      request = input instanceof Request ? input : new Request(input, init);
      return new Promise<Response>((resolve, reject) => {
        complete = () => resolve(Response.json({ items: [], page: { olderCursor: null, hasOlder: false } }));
        request!.signal.addEventListener("abort", () => reject(request!.signal.reason), { once: true });
      });
    }) as typeof fetch;
    const controller = new AbortController();

    const pending = createJuggleWorkServerClient({ baseUrl: "https://worker.example.test" })
      .getSessionMessages("workspace", "session", { limit: 100, before: "opaque+/cursor==", signal: controller.signal });

    expect(new URL(request!.url).searchParams.get("before")).toBe("opaque+/cursor==");
    expect(new URL(request!.url).searchParams.get("limit")).toBe("100");
    controller.abort();
    expect(request!.signal.aborted).toBe(true);
    await expect(pending).rejects.toBeDefined();
    complete();
  });

  test("mounted OpenCode adapter preserves before and X-Next-Cursor metadata", async () => {
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      expect(url.pathname).toBe("/workspace/workspace-1/sessions/session-1/messages");
      expect(url.searchParams.get("before")).toBe("opaque cursor");
      expect(url.searchParams.get("limit")).toBe("100");
      return Response.json({ items: [], page: { olderCursor: "next cursor", hasOlder: true } });
    }) as typeof fetch;
    const client = createClient("https://worker.example.test/workspace/workspace-1/opencode", undefined, {
      mode: "jugglework",
      token: "renderer-token",
    });

    const result = await client.session.messages({ sessionID: "session-1", limit: 100, before: "opaque cursor" } as never);

    expect(result.data).toEqual([]);
    expect(result.response.headers.get("X-Next-Cursor")).toBe("next cursor");
  });

});
