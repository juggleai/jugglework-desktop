import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createRemoteControlSettingsStore,
  disabledRemoteControlSettings,
  normalizeRemoteControlSettings,
} from "./remote-control-settings.mjs";

async function isolatedStore() {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-remote-settings-"));
  const filePath = path.join(root, "remote-control.json");
  return { filePath, store: createRemoteControlSettingsStore({ app: null, filePath }) };
}

test("remote-control settings normalize missing, malformed, and expanded values to disabled", () => {
  assert.deepEqual(normalizeRemoteControlSettings(undefined), disabledRemoteControlSettings);
  assert.deepEqual(normalizeRemoteControlSettings({ schemaVersion: 2, enabled: true }), disabledRemoteControlSettings);
  assert.deepEqual(normalizeRemoteControlSettings({
    ...disabledRemoteControlSettings,
    enabled: true,
    unknown: true,
  }), disabledRemoteControlSettings);
});

test("remote-control settings are disabled when missing or corrupt", async () => {
  const { filePath, store } = await isolatedStore();
  assert.deepEqual(await store.read(), disabledRemoteControlSettings);
  await writeFile(filePath, "not-json", "utf8");
  const reloaded = createRemoteControlSettingsStore({ app: null, filePath });
  assert.deepEqual(await reloaded.read(), disabledRemoteControlSettings);
});

test("legacy enabled settings migrate to prevent sleep while waiting", () => {
  assert.deepEqual(normalizeRemoteControlSettings({
    schemaVersion: 1,
    enabled: true,
    backgroundMode: true,
    launchAtLogin: false,
    allowBusySessionSteer: false,
    allowBusySessionEnqueue: false,
  }), {
    schemaVersion: 1,
    enabled: true,
    preventSleepWhileWaiting: true,
    backgroundMode: true,
    launchAtLogin: false,
    allowBusySessionSteer: false,
    allowBusySessionEnqueue: false,
  });
});

test("remote-control settings persist explicit local enablement atomically", async () => {
  const { filePath, store } = await isolatedStore();
  assert.deepEqual(await store.update({ enabled: true, backgroundMode: true }), {
    schemaVersion: 1,
    enabled: true,
    preventSleepWhileWaiting: true,
    backgroundMode: true,
    launchAtLogin: false,
    allowBusySessionSteer: false,
    allowBusySessionEnqueue: false,
  });
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), await store.read());
  assert.deepEqual(await store.disable(), disabledRemoteControlSettings);
});

test("busy-session policies are independent, explicit, and default false", async () => {
  const { store } = await isolatedStore();
  await store.update({ enabled: true, allowBusySessionSteer: true });
  assert.deepEqual(await store.read(), {
    schemaVersion: 1,
    enabled: true,
    preventSleepWhileWaiting: true,
    backgroundMode: false,
    launchAtLogin: false,
    allowBusySessionSteer: true,
    allowBusySessionEnqueue: false,
  });
  await store.update({ allowBusySessionEnqueue: true, allowBusySessionSteer: false });
  assert.equal((await store.read()).allowBusySessionSteer, false);
  assert.equal((await store.read()).allowBusySessionEnqueue, true);
  await store.update({ enabled: false });
  assert.deepEqual(await store.read(), disabledRemoteControlSettings);
});

test("failed settings writes fail closed in memory", async () => {
  const { filePath } = await isolatedStore();
  const store = createRemoteControlSettingsStore({
    app: null,
    filePath,
    fileSystem: {
      writeFile: async () => {
        throw new Error("disk unavailable");
      },
    },
  });
  await assert.rejects(store.update({ enabled: true }), /disk unavailable/);
  assert.deepEqual(await store.read(), disabledRemoteControlSettings);
  await assert.rejects(access(filePath));
});

test("concurrent reads and writes are serialized without transient re-enablement", async () => {
  const { filePath, store } = await isolatedStore();
  await store.update({ enabled: true });
  const [disabled, observed] = await Promise.all([
    store.disable(),
    store.read(),
  ]);
  assert.deepEqual(disabled, disabledRemoteControlSettings);
  assert.deepEqual(observed, disabledRemoteControlSettings);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), disabledRemoteControlSettings);
});

test("stop-all wins over an already-started update and leaves a durable disable marker", async () => {
  const { store } = await isolatedStore();
  await store.update({ enabled: true });
  const update = store.update({ backgroundMode: true });
  const disable = store.disable();
  await Promise.all([update, disable]);
  assert.deepEqual(await store.read(), disabledRemoteControlSettings);
  assert.equal(await readFile(store.disabledMarkerPath, "utf8"), "disabled\n");
});

test("unknown or non-boolean settings updates are rejected", async () => {
  const { store } = await isolatedStore();
  await assert.rejects(store.update({ enabled: /** @type {any} */ ("yes") }), /invalid/);
  await assert.rejects(store.update(/** @type {any} */ ({ enabled: true, unknown: true })), /invalid/);
  assert.deepEqual(await store.read(), disabledRemoteControlSettings);
});
