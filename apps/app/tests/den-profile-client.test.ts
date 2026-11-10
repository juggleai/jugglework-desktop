import { afterEach, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

test("profile updates persist through Den and return refreshed IM credentials", async () => {
  let request: { url: string; method: string; body: unknown } | null = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      request = {
        url: String(input),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body ?? "null")),
      };
      return Response.json({
        user: { id: "user_one", email: "alice@example.com", name: "Alice", avatar: "https://den.test/avatar" },
        im: { provider: "juggleim", websocketUrl: "wss://im.test", appKey: "app", imUserId: "user_one", token: "im_token" },
      });
    },
  });

  const result = await createDenClient({ baseUrl: "https://den.test", token: "session_token" }).updateProfile({
    name: " Alice ",
    avatarDataUrl: "data:image/png;base64,aW1hZ2U=",
  });

  expect(request).toEqual({
    url: "https://den.test/jwork/api/v1/me/profile",
    method: "PATCH",
    body: { name: "Alice", avatarDataUrl: "data:image/png;base64,aW1hZ2U=" },
  });
  expect(result.user).toMatchObject({ id: "user_one", name: "Alice", avatar: "https://den.test/avatar" });
  expect(result.im).toMatchObject({ imUserId: "user_one", token: "im_token" });
});
