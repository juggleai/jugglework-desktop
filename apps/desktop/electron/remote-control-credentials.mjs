import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { deriveRemoteControlCloudUrls } from "./remote-control-cloud-client.mjs";

export const REMOTE_CONTROL_CREDENTIALS_VERSION = 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** @typedef {{ controlPlaneBaseUrl: string, userId: string, organizationId: string }} RemoteControlCredentialContext */
/** @typedef {{ controlPlaneBaseUrl?: unknown, userId?: unknown, organizationId?: unknown }} RemoteControlCredentialContextInput */
/**
 * @typedef {{
 *   isEncryptionAvailable?: () => boolean,
 *   getSelectedStorageBackend?: () => string,
 *   encryptString?: (plaintext: string) => Buffer,
 *   decryptString?: (ciphertext: Buffer) => string,
 * }} RemoteControlSafeStorageInput
 */
/**
 * @typedef {{
 *   isEncryptionAvailable: () => boolean,
 *   getSelectedStorageBackend?: () => string,
 *   encryptString: (plaintext: string) => Buffer,
 *   decryptString: (ciphertext: Buffer) => string,
 * }} RemoteControlSafeStorage
 */
/**
 * @typedef {{
 *   schemaVersion: number,
 *   state: "pending" | "enrolled",
 *   context: RemoteControlCredentialContext,
 *   algorithm: "Ed25519",
 *   publicKey: string,
 *   publicKeyFingerprint: string,
 *   encryptedPrivateKey: string,
 *   createdAt: string,
 *   deviceId?: string,
 *   keyId?: string,
 *   enrolledAt?: string,
 * }} RemoteControlCredentialRecord
 */
/**
 * @typedef {{
 *   schemaVersion: number,
 *   state: "pending" | "enrolled",
 *   context: Readonly<RemoteControlCredentialContext>,
 *   algorithm: "Ed25519",
 *   publicKey: string,
 *   publicKeyFingerprint: string,
 *   createdAt: string,
 *   deviceId?: string,
 *   keyId?: string,
 *   enrolledAt?: string,
 * }} RemoteControlCredentialView
 */
/** @typedef {{ deviceId: string, keyId: string, publicKeyFingerprint: string, enrolledAt: string }} RemoteControlEnrollmentBinding */
/** @typedef {{ deviceId: string, keyId: string, publicKey: string, publicKeyFingerprint: string, privateKey: import("node:crypto").KeyObject }} RemoteControlSigningCredential */
/**
 * @typedef {{
 *   filePath: string,
 *   inspect(): Promise<Readonly<{ state: "absent" | "pending" | "enrolled" | "corrupt" }>>,
 *   read(context: RemoteControlCredentialContextInput): Promise<RemoteControlCredentialView | null>,
 *   prepareEnrollment(context: RemoteControlCredentialContextInput): Promise<RemoteControlCredentialView>,
 *   completeEnrollment(context: RemoteControlCredentialContextInput, binding: RemoteControlEnrollmentBinding): Promise<RemoteControlCredentialView>,
 *   getSigningCredential(context: RemoteControlCredentialContextInput): Promise<RemoteControlSigningCredential>,
 *   delete(): Promise<void>,
 * }} RemoteControlCredentialStore
 */
/**
 * @typedef {{
 *   app?: { getPath(name: string): string } | null,
 *   filePath?: string,
 *   safeStorage?: RemoteControlSafeStorageInput | null,
 *   platform?: NodeJS.Platform,
 *   allowInsecureLoopback?: boolean,
 *   now?: () => Date,
 *   fileSystem?: Partial<Pick<typeof import("node:fs/promises"), "mkdir" | "readFile" | "rename" | "rm" | "writeFile">>,
 *   crypto?: {
 *     generateKeyPairSync?: (type: "ed25519") => { publicKey: import("node:crypto").KeyObject, privateKey: import("node:crypto").KeyObject },
 *     randomBytes?: (size: number) => Buffer,
 *     createPrivateKey?: (options: { key: Buffer, format: "der", type: "pkcs8" }) => import("node:crypto").KeyObject,
 *     createPublicKey?: (key: import("node:crypto").KeyObject) => import("node:crypto").KeyObject,
 *   },
 * }} RemoteControlCredentialStoreOptions
 */

export class RemoteControlCredentialError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "RemoteControlCredentialError";
    this.code = code;
  }
}

/** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] @returns {never} */
function fail(code, message, options) {
  throw new RemoteControlCredentialError(code, message, options);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("credentials_corrupt", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("credentials_corrupt", `${label} contains missing or unknown fields.`);
  }
  return value;
}

function canonicalIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("invalid_context", `${label} is invalid.`);
  }
  return value;
}

function canonicalDate(value, label) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : null;
  if (!match) fail("credentials_corrupt", `${label} must be an RFC 3339 timestamp.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
    Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
    (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))
  ) fail("credentials_corrupt", `${label} must be a valid RFC 3339 timestamp.`);
  return value;
}

function canonicalBase64(value, label) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail("credentials_corrupt", `${label} must be canonical base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value) {
    fail("credentials_corrupt", `${label} must be canonical base64.`);
  }
  return decoded;
}

function canonicalBase64Url(value, byteLength, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail("credentials_corrupt", `${label} must be canonical base64url.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== byteLength || decoded.toString("base64url") !== value) {
    fail("credentials_corrupt", `${label} must be canonical base64url.`);
  }
  return decoded;
}

function canonicalUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("credentials_corrupt", `${label} must be a canonical UUID.`);
  }
  return value;
}

/**
 * Normalize the account, organization, and control-plane binding persisted with a device key.
 * @param {RemoteControlCredentialContextInput} input
 * @param {{ allowInsecureLoopback?: boolean }} [options]
 * @returns {RemoteControlCredentialContext}
 */
export function normalizeRemoteControlCredentialContext(input, { allowInsecureLoopback = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid_context", "A credential context is required.");
  }
  let urls;
  try {
    urls = deriveRemoteControlCloudUrls(input.controlPlaneBaseUrl, { allowInsecureLoopback });
  } catch (cause) {
    fail("invalid_context", "The credential control-plane URL is invalid.", { cause });
  }
  return {
    controlPlaneBaseUrl: urls.controlPlaneBaseUrl,
    userId: canonicalIdentifier(input.userId, "userId"),
    organizationId: canonicalIdentifier(input.organizationId, "organizationId"),
  };
}

/** @param {RemoteControlSafeStorageInput | null | undefined} safeStorage @param {NodeJS.Platform} platform */
function assertSecureStorage(safeStorage, platform) {
  let available = false;
  try {
    available = Boolean(
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === "function" &&
      typeof safeStorage.encryptString === "function" &&
      typeof safeStorage.decryptString === "function" &&
      safeStorage.isEncryptionAvailable() === true
    );
  } catch {
    available = false;
  }
  if (!available) {
    fail("secure_storage_unavailable", "Platform secure storage encryption is unavailable.");
  }
  if (platform === "linux") {
    let backend = "unknown";
    try {
      backend = typeof safeStorage.getSelectedStorageBackend === "function"
        ? safeStorage.getSelectedStorageBackend()
        : "unknown";
    } catch {
      backend = "unknown";
    }
    if (typeof backend !== "string" || backend === "basic_text" || backend === "unknown") {
      fail("secure_storage_degraded", "Linux secure storage is not backed by an eligible secret store.");
    }
  }
}

/** @param {RemoteControlCredentialContext} left @param {RemoteControlCredentialContext} right */
function contextsEqual(left, right) {
  return left.controlPlaneBaseUrl === right.controlPlaneBaseUrl &&
    left.userId === right.userId &&
    left.organizationId === right.organizationId;
}

/** @param {import("node:crypto").KeyObject} publicKey @returns {string} */
function publicKeyFromKeyObject(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    fail("key_generation_failed", "The generated key is not Ed25519.");
  }
  canonicalBase64Url(jwk.x, 32, "publicKey");
  return jwk.x;
}

/** @param {string} publicKey @returns {string} */
function publicKeyFingerprint(publicKey) {
  return createHash("sha256").update(canonicalBase64Url(publicKey, 32, "publicKey")).digest("hex");
}

/** @param {RemoteControlCredentialRecord} record @returns {Readonly<RemoteControlCredentialView>} */
function recordView(record) {
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    state: record.state,
    context: Object.freeze({ ...record.context }),
    algorithm: record.algorithm,
    publicKey: record.publicKey,
    publicKeyFingerprint: record.publicKeyFingerprint,
    createdAt: record.createdAt,
    ...(record.state === "enrolled" ? {
      deviceId: record.deviceId,
      keyId: record.keyId,
      enrolledAt: record.enrolledAt,
    } : {}),
  });
}

/**
 * Create a serialized, atomic credential store. safeStorage must be the
 * Electron Main safeStorage object; plaintext PKCS8 data is never written.
 * @param {RemoteControlCredentialStoreOptions} [options]
 * @returns {Readonly<RemoteControlCredentialStore>}
 */
export function createRemoteControlCredentialStore({
  app,
  filePath,
  safeStorage,
  platform = process.platform,
  allowInsecureLoopback = false,
  now = () => new Date(),
  fileSystem = {},
  crypto = {},
} = {}) {
  if (!filePath && (!app || typeof app.getPath !== "function")) {
    fail("invalid_store", "A credential file path or Electron app is required.");
  }
  const targetPath = filePath ?? path.join(app.getPath("userData"), "desktop-remote-control-credentials.json");
  const fs = {
    mkdir: fileSystem.mkdir ?? mkdir,
    readFile: fileSystem.readFile ?? readFile,
    rename: fileSystem.rename ?? rename,
    rm: fileSystem.rm ?? rm,
    writeFile: fileSystem.writeFile ?? writeFile,
  };
  const generate = crypto.generateKeyPairSync ?? generateKeyPairSync;
  const random = crypto.randomBytes ?? randomBytes;
  const importPrivateKey = crypto.createPrivateKey ?? createPrivateKey;
  const derivePublicKey = crypto.createPublicKey ?? createPublicKey;
  let operation = Promise.resolve();

  /** @template T @param {() => Promise<T>} action @returns {Promise<T>} */
  function serialize(action) {
    const next = operation.then(() => action(), () => action());
    operation = next.then(() => undefined, () => undefined);
    return next;
  }

  /** @returns {RemoteControlSafeStorage} */
  function secureStorage() {
    assertSecureStorage(safeStorage, platform);
    return /** @type {RemoteControlSafeStorage} */ (safeStorage);
  }

  /** @param {RemoteControlCredentialContextInput} context @returns {RemoteControlCredentialContext} */
  function normalizeContext(context) {
    return normalizeRemoteControlCredentialContext(context, { allowInsecureLoopback });
  }

  /** @param {RemoteControlCredentialRecord} record @returns {import("node:crypto").KeyObject} */
  function decryptPrivateKey(record) {
    const storage = secureStorage();
    let encrypted;
    let plaintext;
    try {
      encrypted = canonicalBase64(record.encryptedPrivateKey, "encryptedPrivateKey");
      plaintext = storage.decryptString(encrypted);
    } catch (cause) {
      if (cause instanceof RemoteControlCredentialError) throw cause;
      fail("credentials_corrupt", "The encrypted device key cannot be decrypted.", { cause });
    }
    if (typeof plaintext !== "string" || !/^[A-Za-z0-9_-]+$/.test(plaintext)) {
      fail("credentials_corrupt", "The decrypted device key is malformed.");
    }
    const privateDer = Buffer.from(plaintext, "base64url");
    if (!privateDer.length || privateDer.toString("base64url") !== plaintext) {
      privateDer.fill(0);
      fail("credentials_corrupt", "The decrypted device key is malformed.");
    }
    try {
      const privateKey = importPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
      if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
        fail("credentials_corrupt", "The decrypted device key is not Ed25519.");
      }
      const derived = publicKeyFromKeyObject(derivePublicKey(privateKey));
      if (derived !== record.publicKey) fail("credentials_corrupt", "The encrypted key does not match its public metadata.");
      return privateKey;
    } catch (cause) {
      if (cause instanceof RemoteControlCredentialError) throw cause;
      fail("credentials_corrupt", "The decrypted device key is invalid.", { cause });
    } finally {
      privateDer.fill(0);
    }
  }

  /** @param {any} value @param {RemoteControlCredentialContext | null} expectedContext @returns {RemoteControlCredentialRecord} */
  function validateRecord(value, expectedContext) {
    const common = [
      "schemaVersion", "state", "context", "algorithm", "publicKey",
      "publicKeyFingerprint", "encryptedPrivateKey", "createdAt",
    ];
    exactObject(value, value?.state === "enrolled" ? [...common, "deviceId", "keyId", "enrolledAt"] : common, "credential record");
    if (value.schemaVersion !== REMOTE_CONTROL_CREDENTIALS_VERSION) {
      fail(value.schemaVersion > REMOTE_CONTROL_CREDENTIALS_VERSION ? "credentials_future_version" : "credentials_corrupt", "The credential schema version is unsupported.");
    }
    if (value.state !== "pending" && value.state !== "enrolled") fail("credentials_corrupt", "The credential state is invalid.");
    exactObject(value.context, ["controlPlaneBaseUrl", "userId", "organizationId"], "credential context");
    const normalizedStoredContext = normalizeContext(value.context);
    if (!contextsEqual(normalizedStoredContext, value.context)) fail("credentials_corrupt", "The stored credential context is not canonical.");
    if (expectedContext !== null && !contextsEqual(value.context, expectedContext)) fail("credentials_context_mismatch", "The credential belongs to another account, organization, or control plane.");
    if (value.algorithm !== "Ed25519") fail("credentials_corrupt", "The credential algorithm is unsupported.");
    const rawPublicKey = canonicalBase64Url(value.publicKey, 32, "publicKey");
    if (!FINGERPRINT_PATTERN.test(value.publicKeyFingerprint) || createHash("sha256").update(rawPublicKey).digest("hex") !== value.publicKeyFingerprint) {
      fail("credentials_corrupt", "The public-key fingerprint is invalid.");
    }
    canonicalDate(value.createdAt, "createdAt");
    canonicalBase64(value.encryptedPrivateKey, "encryptedPrivateKey");
    if (value.state === "enrolled") {
      canonicalUuid(value.deviceId, "deviceId");
      canonicalUuid(value.keyId, "keyId");
      canonicalDate(value.enrolledAt, "enrolledAt");
    }
    return value;
  }

  /** @param {RemoteControlCredentialContext | null} expectedContext @returns {Promise<RemoteControlCredentialRecord | null>} */
  async function loadRecord(expectedContext) {
    secureStorage();
    let raw;
    try {
      raw = await fs.readFile(targetPath, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return null;
      fail("credentials_read_failed", "The device credentials could not be read.", { cause });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      fail("credentials_corrupt", "The device credential file is not valid JSON.", { cause });
    }
    const record = validateRecord(parsed, expectedContext);
    decryptPrivateKey(record);
    return record;
  }

  /** @param {RemoteControlCredentialRecord} record @returns {Promise<void>} */
  async function persistRecord(record) {
    const tempPath = `${targetPath}.${process.pid}.${random(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempPath, targetPath);
    } catch (cause) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      fail("credentials_write_failed", "The device credentials could not be persisted atomically.", { cause });
    }
  }

  /** @param {RemoteControlCredentialContextInput} context @returns {Promise<Readonly<RemoteControlCredentialView>>} */
  async function prepareEnrollmentInternal(context) {
    const expectedContext = normalizeContext(context);
    const existing = await loadRecord(expectedContext);
    if (existing) {
      if (existing.state === "enrolled") fail("already_enrolled", "This context already has an enrolled device credential.");
      return recordView(existing);
    }
    const storage = secureStorage();
    let publicKey;
    let privateKey;
    try {
      ({ publicKey, privateKey } = generate("ed25519"));
    } catch (cause) {
      fail("key_generation_failed", "An Ed25519 device key could not be generated.", { cause });
    }
    const rawPublicKey = publicKeyFromKeyObject(publicKey);
    const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
    let encryptedPrivateKey;
    try {
      encryptedPrivateKey = storage.encryptString(privateDer.toString("base64url"));
    } catch (cause) {
      fail("secure_storage_unavailable", "The Ed25519 device key could not be encrypted.", { cause });
    } finally {
      privateDer.fill(0);
    }
    if (!Buffer.isBuffer(encryptedPrivateKey) || !encryptedPrivateKey.length) {
      fail("secure_storage_unavailable", "Platform secure storage returned an invalid encrypted value.");
    }
    const timestamp = new Date(now());
    if (!Number.isFinite(timestamp.getTime())) fail("invalid_store", "The credential clock returned an invalid time.");
    /** @type {RemoteControlCredentialRecord} */
    const record = {
      schemaVersion: REMOTE_CONTROL_CREDENTIALS_VERSION,
      state: "pending",
      context: expectedContext,
      algorithm: "Ed25519",
      publicKey: rawPublicKey,
      publicKeyFingerprint: publicKeyFingerprint(rawPublicKey),
      encryptedPrivateKey: encryptedPrivateKey.toString("base64"),
      createdAt: timestamp.toISOString(),
    };
    await persistRecord(record);
    return recordView(record);
  }

  /**
   * @param {RemoteControlCredentialContextInput} context
   * @param {RemoteControlEnrollmentBinding} binding
   * @returns {Promise<Readonly<RemoteControlCredentialView>>}
   */
  async function completeEnrollmentInternal(context, binding) {
    const expectedContext = normalizeContext(context);
    const record = await loadRecord(expectedContext);
    if (!record || record.state !== "pending") fail("pending_credentials_missing", "Pending enrollment credentials are unavailable.");
    exactObject(binding, ["deviceId", "keyId", "publicKeyFingerprint", "enrolledAt"], "enrollment binding");
    canonicalUuid(binding.deviceId, "binding.deviceId");
    canonicalUuid(binding.keyId, "binding.keyId");
    canonicalDate(binding.enrolledAt, "binding.enrolledAt");
    if (binding.publicKeyFingerprint !== record.publicKeyFingerprint) {
      fail("credentials_binding_mismatch", "The enrolled Cloud credential does not match the pending device key.");
    }
    /** @type {RemoteControlCredentialRecord} */
    const enrolled = {
      ...record,
      state: "enrolled",
      deviceId: binding.deviceId,
      keyId: binding.keyId,
      enrolledAt: binding.enrolledAt,
    };
    await persistRecord(enrolled);
    return recordView(enrolled);
  }

  return Object.freeze({
    filePath: targetPath,
    inspect: () => serialize(async () => {
      try {
        const record = await loadRecord(null);
        return Object.freeze({ state: record?.state ?? "absent" });
      } catch {
        return Object.freeze({ state: "corrupt" });
      }
    }),
    read: (context) => serialize(async () => {
      const expectedContext = normalizeContext(context);
      const record = await loadRecord(expectedContext);
      return record ? recordView(record) : null;
    }),
    prepareEnrollment: (context) => serialize(() => prepareEnrollmentInternal(context)),
    completeEnrollment: (context, binding) => serialize(() => completeEnrollmentInternal(context, binding)),
    getSigningCredential: (context) => serialize(async () => {
      const expectedContext = normalizeContext(context);
      const record = await loadRecord(expectedContext);
      if (!record || record.state !== "enrolled") fail("credentials_unavailable", "An enrolled device credential is unavailable.");
      return Object.freeze({
        deviceId: record.deviceId,
        keyId: record.keyId,
        publicKey: record.publicKey,
        publicKeyFingerprint: record.publicKeyFingerprint,
        privateKey: decryptPrivateKey(record),
      });
    }),
    delete: () => serialize(async () => {
      try {
        await fs.rm(targetPath, { force: true });
      } catch (cause) {
        fail("credentials_delete_failed", "The device credentials could not be deleted.", { cause });
      }
    }),
  });
}
