import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { REMOTE_CONTROL_OPERATION_NAMES } from "./remote-control-operations.mjs";

export const REMOTE_CONTROL_COMMAND_JOURNAL_VERSION = 1;

/** @typedef {"journal_unavailable" | "journal_corrupt" | "journal_version_unsupported" | "journal_full" | "invalid_request"} RemoteControlCommandJournalErrorCode */
/** @typedef {unknown} JsonValue */
/** @typedef {{ maxEntries: number, maxFileBytes: number, maxResultBytes: number }} RemoteControlCommandJournalLimits */
/** @typedef {{ status: string, occurredAt: string, result: JsonValue, error: JsonValue }} RemoteControlCommandLifecycle */
/** @typedef {{ commandId: string, deviceId: string, idempotencyKey: string | null, payloadHash: string, operation: string, createdAt: string, expiresAt: string, state: "dispatching" | "terminal", lifecycle: RemoteControlCommandLifecycle | null }} RemoteControlCommandJournalEntry */
/** @typedef {{ commandId: string, deviceId: string, idempotencyKey: string | null, payloadHash: string, operation: string, createdAt: string, expiresAt: string }} RemoteControlCommandJournalCommand */
/** @typedef {{ code: string, message: string, retryable: false }} RemoteControlCommandRejectionError */
/** @typedef {{ action: "reject", commandId: string | null, error: RemoteControlCommandRejectionError }} RemoteControlCommandRejectResult */
/** @typedef {{ action: "execute", commandId: string }} RemoteControlCommandExecuteResult */
/** @typedef {{ action: "replay", commandId: string, lifecycle: RemoteControlCommandLifecycle }} RemoteControlCommandReplayResult */
/** @typedef {RemoteControlCommandRejectResult | RemoteControlCommandExecuteResult | RemoteControlCommandReplayResult} RemoteControlCommandPrepareResult */
/** @typedef {{ action: "recorded", commandId: string, lifecycle: RemoteControlCommandLifecycle } | RemoteControlCommandReplayResult} RemoteControlCommandCompleteResult */
/** @typedef {{ schemaVersion: number, entries: RemoteControlCommandJournalEntry[] }} RemoteControlCommandJournalDocument */
/**
 * @typedef {{
 *   mkdir(path: string, options: { recursive: true }): Promise<string | undefined | void>,
 *   readFile(path: string, encoding: "utf8"): Promise<string>,
 *   rename(oldPath: string, newPath: string): Promise<void>,
 *   rm(path: string, options: { force: true }): Promise<void>,
 *   writeFile(path: string, data: string, options: { encoding: "utf8", mode: number }): Promise<void>
 * }} RemoteControlCommandJournalFileSystem
 */
/** @typedef {{ app?: { getPath(name: string): string } | null, filePath?: string, now?: () => number, limits?: Partial<RemoteControlCommandJournalLimits>, randomBytes?: (size: number) => Buffer, fileSystem?: Partial<RemoteControlCommandJournalFileSystem> }} RemoteControlCommandJournalOptions */
/** @typedef {{ filePath: string, prepare(command: unknown): Promise<RemoteControlCommandPrepareResult>, complete(commandId: unknown, lifecycle: unknown): Promise<RemoteControlCommandCompleteResult>, cleanupExpired(): Promise<number>, inspect(): Promise<RemoteControlCommandJournalDocument> }} RemoteControlCommandJournal */

/** @type {Readonly<RemoteControlCommandJournalLimits>} */
export const REMOTE_CONTROL_COMMAND_JOURNAL_DEFAULT_LIMITS = Object.freeze({
  maxEntries: 1_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxResultBytes: 512 * 1024,
});

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rejected", "expired", "cancelled"]);
const MUTATION_OPERATIONS = new Set([
  "session.create",
  "session.prompt",
  "session.abort",
  "interaction.permission.reply",
  "interaction.question.reply",
]);
const ROOT_KEYS = ["schemaVersion", "entries"];
const ENTRY_KEYS = [
  "commandId",
  "deviceId",
  "idempotencyKey",
  "payloadHash",
  "operation",
  "createdAt",
  "expiresAt",
  "state",
  "lifecycle",
];
const LIFECYCLE_KEYS = ["status", "occurredAt", "result", "error"];
const CREDENTIAL_FIELD = /^(?:authorization|cookie|credentials?|password|secret|tokens?|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token)$/i;

/** @type {Readonly<Record<RemoteControlCommandJournalErrorCode, string>>} */
const JOURNAL_ERROR_MESSAGES = Object.freeze({
  journal_unavailable: "The command journal is unavailable.",
  journal_corrupt: "The command journal is invalid and has been refused.",
  journal_version_unsupported: "The command journal version is not supported.",
  journal_full: "The command journal capacity has been reached.",
  invalid_request: "The command journal request is invalid.",
});

export class RemoteControlCommandJournalError extends Error {
  /** @param {RemoteControlCommandJournalErrorCode} code */
  constructor(code) {
    super(JOURNAL_ERROR_MESSAGES[code]);
    this.name = "RemoteControlCommandJournalError";
    this.code = code;
  }
}

/** @param {RemoteControlCommandJournalErrorCode} code */
function journalError(code) {
  return new RemoteControlCommandJournalError(code);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {readonly string[]} keys */
function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** @param {unknown} value @returns {value is string} */
function isIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** @param {unknown} value @returns {value is string} */
function isTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** @param {unknown} value @returns {value is string} */
function isPayloadHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** @param {unknown} value @param {Set<object>} [seen] @returns {value is JsonValue} */
function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

/** @param {unknown} value */
function containsCredentialField(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCredentialField);
  return Object.entries(value).some(
    ([key, child]) => CREDENTIAL_FIELD.test(key) || containsCredentialField(child),
  );
}

/** @param {unknown} value */
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** @template T @param {T} value @returns {T} */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {unknown} value @param {number} maxResultBytes @returns {value is RemoteControlCommandLifecycle} */
function isLifecycle(value, maxResultBytes) {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, LIFECYCLE_KEYS) ||
    typeof value.status !== "string" ||
    !TERMINAL_STATUSES.has(value.status)
  ) return false;
  if (!isTimestamp(value.occurredAt) || !isJsonValue(value.result) || !isJsonValue(value.error)) return false;
  if (containsCredentialField(value.result) || containsCredentialField(value.error)) return false;
  if (jsonBytes(value.result) > maxResultBytes || jsonBytes(value.error) > maxResultBytes) return false;
  if (value.status === "succeeded") return value.result !== null && value.error === null;
  return value.result === null && isRecord(value.error);
}

/** @param {unknown} value @param {number} maxResultBytes @returns {value is RemoteControlCommandJournalEntry} */
function isEntry(value, maxResultBytes) {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ENTRY_KEYS)) return false;
  if (
    !isIdentifier(value.commandId) ||
    !isIdentifier(value.deviceId) ||
    !(value.idempotencyKey === null || isIdentifier(value.idempotencyKey)) ||
    !isPayloadHash(value.payloadHash) ||
    typeof value.operation !== "string" ||
    !REMOTE_CONTROL_OPERATION_NAMES.includes(value.operation) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.expiresAt)
  ) {
    return false;
  }
  if (MUTATION_OPERATIONS.has(value.operation) && value.idempotencyKey === null) return false;
  if (value.state === "dispatching") return value.lifecycle === null;
  return value.state === "terminal" && isLifecycle(value.lifecycle, maxResultBytes);
}

/** @param {Partial<RemoteControlCommandJournalLimits> | undefined} input @returns {Readonly<RemoteControlCommandJournalLimits>} */
function validateLimits(input) {
  const limits = { ...REMOTE_CONTROL_COMMAND_JOURNAL_DEFAULT_LIMITS, ...input };
  for (const key of Object.keys(REMOTE_CONTROL_COMMAND_JOURNAL_DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) {
      throw new TypeError(`Command journal ${key} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

/** @param {string} code @param {string} message @param {string | null} [commandId] @returns {RemoteControlCommandRejectResult} */
function rejectResult(code, message, commandId = null) {
  return {
    action: "reject",
    commandId,
    error: { code, message, retryable: false },
  };
}

/** @param {RemoteControlCommandJournalEntry[]} entries @param {RemoteControlCommandJournalCommand} command @returns {RemoteControlCommandJournalEntry | null} */
function findExisting(entries, command) {
  const byCommandId = entries.find((entry) => entry.commandId === command.commandId);
  if (byCommandId) return byCommandId;
  if (command.idempotencyKey === null) return null;
  return entries.find(
    (entry) =>
      entry.deviceId === command.deviceId && entry.idempotencyKey === command.idempotencyKey,
  ) ?? null;
}

/**
 * @param {RemoteControlCommandJournalOptions} options
 * @returns {RemoteControlCommandJournal}
 */
export function createRemoteControlCommandJournal({
  app = null,
  filePath,
  now = Date.now,
  limits: limitOverrides,
  randomBytes: createRandomBytes = randomBytes,
  fileSystem = {},
} = {}) {
  if (!filePath && !app) throw new TypeError("Command journal requires app or filePath.");
  if (typeof now !== "function" || typeof createRandomBytes !== "function") {
    throw new TypeError("Command journal clock and random source must be functions.");
  }

  const targetPath = filePath ?? path.join(app.getPath("userData"), "desktop-remote-command-journal.json");
  const limits = validateLimits(limitOverrides);
  /** @type {RemoteControlCommandJournalFileSystem} */
  const fs = {
    mkdir: fileSystem.mkdir ?? mkdir,
    readFile: fileSystem.readFile ?? readFile,
    rename: fileSystem.rename ?? rename,
    rm: fileSystem.rm ?? rm,
    writeFile: fileSystem.writeFile ?? writeFile,
  };
  /** @type {RemoteControlCommandJournalEntry[]} */
  let entries = [];
  let loaded = false;
  /** @type {RemoteControlCommandJournalError | null} */
  let blockedError = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  function serialized(work) {
    const pending = queue.then(() => work(), () => work());
    queue = pending.catch(() => undefined);
    return pending;
  }

  /** @param {RemoteControlCommandJournalEntry[]} nextEntries @returns {Promise<void>} */
  async function persist(nextEntries) {
    const document = {
      schemaVersion: REMOTE_CONTROL_COMMAND_JOURNAL_VERSION,
      entries: nextEntries,
    };
    const serializedDocument = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serializedDocument, "utf8") > limits.maxFileBytes) {
      throw journalError("journal_full");
    }

    const tempPath = `${targetPath}.${process.pid}.${createRandomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(tempPath, serializedDocument, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempPath, targetPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof RemoteControlCommandJournalError) throw error;
      throw journalError("journal_unavailable");
    }
  }

  /** @param {RemoteControlCommandJournalErrorCode} code @returns {never} */
  function block(code) {
    blockedError = journalError(code);
    throw blockedError;
  }

  /** @returns {Promise<void>} */
  async function ensureLoaded() {
    if (blockedError) throw blockedError;
    if (loaded) return;

    let raw;
    try {
      raw = await fs.readFile(targetPath, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        entries = [];
        loaded = true;
        return;
      }
      block("journal_unavailable");
    }

    if (Buffer.byteLength(raw, "utf8") > limits.maxFileBytes) block("journal_full");

    /** @type {unknown} */
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      block("journal_corrupt");
    }
    if (!isRecord(document)) block("journal_corrupt");
    if (document.schemaVersion !== REMOTE_CONTROL_COMMAND_JOURNAL_VERSION) {
      block(
        typeof document.schemaVersion === "number" &&
          Number.isInteger(document.schemaVersion) &&
          document.schemaVersion > REMOTE_CONTROL_COMMAND_JOURNAL_VERSION
          ? "journal_version_unsupported"
          : "journal_corrupt",
      );
    }
    if (!hasExactKeys(document, ROOT_KEYS) || !Array.isArray(document.entries)) block("journal_corrupt");
    if (document.entries.length > limits.maxEntries) block("journal_full");
    try {
      if (!document.entries.every((entry) => isEntry(entry, limits.maxResultBytes))) {
        block("journal_corrupt");
      }
    } catch (error) {
      if (error instanceof RemoteControlCommandJournalError) throw error;
      block("journal_corrupt");
    }

    const commandIds = new Set();
    const idempotencyKeys = new Set();
    for (const entry of document.entries) {
      if (commandIds.has(entry.commandId)) block("journal_corrupt");
      commandIds.add(entry.commandId);
      if (entry.idempotencyKey !== null) {
        const key = `${entry.deviceId}\u0000${entry.idempotencyKey}`;
        if (idempotencyKeys.has(key)) block("journal_corrupt");
        idempotencyKeys.add(key);
      }
    }

    entries = cloneJson(document.entries);
    loaded = true;
    const retained = entries.filter((entry) => Date.parse(entry.expiresAt) > now());
    if (retained.length !== entries.length) {
      await persist(retained);
      entries = retained;
    }
  }

  /** @param {unknown} command @returns {RemoteControlCommandJournalEntry | null} */
  function validateCommand(command) {
    if (!isRecord(command)) return null;
    /** @type {unknown} */
    const normalized = {
      commandId: command.commandId,
      deviceId: command.deviceId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      operation: command.operation,
      createdAt: command.createdAt,
      expiresAt: command.expiresAt,
      state: "dispatching",
      lifecycle: null,
    };
    return isEntry(normalized, limits.maxResultBytes) ? normalized : null;
  }

  /** @param {unknown} command @returns {Promise<RemoteControlCommandPrepareResult>} */
  async function prepare(command) {
    return serialized(async () => {
      await ensureLoaded();
      const normalized = validateCommand(command);
      if (!normalized) {
        return rejectResult("invalid_request", "The command journal request is invalid.");
      }
      if (Date.parse(normalized.expiresAt) <= now()) {
        return rejectResult("command_expired", "The remote command has expired.", normalized.commandId);
      }

      const retained = entries.filter((entry) => Date.parse(entry.expiresAt) > now());
      if (retained.length !== entries.length) {
        await persist(retained);
        entries = retained;
      }

      const existing = findExisting(entries, normalized);
      if (existing) {
        if (existing.payloadHash !== normalized.payloadHash) {
          return rejectResult(
            "idempotency_conflict",
            "The command key was already used with a different payload hash.",
            existing.commandId,
          );
        }
        if (existing.state === "terminal") {
          return {
            action: "replay",
            commandId: existing.commandId,
            lifecycle: cloneJson(existing.lifecycle),
          };
        }
        return rejectResult(
          "delivery_failed",
          "The command outcome is indeterminate; execution was not repeated.",
          existing.commandId,
        );
      }

      if (entries.length >= limits.maxEntries) throw journalError("journal_full");
      const nextEntries = [...entries, normalized];
      await persist(nextEntries);
      entries = nextEntries;
      return { action: "execute", commandId: normalized.commandId };
    });
  }

  /** @param {unknown} commandId @param {unknown} lifecycle @returns {Promise<RemoteControlCommandCompleteResult>} */
  async function complete(commandId, lifecycle) {
    return serialized(async () => {
      await ensureLoaded();
      if (!isIdentifier(commandId) || !isLifecycle(lifecycle, limits.maxResultBytes)) {
        throw journalError("invalid_request");
      }
      const index = entries.findIndex((entry) => entry.commandId === commandId);
      if (index < 0) throw journalError("invalid_request");
      if (entries[index].state === "terminal") {
        return { action: "replay", commandId, lifecycle: cloneJson(entries[index].lifecycle) };
      }

      const storedLifecycle = cloneJson(lifecycle);
      /** @type {RemoteControlCommandJournalEntry[]} */
      const nextEntries = entries.map((entry, entryIndex) =>
        entryIndex === index
          ? { ...entry, state: /** @type {const} */ ("terminal"), lifecycle: storedLifecycle }
          : entry,
      );
      await persist(nextEntries);
      entries = nextEntries;
      return { action: "recorded", commandId, lifecycle: cloneJson(storedLifecycle) };
    });
  }

  /** @returns {Promise<number>} */
  async function cleanupExpired() {
    return serialized(async () => {
      await ensureLoaded();
      const retained = entries.filter((entry) => Date.parse(entry.expiresAt) > now());
      const removed = entries.length - retained.length;
      if (removed > 0) {
        await persist(retained);
        entries = retained;
      }
      return removed;
    });
  }

  /** @returns {Promise<RemoteControlCommandJournalDocument>} */
  async function inspect() {
    return serialized(async () => {
      await ensureLoaded();
      return {
        schemaVersion: REMOTE_CONTROL_COMMAND_JOURNAL_VERSION,
        entries: cloneJson(entries),
      };
    });
  }

  return Object.freeze({
    filePath: targetPath,
    prepare,
    complete,
    cleanupExpired,
    inspect,
  });
}
