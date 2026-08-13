import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const SECRET_NAME = "anthropic_api_key";
const SECRET_NAMES = new Set([
  SECRET_NAME,
  "claude_gateway_credential",
  "aws_bearer_token_bedrock",
  "aws_access_key_id",
  "aws_secret_access_key",
  "aws_session_token",
  "foundry_api_key",
  "foundry_auth_token",
]);

export class ClaudeAnthropicSecretStoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ClaudeAnthropicSecretStoreError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ClaudeAnthropicSecretStoreError(code, message, options);
}

function secureStorage(value, platform) {
  let available = false;
  try {
    available = value?.isEncryptionAvailable?.() === true
      && typeof value.encryptString === "function"
      && typeof value.decryptString === "function";
  } catch {
    available = false;
  }
  if (!available) fail("secure_storage_unavailable", "Platform secure storage encryption is unavailable.");
  if (platform === "linux") {
    let backend = "unknown";
    try { backend = value.getSelectedStorageBackend?.() ?? "unknown"; } catch { /* unavailable */ }
    if (backend === "basic_text" || backend === "unknown") {
      fail("secure_storage_degraded", "Linux secure storage is not backed by an eligible secret store.");
    }
  }
  return value;
}

function validateSecret(value) {
  if (typeof value !== "string" || !value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
    fail("secret_invalid", "Claude provider credential is invalid.");
  }
  return value;
}

/**
 * @param {{
 *   app?: { getPath(name: string): string },
 *   filePath?: string,
 *   safeStorage?: any,
 *   getSafeStorage?: () => any,
 *   platform?: NodeJS.Platform,
 *   fileSystem?: any,
 * }} [options]
 */
export function createClaudeAnthropicSecretStore(options = {}) {
  const {
    app,
    filePath,
    safeStorage,
    getSafeStorage,
    platform = process.platform,
    fileSystem = {},
  } = options;
  if (!filePath && !app?.getPath) fail("invalid_store", "A credential file path or Electron app is required.");
  const targetPath = filePath ?? path.join(app.getPath("userData"), "claude-anthropic-byok.json");
  const fs = {
    mkdir: fileSystem.mkdir ?? mkdir,
    readFile: fileSystem.readFile ?? readFile,
    rename: fileSystem.rename ?? rename,
    rm: fileSystem.rm ?? rm,
    writeFile: fileSystem.writeFile ?? writeFile,
  };
  let operation = Promise.resolve();

  function storage() {
    return secureStorage(getSafeStorage?.() ?? safeStorage, platform);
  }

  function serialize(action) {
    const next = operation.then(action, action);
    operation = next.then(() => undefined, () => undefined);
    return next;
  }

  function validateName(name) {
    if (!SECRET_NAMES.has(name)) fail("secret_invalid", "Claude provider credential name is invalid.");
    return name;
  }

  function pathFor(name) {
    return name === SECRET_NAME ? targetPath : `${targetPath}.${name}`;
  }

  async function readRecord(name) {
    let raw;
    try {
      raw = await fs.readFile(pathFor(name), "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return null;
      fail("secret_read_failed", "Claude provider credentials could not be read.", { cause });
    }
    let record;
    try { record = JSON.parse(raw); } catch (cause) {
      fail("secret_corrupt", "Claude provider credential metadata is invalid.", { cause });
    }
    if (
      !record || record.version !== STORE_VERSION || record.name !== name
      || typeof record.encryptedValue !== "string" || !record.encryptedValue
      || Object.keys(record).sort().join(",") !== "encryptedValue,name,version"
    ) fail("secret_corrupt", "Claude provider credential metadata is invalid.");
    return record;
  }

  async function persist(record) {
    const recordPath = pathFor(record.name);
    const tempPath = `${recordPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(path.dirname(recordPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempPath, recordPath);
    } catch (cause) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      fail("secret_write_failed", "Claude provider credentials could not be stored.", { cause });
    }
  }

  return Object.freeze({
    filePath: targetPath,
    getSecret: (name) => serialize(async () => {
      if (!SECRET_NAMES.has(name)) return null;
      const record = await readRecord(name);
      if (!record) return null;
      try {
        return validateSecret(storage().decryptString(Buffer.from(record.encryptedValue, "base64")));
      } catch (cause) {
        if (cause instanceof ClaudeAnthropicSecretStoreError) throw cause;
        fail("secret_corrupt", "Claude provider credentials could not be decrypted.", { cause });
      }
    }),
    setSecret: (nameOrSecret, value) => serialize(async () => {
      const name = value === undefined ? SECRET_NAME : validateName(nameOrSecret);
      const secret = value === undefined ? nameOrSecret : value;
      const plaintext = validateSecret(secret);
      let encrypted;
      try { encrypted = storage().encryptString(plaintext); } catch (cause) {
        if (cause instanceof ClaudeAnthropicSecretStoreError) throw cause;
        fail("secure_storage_unavailable", "Claude provider credentials could not be encrypted.", { cause });
      }
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
        fail("secure_storage_unavailable", "Platform secure storage returned an invalid encrypted value.");
      }
      await persist({ version: STORE_VERSION, name, encryptedValue: encrypted.toString("base64") });
    }),
    deleteSecret: (name = SECRET_NAME) => serialize(async () => {
      validateName(name);
      try { await fs.rm(pathFor(name), { force: true }); } catch (cause) {
        fail("secret_delete_failed", "Claude provider credentials could not be deleted.", { cause });
      }
    }),
    readiness: (name = SECRET_NAME) => serialize(async () => {
      try {
        validateName(name);
        const record = await readRecord(name);
        if (!record) return { ready: false, reasonCode: "credential_missing" };
        storage().decryptString(Buffer.from(record.encryptedValue, "base64"));
        return { ready: true, reasonCode: "credential_ready" };
      } catch {
        return { ready: false, reasonCode: "credential_store_unavailable" };
      }
    }),
  });
}
