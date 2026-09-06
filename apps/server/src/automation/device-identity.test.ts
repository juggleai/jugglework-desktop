import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { __resetAutomationDeviceIdCacheForTests, readAutomationDeviceId } from "./device-identity.js";
import type { ServerConfig } from "../types.js";

async function withTempConfig(fn: (config: ServerConfig) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-device-identity-"));
  __resetAutomationDeviceIdCacheForTests();
  try {
    await fn({ configPath: join(root, "config.yml") } as ServerConfig);
  } finally {
    __resetAutomationDeviceIdCacheForTests();
    await rm(root, { recursive: true, force: true });
  }
}

test("mints a fresh UUID-shaped deviceId on first read and persists it to disk", async () => {
  await withTempConfig(async (config) => {
    const deviceId = await readAutomationDeviceId(config);
    assert.match(deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const persisted = JSON.parse(await readFile(join(join(config.configPath as string, ".."), "automation-device-id.json"), "utf8")) as { deviceId?: string };
    assert.equal(persisted.deviceId, deviceId);
  });
});

test("repeated reads within the same process return the same id without touching disk again", async () => {
  await withTempConfig(async (config) => {
    const first = await readAutomationDeviceId(config);
    const second = await readAutomationDeviceId(config);
    assert.equal(first, second);
  });
});

test("a fresh process (no in-memory cache) reads back the id persisted by a prior one, instead of minting a new one", async () => {
  await withTempConfig(async (config) => {
    const first = await readAutomationDeviceId(config);
    __resetAutomationDeviceIdCacheForTests();
    const second = await readAutomationDeviceId(config);
    assert.equal(first, second);
  });
});
