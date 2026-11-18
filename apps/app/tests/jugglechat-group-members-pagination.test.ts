import { expect, test } from "bun:test";

import { collectAllGroupMembers, juggleChatFetch } from "../src/react-app/domains/jugglechat/api";

test("routes desktop Chat API requests through Electron Main instead of renderer CORS", async () => {
  const previousWindow = globalThis.window;
  const calls: unknown[][] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __JUGGLEWORK_ELECTRON__: {
        invokeDesktop: async (...args: unknown[]) => {
          calls.push(args);
          return {
            status: 200,
            statusText: "OK",
            headers: [["content-type", "application/json"]],
            body: '{"members":[]}',
          };
        },
      },
    },
  });

  try {
    const response = await juggleChatFetch("https://work.example.test/jwork/api/v1/members", {
      headers: {
        Authorization: "Bearer session-token",
        "x-jugglework-legacy-org-id": "org-one",
      },
    });

    expect(response.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const [command, url, init] = calls[0] as [string, string, { headers: Record<string, string> }];
    expect(command).toBe("__fetch");
    expect(url).toBe("https://work.example.test/jwork/api/v1/members");
    expect(init.headers.authorization).toBe("Bearer session-token");
    expect(init.headers["x-jugglework-legacy-org-id"]).toBe("org-one");
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("collects every group-member page for complete-roster consumers", async () => {
  const offsets: string[] = [];
  const result = await collectAllGroupMembers(async (limit, offset) => {
    offsets.push(`${limit}:${offset}`);
    const start = Number(offset || 0);
    const items = Array.from({ length: Math.min(limit, 205 - start) }, (_, index) => ({
      user_id: `im-${start + index}`,
      identity_user_id: `user-${start + index}`,
    }));
    const next = start + items.length;
    return { code: 0, data: { items, members: items, offset: next < 205 ? String(next) : "", total: 205 } };
  });

  expect(offsets).toEqual(["100:", "100:100", "100:200"]);
  expect(result.data.items).toHaveLength(205);
  expect(result.data.items.at(-1)?.identity_user_id).toBe("user-204");
  expect(result.data.total).toBe(205);
  expect(result.data.offset).toBe("");
});

test("stops safely when a server repeats its pagination offset", async () => {
  let calls = 0;
  const result = await collectAllGroupMembers(async () => {
    calls += 1;
    return { code: 0, data: { items: [{ user_id: `im-${calls}` }], members: [], offset: "1", total: 10 } };
  });
  expect(calls).toBe(2);
  expect(result.data.items).toHaveLength(2);
});

test("deduplicates members repeated across pages", async () => {
  const result = await collectAllGroupMembers(async (_limit, offset) => {
    if (!offset) return { code: 0, data: { items: [
      { user_id: "im-a", identity_user_id: "user-a" },
      { user_id: "im-b", identity_user_id: "user-b" },
    ], members: [], offset: "2", total: 3 } };
    return { code: 0, data: { items: [
      { user_id: "im-b-new", identity_user_id: "user-b" },
      { user_id: "im-c", identity_user_id: "user-c" },
    ], members: [], offset: "", total: 3 } };
  });
  expect(result.data.items.map((member) => member.identity_user_id)).toEqual(["user-a", "user-b", "user-c"]);
  expect(result.data.total).toBe(3);
});
