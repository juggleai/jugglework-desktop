import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const REMOTE_CONTROL_CAPABILITY_PROFILE_VERSION = 1;

const MAX_LIST_ENTRIES = 32;
const MAX_URL_LENGTH = 2_048;
const MAX_IDENTIFIER_LENGTH = 128;
// Feature names and operation names are protocol identifiers.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * @typedef {{
 *   schemaVersion: 1,
 *   controlPlaneBaseUrl: string,
 *   appVersion: string,
 *   policyVersion: string,
 *   dropFeatures: string[],
 *   dropOperations: string[],
 *   acceptedAt: string,
 * }} RemoteControlCapabilityProfileRecord
 */

/** @param {unknown} value @param {string} label @returns {string[]} */
function canonicalIdentifierList(value, label) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
    throw new TypeError(`${label} must be a bounded array.`);
  }
  const seen = new Set();
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(entry) || seen.has(entry)) {
      throw new TypeError(`${label} contains an invalid identifier.`);
    }
    seen.add(entry);
    return entry;
  });
}

/** @param {unknown} value @param {string} label @returns {string} */
function canonicalText(value, label, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @returns {string} */
function canonicalTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("acceptedAt must be an RFC 3339 timestamp.");
  }
  return value;
}

/** @param {unknown} value @returns {RemoteControlCapabilityProfileRecord} */
export function normalizeRemoteControlCapabilityProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The capability profile must be an object.");
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record).sort();
  const expected = ["acceptedAt", "appVersion", "controlPlaneBaseUrl", "dropFeatures", "dropOperations", "policyVersion", "schemaVersion"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("The capability profile contains missing or unknown fields.");
  }
  if (record.schemaVersion !== REMOTE_CONTROL_CAPABILITY_PROFILE_VERSION) {
    throw new TypeError("The capability profile schema version is unsupported.");
  }
  return {
    schemaVersion: REMOTE_CONTROL_CAPABILITY_PROFILE_VERSION,
    controlPlaneBaseUrl: canonicalText(record.controlPlaneBaseUrl, "controlPlaneBaseUrl", MAX_URL_LENGTH),
    appVersion: canonicalText(record.appVersion, "appVersion", 64),
    policyVersion: canonicalText(record.policyVersion, "policyVersion", 256),
    dropFeatures: canonicalIdentifierList(record.dropFeatures, "dropFeatures"),
    dropOperations: canonicalIdentifierList(record.dropOperations, "dropOperations"),
    acceptedAt: canonicalTimestamp(record.acceptedAt),
  };
}

/**
 * Persist the capability subset that the current control plane actually
 * accepted, so later reconnects skip the rejected advertisement instead of
 * replaying the closing handshake. The record is bound to the control plane,
 * app version, and policy version, and is only a hint: any read or parse
 * failure degrades to the full advertisement.
 *
 * @param {{
 *   app?: { getPath(name: string): string } | null,
 *   filePath?: string,
 *   fileSystem?: Partial<Pick<typeof import("node:fs/promises"), "mkdir" | "readFile" | "rename" | "rm" | "writeFile">>
 * }} options
 */
export function createRemoteControlCapabilityProfileStore({ app, filePath, fileSystem = {} } = {}) {
  if (!filePath && (!app || typeof app.getPath !== "function")) {
    throw new TypeError("A capability profile file path or Electron app is required.");
  }
  const targetPath = filePath ?? path.join(app.getPath("userData"), "desktop-remote-capability-profile.json");
  const fs = {
    mkdir: fileSystem.mkdir ?? mkdir,
    readFile: fileSystem.readFile ?? readFile,
    rename: fileSystem.rename ?? rename,
    rm: fileSystem.rm ?? rm,
    writeFile: fileSystem.writeFile ?? writeFile,
  };
  let operation = Promise.resolve();

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  function serialize(work) {
    const next = operation.then(work, work);
    operation = next.then(() => undefined, () => undefined);
    return next;
  }

  return Object.freeze({
    filePath: targetPath,
    /** @returns {Promise<Readonly<RemoteControlCapabilityProfileRecord> | null>} Never throws. */
    read: () => serialize(async () => {
      let raw;
      try {
        raw = await fs.readFile(targetPath, "utf8");
      } catch {
        return null;
      }
      try {
        return Object.freeze(normalizeRemoteControlCapabilityProfile(JSON.parse(raw)));
      } catch {
        return null;
      }
    }),
    /** @param {unknown} input @returns {Promise<Readonly<RemoteControlCapabilityProfileRecord>>} */
    write: (input) => serialize(async () => {
      const record = normalizeRemoteControlCapabilityProfile(input);
      const tempPath = `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.rename(tempPath, targetPath);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return Object.freeze(record);
    }),
    clear: () => serialize(async () => {
      await fs.rm(targetPath, { force: true }).catch(() => undefined);
    }),
  });
}
