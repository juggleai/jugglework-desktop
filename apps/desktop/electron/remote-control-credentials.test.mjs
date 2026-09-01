import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRemoteControlCredentialStore,
  normalizeRemoteControlCredentialContext,
  RemoteControlCredentialError,
} from "./remote-control-credentials.mjs";

const CONTEXT = Object.freeze({
  controlPlaneBaseUrl: "https://cloud.example.test/",
  userId: "user_1",
  organizationId: "org_1",
});
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-09T12:00:00.000Z";

function secureStorage(backend = "keyring") {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => {
      const text = Buffer.from(value).toString("utf8");
      if (!text.startsWith("protected:")) throw new Error("unprotected value");
      return text.slice("protected:".length);
    },
  };
}

async function isolatedStore(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-remote-credentials-"));
  const filePath = path.join(root, "credentials.json");
  return {
    filePath,
    store: createRemoteControlCredentialStore({
      filePath,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => new Date(NOW),
      ...options,
    }),
  };
}

async function pendingAndBinding(store) {
  const pending = await store.prepareEnrollment(CONTEXT);
  const binding = {
    deviceId: DEVICE_ID,
    keyId: KEY_ID,
    publicKeyFingerprint: pending.publicKeyFingerprint,
    enrolledAt: NOW,
  };
  return { pending, binding };
}

test("normalizes credential binding to the canonical API control plane", () => {
  for (const base of [
    "https://cloud.example.test",
    "https://cloud.example.test/jwork/",
    "https://cloud.example.test/jwork/api",
  ]) {
    assert.deepEqual(normalizeRemoteControlCredentialContext({ ...CONTEXT, controlPlaneBaseUrl: base }), {
      ...CONTEXT,
      controlPlaneBaseUrl: "https://cloud.example.test/jwork/api",
    });
  }
  assert.equal(
    normalizeRemoteControlCredentialContext({ ...CONTEXT, controlPlaneBaseUrl: "https://cloud.example.test/api/den/" }).controlPlaneBaseUrl,
    "https://cloud.example.test/api/den",
  );
});

test("persists a pending Ed25519 key before final enrollment without plaintext secrets", async () => {
  const { filePath, store } = await isolatedStore();
  const pending = await store.prepareEnrollment(CONTEXT);
  assert.equal(pending.state, "pending");
  assert.equal(Buffer.from(pending.publicKey, "base64url").length, 32);
  assert.match(pending.publicKeyFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(pending.context, {
    ...CONTEXT,
    controlPlaneBaseUrl: "https://cloud.example.test/jwork/api",
  });

  const raw = await readFile(filePath, "utf8");
  const persisted = JSON.parse(raw);
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.state, "pending");
  assert.equal(Object.hasOwn(persisted, "grant"), false);
  assert.equal(Object.hasOwn(persisted, "accessToken"), false);
  assert.equal(Object.hasOwn(persisted, "privateKey"), false);
  assert.ok(Buffer.from(persisted.encryptedPrivateKey, "base64").toString().startsWith("protected:"));
  assert.equal(raw.includes("BEGIN PRIVATE KEY"), false);
});

test("finalizes the exact device, key, and fingerprint binding and supports deletion", async () => {
  const { filePath, store } = await isolatedStore();
  const { pending, binding } = await pendingAndBinding(store);
  const enrolled = await store.completeEnrollment(CONTEXT, binding);
  assert.deepEqual(enrolled, {
    ...pending,
    state: "enrolled",
    deviceId: DEVICE_ID,
    keyId: KEY_ID,
    enrolledAt: NOW,
  });

  const signing = await store.getSigningCredential(CONTEXT);
  assert.equal(signing.deviceId, DEVICE_ID);
  assert.equal(signing.keyId, KEY_ID);
  assert.equal(signing.privateKey.type, "private");
  assert.equal(signing.privateKey.asymmetricKeyType, "ed25519");
  await store.delete();
  assert.equal(await store.read(CONTEXT), null);
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
});

test("rejects unavailable and degraded platform encryption before generating or reading keys", async () => {
  for (const options of [
    { platform: "darwin", safeStorage: { isEncryptionAvailable: () => false } },
    { platform: "linux", safeStorage: secureStorage("basic_text") },
    { platform: "linux", safeStorage: secureStorage("unknown") },
    {
      platform: "linux",
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.from("x"),
        decryptString: () => "x",
      },
    },
  ]) {
    const { store } = await isolatedStore(options);
    await assert.rejects(store.prepareEnrollment(CONTEXT), (error) => {
      assert.ok(error instanceof RemoteControlCredentialError);
      assert.ok(["secure_storage_unavailable", "secure_storage_degraded"].includes(error.code));
      return true;
    });
  }
});

test("future, corrupt, expanded, and mismatched records fail closed", async () => {
  const { filePath, store } = await isolatedStore();
  await store.prepareEnrollment(CONTEXT);
  const valid = JSON.parse(await readFile(filePath, "utf8"));
  const cases = [
    { ...valid, schemaVersion: 2 },
    { ...valid, unknown: true },
    { ...valid, publicKeyFingerprint: "0".repeat(64) },
    { ...valid, encryptedPrivateKey: Buffer.from("protected:not-a-key").toString("base64") },
  ];
  for (const value of cases) {
    await writeFile(filePath, JSON.stringify(value), "utf8");
    const reloaded = createRemoteControlCredentialStore({
      filePath,
      safeStorage: secureStorage(),
      platform: "darwin",
    });
    await assert.rejects(reloaded.read(CONTEXT), (error) => {
      assert.ok(error instanceof RemoteControlCredentialError);
      assert.ok(["credentials_future_version", "credentials_corrupt"].includes(error.code));
      return true;
    });
  }

  await writeFile(filePath, JSON.stringify(valid), "utf8");
  const reloaded = createRemoteControlCredentialStore({ filePath, safeStorage: secureStorage(), platform: "darwin" });
  await assert.rejects(reloaded.read({ ...CONTEXT, userId: "other_user" }), (error) => {
    assert.ok(error instanceof RemoteControlCredentialError);
    assert.equal(error.code, "credentials_context_mismatch");
    return true;
  });
});

test("a mismatched Cloud binding leaves the durable key pending", async () => {
  const { store } = await isolatedStore();
  const { binding } = await pendingAndBinding(store);
  await assert.rejects(store.completeEnrollment(CONTEXT, {
    ...binding,
    publicKeyFingerprint: "0".repeat(64),
  }), (error) => {
    assert.ok(error instanceof RemoteControlCredentialError);
    assert.equal(error.code, "credentials_binding_mismatch");
    return true;
  });
  assert.equal((await store.read(CONTEXT)).state, "pending");
});

test("credential operations serialize and writes use a private atomic temp then rename", async () => {
  const calls = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const { filePath, store } = await isolatedStore({
    fileSystem: {
      writeFile: async (target, value, options) => {
        calls.push({ type: "write", target, options });
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeWrites -= 1;
        return writeFile(target, value, options);
      },
      rename: async (source, target) => {
        calls.push({ type: "rename", source, target });
        const { rename } = await import("node:fs/promises");
        return rename(source, target);
      },
    },
  });
  const [first, second] = await Promise.all([
    store.prepareEnrollment(CONTEXT),
    store.prepareEnrollment(CONTEXT),
  ]);
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(maxActiveWrites, 1);
  assert.equal(calls.filter((call) => call.type === "write").length, 1);
  assert.equal(calls[0].options.mode, 0o600);
  assert.match(calls[0].target, /\.tmp$/);
  assert.deepEqual(calls[1], { type: "rename", source: calls[0].target, target: filePath });
});

test("failed atomic writes remove the temp file and do not expose credentials", async () => {
  const removed = [];
  const { store } = await isolatedStore({
    fileSystem: {
      writeFile: async () => {
        throw new Error("disk unavailable");
      },
      rm: async (target, options) => {
        removed.push({ target, options });
      },
    },
  });
  await assert.rejects(store.prepareEnrollment(CONTEXT), (error) => {
    assert.ok(error instanceof RemoteControlCredentialError);
    assert.equal(error.code, "credentials_write_failed");
    return true;
  });
  assert.equal(removed.length, 1);
  assert.match(removed[0].target, /\.tmp$/);
  assert.deepEqual(removed[0].options, { force: true });
});

test("inspects credential completeness without returning credential material or requiring context", async () => {
  const { filePath, store } = await isolatedStore();
  assert.deepEqual(await store.inspect(), { state: "absent" });
  await store.prepareEnrollment(CONTEXT);
  assert.deepEqual(await store.inspect(), { state: "pending" });
  assert.deepEqual(Object.keys(await store.inspect()), ["state"]);

  const { binding } = await pendingAndBinding(store);
  await store.completeEnrollment(CONTEXT, binding);
  assert.deepEqual(await store.inspect(), { state: "enrolled" });

  await writeFile(filePath, "credential secret is corrupt", "utf8");
  assert.deepEqual(await store.inspect(), { state: "corrupt" });
});
