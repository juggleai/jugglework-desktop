import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWindowDesktopContext } from "./file-window-desktop-context.mjs";

test("文件模式独立启动读取同部署普通策略，缓存不包含凭据，登出清除", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-context-"));
  try {
    let baseUrl = "https://cloud.example/jwork/api";
    const path = join(root, "context.json");
    const context = createFileWindowDesktopContext({ path, bootstrap: async () => ({ baseUrl, requireSignin: true }) });
    assert.equal(await context.read(null), null);
    const input = { baseUrl: "https://cloud.example", signedIn: true, userId: "u", organizationId: "org",
      config: { allowedModels: ["provider/model"], allowCustomProviders: false, clientToken: "must-not-persist" } };
    await context.sync(input);
    assert.deepEqual(await context.read(null), { allowedModels: ["provider/model"], allowCustomProviders: false });
    assert.ok(!(await readFile(path, "utf8")).includes("must-not-persist"));
    baseUrl = "https://other.example";
    assert.equal(await context.read(null), null);
    await assert.rejects(context.sync(input), /当前部署/);
    baseUrl = "https://cloud.example";
    await context.sync({ ...input, signedIn: false });
    assert.equal(await context.read(null), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("连续刷新后登出不被旧写入覆盖；损坏缓存不放宽策略", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-context-order-"));
  try {
    const path = join(root, "context.json");
    const context = createFileWindowDesktopContext({ path, bootstrap: async () => ({ baseUrl: "https://cloud.example", requireSignin: false }) });
    assert.deepEqual(await context.read(null), {});
    assert.deepEqual(await context.read({ isDestroyed: () => false, webContents: { isDestroyed: () => false, executeJavaScript: async () => null } }), {});
    const input = { baseUrl: "https://cloud.example", signedIn: true, userId: "u", organizationId: "org", config: {} };
    await Promise.all([context.sync(input), context.sync({ ...input, config: { allowCustomProviders: false } }), context.sync({ ...input, signedIn: false })]);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    await writeFile(path, "invalid-json");
    assert.equal(await context.read(null), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("首次独立启动自动初始化策略，初始化断网不覆盖已应用缓存", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-context-first-"));
  try {
    let offline = false;
    const input = { baseUrl: "https://cloud.example", signedIn: true, userId: "u", organizationId: "org", config: { allowCustomProviders: false } };
    const context = createFileWindowDesktopContext({ path: join(root, "context.json"), bootstrap: async () => ({ baseUrl: input.baseUrl, requireSignin: true }),
      initialize: async () => { if (offline) throw new Error("offline"); await context.sync(input); } });
    assert.deepEqual(await context.read(null), input.config);
    offline = true;
    assert.deepEqual(await context.read(null), input.config);
  } finally { await rm(root, { recursive: true, force: true }); }
});
