import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createRemoteControlCapabilityProfileStore,
  normalizeRemoteControlCapabilityProfile,
} from "./remote-control-capability-profile.mjs";

const RECORD = Object.freeze({
  schemaVersion: 1,
  controlPlaneBaseUrl: "https://work.example.test/jwork/api",
  appVersion: "1.2.40",
  policyVersion: "remote-v1-true-true-true",
  dropFeatures: ["session.prompt-variant"],
  dropOperations: [],
  acceptedAt: "2026-11-20T10:00:00.000Z",
});

async function isolatedStore() {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-remote-capability-"));
  const filePath = path.join(root, "capability-profile.json");
  return { root, filePath, store: createRemoteControlCapabilityProfileStore({ app: null, filePath }) };
}

test("capability profile normalizes a canonical record", () => {
  assert.deepEqual(normalizeRemoteControlCapabilityProfile(RECORD), RECORD);
});

test("capability profile rejects expanded, partial, and mistyped records", () => {
  assert.throws(() => normalizeRemoteControlCapabilityProfile({ ...RECORD, extra: true }), /missing or unknown/);
  assert.throws(() => normalizeRemoteControlCapabilityProfile({ ...RECORD, schemaVersion: 2 }), /schema version/);
  assert.throws(() => normalizeRemoteControlCapabilityProfile({ ...RECORD, dropFeatures: ["bad name"] }), /invalid identifier/);
  assert.throws(() => normalizeRemoteControlCapabilityProfile({ ...RECORD, dropFeatures: ["a", "a"] }), /invalid identifier/);
  assert.throws(() => normalizeRemoteControlCapabilityProfile({ ...RECORD, acceptedAt: "not-a-date" }), /RFC 3339/);
  assert.throws(() => normalizeRemoteControlCapabilityProfile({ ...RECORD, appVersion: " 1.2.40 " }), /appVersion/);
});

test("capability profile round-trips through the isolated file", async () => {
  const { root, filePath, store } = await isolatedStore();
  try {
    assert.equal(await store.read(), null);
    await store.write(RECORD);
    assert.deepEqual(await store.read(), RECORD);
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(persisted, RECORD);
    await store.clear();
    assert.equal(await store.read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capability profile reads a corrupt file as absent instead of throwing", async () => {
  const { root, filePath, store } = await isolatedStore();
  try {
    await writeFile(filePath, "not-json", "utf8");
    assert.equal(await store.read(), null);
    await writeFile(filePath, JSON.stringify({ ...RECORD, extra: true }), "utf8");
    assert.equal(await store.read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
