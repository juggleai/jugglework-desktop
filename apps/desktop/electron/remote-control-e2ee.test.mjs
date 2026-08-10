import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  canonicalRemoteControlAAD,
  createRemoteControlE2EEKeyStore,
  createSignedRemoteControlE2EEKeyAdvertisement,
  decryptRemoteControlPayload,
  deriveRemoteControlE2EEKey,
  deriveRemoteControlE2EEKeyFromSecret,
  encryptRemoteControlPayload,
  remoteControlE2EEKeyId,
  REMOTE_CONTROL_E2EE_RETIRED_KEY_MS,
  verifySignedRemoteControlE2EEKeyAdvertisement,
} from "./remote-control-e2ee.mjs";

const DESKTOP_PRIVATE = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3ye4jduOYWiyTqCE0PdmubEgmMBpW_-7bHq9E4qs0PuhRANCAATm6lt5vf6auoaWfYRl06WsuLzPu-4xLZ3FNaZjsU14jPGiWFcvmB-4Y-mF6lxVC9rQ9IAGXsZxHSql0JaYnNc6";
const DESKTOP_PUBLIC = "BObqW3m9_pq6hpZ9hGXTpay4vM-77jEtncU1pmOxTXiM8aJYVy-YH7hj6YXqXFUL2tD0gAZexnEdKqXQlpic1zo";
const CONTROLLER_PRIVATE = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBaLtBcvx2ltRIFCQCo1xEi6WEhIiPUjOpq493TKn-KGhRANCAAQtQtmPG3obCDk4fUe9sXdHVHfVcWrdi2RC40gSy4T3Ubxn42gWdNl1i9oeDQ8gc0zaXJdXrG7hLRj2ixlOPRiP";
const CONTROLLER_PUBLIC = "BC1C2Y8behsIOTh9R72xd0dUd9Vxat2LZELjSBLLhPdRvGfjaBZ02XWL2h4NDyBzTNpcl1esbuEtGPaLGU49GI8";
const CONTROL = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const STATEMENT_HASH = "a".repeat(64);

describe("remote-control E2EE", () => {
  it("derives matching P-256 session keys bound to the signed statement and routing", () => {
    const desktopKeyId = remoteControlE2EEKeyId(DESKTOP_PUBLIC);
    const controllerKeyId = remoteControlE2EEKeyId(CONTROLLER_PUBLIC);
    const common = { controlSessionId: CONTROL, deviceId: DEVICE, desktopKeyId, desktopStatementHash: STATEMENT_HASH, controllerKeyId };
    const desktop = deriveRemoteControlE2EEKey({ ...common, privateKey: createPrivateKey({ key: Buffer.from(DESKTOP_PRIVATE, "base64url"), format: "der", type: "pkcs8" }), peerPublicKey: CONTROLLER_PUBLIC, direction: "controller-to-desktop" });
    const controller = deriveRemoteControlE2EEKey({ ...common, privateKey: createPrivateKey({ key: Buffer.from(CONTROLLER_PRIVATE, "base64url"), format: "der", type: "pkcs8" }), peerPublicKey: DESKTOP_PUBLIC, direction: "controller-to-desktop" });
    assert.deepEqual(desktop, controller);
    const aad = canonicalRemoteControlAAD({ kind: "command", protocolVersion: 1, payloadVersion: 1, controlSessionId: CONTROL, deviceId: DEVICE, operation: "session.prompt", workspaceId: "ws_1", sessionId: "ses_1", idempotencyKey: "idem_1", desktopKeyId, desktopStatementHash: STATEMENT_HASH, controllerKeyId });
    const value = { operation: "session.prompt", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_1", prompt: "E2EE_CONTENT_CANARY" } };
    const encrypted = encryptRemoteControlPayload({ key: controller, nonce: Buffer.from("000102030405060708090a0b", "hex"), aad, value });
    assert.deepEqual(decryptRemoteControlPayload({ key: desktop, aad, payload: encrypted }), value);
    assert.doesNotMatch(JSON.stringify(encrypted), /E2EE_CONTENT_CANARY/);
    assert.notDeepEqual(
      deriveRemoteControlE2EEKeyFromSecret({ ...common, desktopStatementHash: "b".repeat(64), secret: Buffer.alloc(32), direction: "controller-to-desktop" }),
      deriveRemoteControlE2EEKeyFromSecret({ ...common, secret: Buffer.alloc(32), direction: "controller-to-desktop" }),
    );
  });

  it("signs the canonical advertisement only with the enrolled Ed25519 identity", () => {
    const signing = generateKeyPairSync("ed25519");
    const publicKey = signing.publicKey.export({ format: "jwk" }).x;
    const credential = {
      deviceId: DEVICE,
      keyId: "33333333-3333-4333-8333-333333333333",
      publicKey,
      publicKeyFingerprint: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
      privateKey: signing.privateKey,
    };
    const signed = createSignedRemoteControlE2EEKeyAdvertisement({
      keyId: remoteControlE2EEKeyId(DESKTOP_PUBLIC), publicKey: DESKTOP_PUBLIC,
      algorithm: "P-256/HKDF-SHA-256/AES-256-GCM", createdAt: "2026-08-10T12:00:00.000Z",
    }, credential);
    assert.equal(verifySignedRemoteControlE2EEKeyAdvertisement(signed, {
      deviceId: DEVICE, signingKeyId: credential.keyId, signingPublicKey: publicKey,
      signingFingerprint: credential.publicKeyFingerprint,
    }).statementHash, signed.statementHash);
    assert.throws(() => verifySignedRemoteControlE2EEKeyAdvertisement({ ...signed, publicKey: CONTROLLER_PUBLIC }, {
      deviceId: DEVICE, signingKeyId: credential.keyId, signingPublicKey: publicKey,
      signingFingerprint: credential.publicKeyFingerprint,
    }));
    assert.equal(signing.privateKey.asymmetricKeyType, "ed25519");
  });

  it("protects P-256 private keys, retains rotated keys for replay, and securely revokes all", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "jugglework-e2ee-"));
    const filePath = path.join(directory, "keys.json");
    let timestamp = Date.parse("2026-08-10T12:00:00.000Z");
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`),
      decryptString: (value) => value.toString().slice("protected:".length),
    };
    const store = createRemoteControlE2EEKeyStore({ filePath, safeStorage, platform: "darwin", now: () => new Date(timestamp) });
    const first = await store.active();
    const second = await store.rotate();
    assert.notEqual(first.keyId, second.keyId);
    assert.equal((await store.privateKey(first.keyId)).asymmetricKeyType, "ec");
    assert.doesNotMatch(await readFile(filePath, "utf8"), /BEGIN PRIVATE KEY|"privateKey"/);
    timestamp += REMOTE_CONTROL_E2EE_RETIRED_KEY_MS;
    await store.active();
    await assert.rejects(() => store.privateKey(first.keyId), /revoked|expired/);
    await store.revokeAll();
    await assert.rejects(() => store.privateKey(second.keyId), /revoked|expired/);
  });
});
