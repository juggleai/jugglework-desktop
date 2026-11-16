import { expect, test } from "bun:test";

import { collectAllGroupMembers } from "../src/react-app/domains/jugglechat/api";

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
