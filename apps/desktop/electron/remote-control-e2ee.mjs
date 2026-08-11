import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const REMOTE_CONTROL_E2EE_MODE = "e2ee-v1";
export const REMOTE_CONTROL_E2EE_ALGORITHM = "P-256/HKDF-SHA-256/AES-256-GCM";
export const REMOTE_CONTROL_E2EE_ROTATION_MS = 30 * 24 * 60 * 60 * 1_000;
export const REMOTE_CONTROL_E2EE_RETIRED_KEY_MS = 24 * 60 * 60 * 1_000;

const P256_KEY_ID = /^p256:[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** @typedef {import("node:crypto").KeyObject} KeyObject */
/** @typedef {{ keyId: string, publicKey: string, encryptedPrivateKey: string, createdAt: string, retiredAt: string | null }} StoredE2EEKey */
/** @typedef {{ schemaVersion: 1, activeKeyId: string | null, keys: StoredE2EEKey[] }} StoredE2EEKeyRecord */
/** @typedef {{ keyId: string, publicKey: string, algorithm: string, createdAt: string }} E2EEKeyAdvertisement */
/** @typedef {{ isEncryptionAvailable(): boolean, encryptString(value: string): Buffer, decryptString(value: Buffer): string, getSelectedStorageBackend?: () => string }} SafeStorage */
/** @typedef {{ mkdir?: typeof mkdir, readFile?: typeof readFile, rename?: typeof rename, rm?: typeof rm, writeFile?: typeof writeFile }} E2EEFileSystem */
/** @typedef {{ app?: { getPath(name: string): string }, filePath?: string, safeStorage: SafeStorage, platform?: NodeJS.Platform, now?: () => Date, fileSystem?: E2EEFileSystem }} E2EEKeyStoreOptions */
/** @typedef {{ active(): Promise<E2EEKeyAdvertisement>, rotate(): Promise<E2EEKeyAdvertisement>, advertisement(keyId: string): Promise<E2EEKeyAdvertisement>, privateKey(keyId: string): Promise<KeyObject>, revokeAll(): Promise<void> }} E2EEKeyStore */

function fail(message) { throw new TypeError(message); }
function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} is invalid.`);
  return value;
}
function base64url(value, length, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) fail(`${label} is invalid.`);
  const decoded = Buffer.from(value, "base64url");
  if ((length !== null && decoded.length !== length) || decoded.toString("base64url") !== value) fail(`${label} is invalid.`);
  return decoded;
}
function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) fail(`${label} is invalid.`);
  return value;
}

export function canonicalRemoteControlAAD(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("Encryption metadata is invalid.");
  const entries = Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || !(value === null || typeof value === "string" || Number.isSafeInteger(value))) fail("Encryption metadata is invalid.");
  }
  return Buffer.from(`jugglework.desktop-remote.e2ee-v1\n${JSON.stringify(Object.fromEntries(entries))}\n`, "utf8");
}

export function remoteControlE2EEKeyId(publicKey) {
  const raw = base64url(publicKey, 65, "P-256 public key");
  if (raw[0] !== 4) fail("P-256 public key is invalid.");
  return `p256:${createHash("sha256").update(raw).digest("base64url")}`;
}

function importP256PublicKey(publicKey) {
  const raw = base64url(publicKey, 65, "P-256 public key");
  if (raw[0] !== 4) fail("P-256 public key is invalid.");
  return createPublicKey({
    key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") },
    format: "jwk",
  });
}

function exportP256PublicKey(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") fail("Generated key is not P-256.");
  return Buffer.concat([Buffer.from([4]), base64url(jwk.x, 32, "P-256 x"), base64url(jwk.y, 32, "P-256 y")]).toString("base64url");
}

export function canonicalRemoteControlE2EEKeyStatement({ deviceId, signingIdentity, keyId, publicKey, algorithm, createdAt }) {
  if (!UUID.test(deviceId) || !P256_KEY_ID.test(keyId) || remoteControlE2EEKeyId(publicKey) !== keyId ||
      algorithm !== REMOTE_CONTROL_E2EE_ALGORITHM || signingIdentity?.algorithm !== "Ed25519" ||
      !UUID.test(signingIdentity.keyId) || !SHA256.test(signingIdentity.fingerprint)) fail("E2EE advertisement binding is invalid.");
  const signingPublicKey = base64url(signingIdentity.publicKey, 32, "Ed25519 public key");
  if (createHash("sha256").update(signingPublicKey).digest("hex") !== signingIdentity.fingerprint) fail("E2EE signing fingerprint is invalid.");
  canonicalTimestamp(createdAt, "E2EE key creation timestamp");
  return `jugglework.desktop-remote.e2ee-key-advertisement.v1\ndeviceId=${deviceId}\nsigningAlgorithm=Ed25519\nsigningKeyId=${signingIdentity.keyId}\nsigningKeyFingerprint=${signingIdentity.fingerprint}\ne2eeKeyId=${keyId}\ne2eePublicKey=${publicKey}\ne2eeAlgorithm=${algorithm}\ncreatedAt=${createdAt}\n`;
}

export function remoteControlE2EEStatementHash(statement) {
  if (typeof statement !== "string" || !statement.startsWith("jugglework.desktop-remote.e2ee-key-advertisement.v1\n") || Buffer.byteLength(statement) > 1_024) fail("E2EE signed statement is invalid.");
  return createHash("sha256").update(statement, "utf8").digest("hex");
}

export function createSignedRemoteControlE2EEKeyAdvertisement(advertisement, credential) {
  exact(advertisement, ["keyId", "publicKey", "algorithm", "createdAt"], "E2EE key advertisement");
  if (credential?.privateKey?.asymmetricKeyType !== "ed25519") fail("Ed25519 signing credential is invalid.");
  const signingIdentity = Object.freeze({
    algorithm: "Ed25519",
    keyId: credential.keyId,
    publicKey: credential.publicKey,
    fingerprint: credential.publicKeyFingerprint,
  });
  const signedStatement = canonicalRemoteControlE2EEKeyStatement({ deviceId: credential.deviceId, signingIdentity, ...advertisement });
  return Object.freeze({
    ...advertisement,
    signedStatement,
    statementHash: remoteControlE2EEStatementHash(signedStatement),
    signature: sign(null, Buffer.from(signedStatement, "utf8"), credential.privateKey).toString("base64url"),
    signingIdentity,
  });
}

export function verifySignedRemoteControlE2EEKeyAdvertisement(advertisement, expected) {
  exact(advertisement, ["keyId", "publicKey", "algorithm", "createdAt", "signedStatement", "statementHash", "signature", "signingIdentity"], "Signed E2EE key advertisement");
  exact(advertisement.signingIdentity, ["algorithm", "keyId", "publicKey", "fingerprint"], "E2EE signing identity");
  const statement = canonicalRemoteControlE2EEKeyStatement({ deviceId: expected.deviceId, signingIdentity: advertisement.signingIdentity, ...advertisement });
  if (advertisement.signedStatement !== statement || advertisement.statementHash !== remoteControlE2EEStatementHash(statement) ||
      advertisement.signingIdentity.keyId !== expected.signingKeyId || advertisement.signingIdentity.publicKey !== expected.signingPublicKey ||
      advertisement.signingIdentity.fingerprint !== expected.signingFingerprint) fail("Signed E2EE advertisement binding is invalid.");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: expected.signingPublicKey }, format: "jwk" });
  if (!verify(null, Buffer.from(statement, "utf8"), key, base64url(advertisement.signature, 64, "Ed25519 signature"))) fail("E2EE advertisement signature is invalid.");
  return advertisement;
}

export function deriveRemoteControlE2EEKey({ privateKey, peerPublicKey, controlSessionId, deviceId, desktopKeyId, desktopStatementHash, controllerKeyId, direction }) {
  if (!P256_KEY_ID.test(desktopKeyId) || !P256_KEY_ID.test(controllerKeyId) || !SHA256.test(desktopStatementHash) || !["controller-to-desktop", "desktop-to-controller"].includes(direction)) fail("Encryption key binding is invalid.");
  const imported = privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey);
  if (imported.asymmetricKeyType !== "ec" || imported.asymmetricKeyDetails?.namedCurve !== "prime256v1") fail("Private key is not P-256.");
  const secret = diffieHellman({ privateKey: imported, publicKey: importP256PublicKey(peerPublicKey) });
  try { return deriveRemoteControlE2EEKeyFromSecret({ secret, controlSessionId, deviceId, desktopKeyId, desktopStatementHash, controllerKeyId, direction }); }
  finally { secret.fill(0); }
}

export function deriveRemoteControlE2EEKeyFromSecret({ secret, controlSessionId, deviceId, desktopKeyId, desktopStatementHash, controllerKeyId, direction }) {
  if (!P256_KEY_ID.test(desktopKeyId) || !P256_KEY_ID.test(controllerKeyId) || !SHA256.test(desktopStatementHash) || !["controller-to-desktop", "desktop-to-controller"].includes(direction)) fail("Encryption key binding is invalid.");
  const bytes = Buffer.from(secret);
  if (bytes.length !== 32) fail("ECDH shared secret is invalid.");
  const salt = createHash("sha256").update(`jugglework.desktop-remote.e2ee-v1\n${controlSessionId}\n${deviceId}\n`).digest();
  return Buffer.from(hkdfSync("sha256", bytes, salt, Buffer.from(`${desktopKeyId}\n${controllerKeyId}\n${desktopStatementHash}\n${direction}\n`), 32));
}

export function encryptRemoteControlPayload({ key, nonce = randomBytes(12), aad, value }) {
  const keyBytes = Buffer.from(key);
  const nonceBytes = Buffer.from(nonce);
  if (keyBytes.length !== 32 || nonceBytes.length !== 12) fail("Encryption material is invalid.");
  const cipher = createCipheriv("aes-256-gcm", keyBytes, nonceBytes, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonceBytes.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

export function decryptRemoteControlPayload({ key, aad, payload }) {
  exact(payload, ["nonce", "ciphertext"], "Encrypted payload");
  const nonce = base64url(payload.nonce, 12, "AES-GCM nonce");
  const combined = base64url(payload.ciphertext, null, "AES-GCM ciphertext");
  if (combined.length < 17) fail("Encrypted payload is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(combined.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]).toString("utf8"));
}

/** @param {E2EEKeyStoreOptions} options @returns {E2EEKeyStore} */
export function createRemoteControlE2EEKeyStore({ app, filePath, safeStorage, platform = process.platform, now = () => new Date(), fileSystem = {} }) {
  const target = filePath ?? (app?.getPath ? path.join(app.getPath("userData"), "desktop-remote-control-e2ee-keys.json") : null);
  if (!target) fail("An E2EE key file path is required.");
  const fs = { mkdir: fileSystem.mkdir ?? mkdir, readFile: fileSystem.readFile ?? readFile, rename: fileSystem.rename ?? rename, rm: fileSystem.rm ?? rm, writeFile: fileSystem.writeFile ?? writeFile };
  /** @type {Promise<unknown>} */
  let serial = Promise.resolve();
  /** @template T @param {() => Promise<T>} action @returns {Promise<T>} */
  const run = (action) => { const next = serial.then(action, action); serial = next.then(() => undefined, () => undefined); return next; };
  /** @returns {SafeStorage} */
  function storage() {
    if (!safeStorage?.isEncryptionAvailable?.() || typeof safeStorage.encryptString !== "function" || typeof safeStorage.decryptString !== "function") fail("Platform secure storage is unavailable.");
    if (platform === "linux" && ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend?.() ?? "unknown")) fail("Platform secure storage is degraded.");
    return safeStorage;
  }
  /** @returns {Promise<StoredE2EEKeyRecord>} */
  async function load() {
    storage();
    let raw;
    try { raw = await fs.readFile(target, "utf8"); } catch (error) { if (error?.code === "ENOENT") return { schemaVersion: 1, activeKeyId: null, keys: [] }; throw error; }
    const record = /** @type {StoredE2EEKeyRecord} */ (JSON.parse(raw));
    exact(record, ["schemaVersion", "activeKeyId", "keys"], "E2EE key store");
    if (record.schemaVersion !== 1 || !(record.activeKeyId === null || P256_KEY_ID.test(record.activeKeyId)) || !Array.isArray(record.keys)) fail("E2EE key store is corrupt.");
    for (const item of record.keys) {
      exact(item, ["keyId", "publicKey", "encryptedPrivateKey", "createdAt", "retiredAt"], "E2EE key");
      if (remoteControlE2EEKeyId(item.publicKey) !== item.keyId || !Number.isFinite(Date.parse(item.createdAt)) || !(item.retiredAt === null || Number.isFinite(Date.parse(item.retiredAt)))) fail("E2EE key store is corrupt.");
    }
    return record;
  }
  /** @param {StoredE2EEKeyRecord} record */
  async function persist(record) {
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await fs.rename(temporary, target); }
    catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
  }
  /** @param {Date} at @returns {StoredE2EEKey} */
  function createKey(at) {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = exportP256PublicKey(pair.publicKey);
    const der = pair.privateKey.export({ format: "der", type: "pkcs8" });
    try { return { keyId: remoteControlE2EEKeyId(publicKey), publicKey, encryptedPrivateKey: storage().encryptString(der.toString("base64url")).toString("base64"), createdAt: at.toISOString(), retiredAt: null }; }
    finally { der.fill(0); }
  }
  /** @param {StoredE2EEKey} item @returns {Readonly<E2EEKeyAdvertisement>} */
  const view = (item) => Object.freeze({ keyId: item.keyId, publicKey: item.publicKey, algorithm: REMOTE_CONTROL_E2EE_ALGORITHM, createdAt: item.createdAt });
  /** @param {boolean} [force] @returns {Promise<Readonly<E2EEKeyAdvertisement>>} */
  async function active(force = false) {
    const record = await load();
    const at = new Date(now());
    if (!Number.isFinite(at.getTime())) fail("E2EE key clock is invalid.");
    let current = record.keys.find((item) => item.keyId === record.activeKeyId && item.retiredAt === null);
    if (!current || force || at.getTime() - Date.parse(current.createdAt) >= REMOTE_CONTROL_E2EE_ROTATION_MS) {
      if (current) current.retiredAt = at.toISOString();
      current = createKey(at);
      record.activeKeyId = current.keyId;
      record.keys.push(current);
    }
    record.keys = record.keys.filter((item) => item.retiredAt === null || at.getTime() - Date.parse(item.retiredAt) < REMOTE_CONTROL_E2EE_RETIRED_KEY_MS);
    await persist(record);
    return view(current);
  }
  return Object.freeze({
    active: () => run(() => active(false)),
    rotate: () => run(() => active(true)),
    advertisement: (keyId) => run(async () => {
      if (!P256_KEY_ID.test(keyId)) fail("E2EE key identifier is invalid.");
      const item = (await load()).keys.find((candidate) => candidate.keyId === keyId);
      if (!item) fail("E2EE key was revoked or expired.");
      return view(item);
    }),
    privateKey: (keyId) => run(async () => {
      if (!P256_KEY_ID.test(keyId)) fail("E2EE key identifier is invalid.");
      const item = (await load()).keys.find((candidate) => candidate.keyId === keyId);
      if (!item) fail("E2EE key was revoked or expired.");
      const der = Buffer.from(storage().decryptString(Buffer.from(item.encryptedPrivateKey, "base64")), "base64url");
      try { return createPrivateKey({ key: der, format: "der", type: "pkcs8" }); }
      finally { der.fill(0); }
    }),
    revokeAll: () => run(() => fs.rm(target, { force: true })),
  });
}
