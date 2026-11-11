import { expect, test } from "bun:test";
import { createProductViewPool } from "../src/react-app/domains/cloud-docs/product-view-pool";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("连续检索、链接校验、AI 共用同一次初始化，空闲后关闭", async () => {
  const created: string[] = [], closed: string[] = [];
  const pool = createProductViewPool({ idleMs: 15, create: async id => { created.push(id); }, close: async id => { closed.push(id); } });
  const ids = await Promise.all([pool.run("a", async id => id), pool.run("a", async id => id)]);
  expect(ids[0]).toBe(ids[1]);
  expect(await pool.run("a", async id => id)).toBe(ids[0]);
  expect(created).toHaveLength(1);
  await pause(30);
  expect(closed).toEqual([ids[0]]);
  await pool.run("a", async () => undefined);
  expect(created).toHaveLength(2);
  pool.clear();
});

test("请求未结束时不按空闲时间关闭，结束后再计时", async () => {
  const closed: string[] = [];
  let finish!: () => void;
  const pool = createProductViewPool({ idleMs: 10, create: async () => {}, close: async id => { closed.push(id); } });
  const run = pool.run("a", async () => new Promise<void>(resolve => { finish = resolve; }));
  await pause(20);
  expect(closed).toEqual([]);
  finish(); await run; await pause(20);
  expect(closed).toHaveLength(1);
});

test("切换来源范围立即取消等待，迟到的初始化不执行请求；新组织另开实例", async () => {
  let complete!: () => void;
  const closed: string[] = [], operations: string[] = [];
  const pool = createProductViewPool({ idleMs: 20, create: async (_id, key, active) => {
    if (key === "a") await new Promise<void>(resolve => { complete = resolve; });
    if (!active()) throw new Error("cancelled");
  }, close: async id => { closed.push(id); } });
  const old = pool.run("a", async () => { operations.push("a"); });
  pool.clear();
  await expect(old).rejects.toThrow("cloud_docs_scope_changed");
  complete();
  await pool.run("b", async () => { operations.push("b"); });
  expect(operations).toEqual(["b"]);
  expect(closed).toHaveLength(1);
  pool.clear();
});

test("初始化失败会清理实例，下次重试重新创建", async () => {
  let calls = 0;
  const pool = createProductViewPool({ idleMs: 10, create: async () => { if (++calls === 1) throw new Error("offline"); }, close: async () => {} });
  await expect(pool.run("a", async () => true)).rejects.toThrow();
  expect(await pool.run("a", async () => true)).toBe(true);
  expect(calls).toBe(2);
  pool.clear();
});
