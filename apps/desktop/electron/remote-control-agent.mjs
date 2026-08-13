import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { desktopRemoteSessionEventSchema } from "../dist/runtime/desktop-remote-control.js";
import {
  canonicalRemoteControlAAD,
  createSignedRemoteControlE2EEKeyAdvertisement,
  decryptRemoteControlPayload,
  deriveRemoteControlE2EEKey,
  encryptRemoteControlPayload,
} from "./remote-control-e2ee.mjs";

export const REMOTE_CONTROL_AGENT_SCHEMA_VERSION = 1;
export const REMOTE_CONTROL_AGENT_PROTOCOL_VERSION = 1;
export const REMOTE_CONTROL_AGENT_PAYLOAD_VERSION = 1;

export const REMOTE_CONTROL_AGENT_STATUS = Object.freeze({
  STOPPED: "stopped",
  DISABLED: "disabled",
  WAITING_FOR_CONTEXT: "waiting_for_context",
  UNENROLLED: "unenrolled",
  CONNECTING: "connecting",
  AWAITING_WELCOME: "awaiting_welcome",
  CONNECTED: "connected",
  BACKOFF: "backoff",
  REVOKED: "revoked",
  ERROR: "error",
});

const FEATURE_GATE_KEYS = Object.freeze([
  "enrollment",
  "readOnlyControl",
  "sessionMutation",
  "interactions",
  "backgroundLifecycle",
  "eventCompaction",
  "multiInstanceRouting",
  "payloadEncryption",
  "busySessionSteer",
  "busySessionEnqueue",
  "nativeMobile",
]);
const OPERATION_NAMES = new Set([
  "workspace.list",
  "session.list",
  "session.snapshot",
  "session.create",
  "session.prompt",
  "session.abort",
  "session.pending.cancel",
  "interaction.permission.reply",
  "interaction.question.reply",
]);
const FEATURE_NAMES = new Set([
  "controller.event-resume",
  "payload.e2ee-v1",
  "background.lifecycle",
  "session.steer",
  "session.enqueue",
  "native-mobile",
]);
const MUTATION_OPERATIONS = new Set([
  "session.create",
  "session.prompt",
  "session.abort",
  "session.pending.cancel",
  "interaction.permission.reply",
  "interaction.question.reply",
]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rejected", "expired", "cancelled"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_TIMER_DELAY = 24 * 60 * 60 * 1_000;
const TOKEN_REFRESH_MARGIN = 60_000;
const RECONNECT_MAX_DELAY = 30_000;
const DEFAULT_POLICY_MAX_AGE_MS = 6 * 60_000;
const DEFAULT_LOCAL_STOP_ACK_TIMEOUT_MS = 1_500;
const MAX_ACTIVE_RUNS = 100;
const MAX_CONTROLLER_DISPLAY_NAME_LENGTH = 80;
const MAX_CONTROLLER_DISPLAY_NAMES = 5;
const ACTIVE_RUN_STATUSES = new Set(["started", "running", "waiting", "retrying", "aborting"]);

const ERROR_MESSAGES = Object.freeze({
  invalid_request: "The remote operation request is invalid.",
  unauthorized: "The remote operation is not authorized.",
  forbidden: "The remote operation is denied by policy.",
  feature_disabled: "The remote operation is disabled.",
  policy_unavailable: "Remote operation policy is unavailable.",
  secure_storage_unavailable: "Secure device storage is unavailable.",
  device_not_found: "The remote device was not found.",
  device_revoked: "The remote device was revoked.",
  device_offline: "The remote device is offline.",
  device_stale: "The remote device connection is stale.",
  protocol_version_unsupported: "The remote-control protocol version is not supported.",
  payload_version_unsupported: "The remote operation payload version is not supported.",
  operation_unsupported: "The remote operation is not supported.",
  capability_not_advertised: "The remote operation was not advertised.",
  control_session_not_found: "The remote control session was not found.",
  control_session_expired: "The remote control session expired.",
  workspace_not_found: "The workspace was not found.",
  session_not_found: "The session was not found.",
  session_busy: "The session is busy.",
  run_mismatch: "The active run does not match the requested run.",
  interaction_not_found: "The interaction was not found.",
  interaction_expired: "The interaction expired.",
  already_resolved: "The interaction was already resolved.",
  persistent_permission_unsupported: "Persistent permission changes are not supported remotely.",
  idempotency_conflict: "The command key conflicts with a prior command.",
  command_expired: "The remote command has expired.",
  command_cancelled: "The remote command was cancelled.",
  delivery_failed: "The remote command outcome is unavailable.",
  snapshot_required: "A fresh session snapshot is required.",
  rate_limited: "The remote operation was rate limited.",
  internal_error: "The remote operation failed.",
});

/** @typedef {keyof typeof ERROR_MESSAGES} RemoteControlErrorCode */
/** @typedef {{ schemaVersion: 1, enrollment: boolean, readOnlyControl: boolean, sessionMutation: boolean, interactions: boolean, backgroundLifecycle: boolean, eventCompaction: boolean, multiInstanceRouting: boolean, payloadEncryption: boolean, busySessionSteer: boolean, busySessionEnqueue: boolean, nativeMobile: boolean }} RemoteControlFeatureGates */
/** @typedef {{ schemaVersion: 1, signedIn: boolean, controlPlaneBaseUrl: string | null, userId: string | null, organizationId: string | null, policyFresh: boolean, featureGates: RemoteControlFeatureGates, policyVersion: string | null, validatedAt: string | null }} RemoteControlAgentContext */
/** @typedef {{ schemaVersion: number, enabled: boolean, backgroundMode: boolean, launchAtLogin: boolean, allowBusySessionSteer: boolean, allowBusySessionEnqueue: boolean }} RemoteControlSettings */
/** @typedef {{ schemaVersion: number, state: string, context: { controlPlaneBaseUrl: string, userId: string, organizationId: string }, deviceId?: string }} RemoteControlCredentialView */
/** @typedef {{ schemaVersion: number, operations: Array<{ operation: string, payloadVersions: number[] }>, features: string[] }} RemoteControlCapabilities */
/** @typedef {{ status: string, occurredAt: string, result: unknown, error: unknown }} JournalLifecycle */
/** @typedef {{ action: "execute", commandId: string } | { action: "replay", commandId: string, lifecycle: JournalLifecycle } | { action: "reject", commandId: string | null, error: { code: string, message: string, retryable: false } }} JournalPrepareResult */
/** @typedef {{ accessToken: string, expiresAt: string, webSocketUrl: string }} AgentToken */
/** @typedef {{ enrollDevice(input: { credentials: RemoteControlCredentialStore, context: { controlPlaneBaseUrl: string, userId: string, organizationId: string }, grant: string, displayName: string, platform: string }): Promise<RemoteControlCredentialView>, issueAgentToken(input: { credentials: RemoteControlCredentialStore, context: { controlPlaneBaseUrl: string, userId: string, organizationId: string } }): Promise<AgentToken> }} RemoteControlCloudClient */
/** @typedef {{ read(context: object): Promise<RemoteControlCredentialView | null>, prepareEnrollment(context: object): Promise<unknown>, completeEnrollment(context: object, binding: object): Promise<unknown>, getSigningCredential(context: object): Promise<unknown>, delete(): Promise<void> }} RemoteControlCredentialStore */
/** @typedef {{ read(): Promise<RemoteControlSettings> }} RemoteControlSettingsStore */
/** @typedef {{ advertise(context?: unknown): Promise<RemoteControlCapabilities>, dispatch(request: unknown, options: { advertisedCapabilities: RemoteControlCapabilities, context: RemoteControlAgentContext, correlationId: string }): Promise<{ ok: boolean, value?: unknown, error?: unknown }> }} RemoteControlOperationRegistry */
/** @typedef {{ prepare(command: unknown): Promise<JournalPrepareResult>, complete(commandId: unknown, lifecycle: unknown): Promise<unknown> }} RemoteControlCommandJournal */
/** @typedef {{ on(event: string, listener: (...args: any[]) => void): unknown, send(data: string): unknown, close(...args: any[]): unknown, __remoteHeartbeatSeconds?: number }} RemoteControlSocket */
/** @typedef {{ setTimeout(callback: (...args: any[]) => void, delay?: number): unknown, clearTimeout(handle: unknown): void }} RemoteControlTimers */
/** @typedef {{ debug?: (message: string, metadata?: object) => void, info?: (message: string, metadata?: object) => void, warn?: (message: string, metadata?: object) => void, error?: (message: string, metadata?: object) => void }} RemoteControlLogger */
/**
 * @typedef {{
 *   settingsStore: RemoteControlSettingsStore,
 *   credentialStore: RemoteControlCredentialStore,
 *   e2eeKeyStore?: { active(): Promise<{ keyId: string, publicKey: string, algorithm: string, createdAt: string }>, advertisement(keyId: string): Promise<{ keyId: string, publicKey: string, algorithm: string, createdAt: string }>, privateKey(keyId: string): Promise<unknown>, revokeAll(): Promise<void> },
 *   operationRegistry: RemoteControlOperationRegistry,
 *   commandJournal: RemoteControlCommandJournal,
 *   createCloudClient(controlPlaneBaseUrl: string): RemoteControlCloudClient,
 *   createWebSocket(input: { url: string, accessToken: string }): RemoteControlSocket,
 *   appVersion: string,
 *   platform: "darwin" | "windows" | "linux",
 *   getDisplayName(): string | Promise<string>,
 *   now?: () => Date,
 *   randomUUID?: () => string,
 *   timers?: RemoteControlTimers,
 *   logger?: RemoteControlLogger,
 *   allowInsecureLoopback?: boolean,
 *   policyMaxAgeMs?: number,
 *   localStopAckTimeoutMs?: number,
 *   getActiveRuns?: () => unknown,
 *   onSessionBinding?: (binding: { controlSessionId: string, deviceId: string, workspaceId: string, sessionId: string, connectionGeneration: number }) => boolean | void,
 *   onSessionUnbound?: (input: { controlSessionId: string, reason: "closed" | "expired" | "not_found" | "snapshot_required" }) => void,
 *   onTransportReset?: (input: { hadActiveControl: boolean, transition: number | null }) => void,
 *   onControlRevoked?: (input: { source: "local" | "cloud", transition: number }) => void,
 *   onPolicyExpired?: () => void,
 *   onAuthorizationChanged?: (authorized: boolean) => void,
 * }} RemoteControlAgentOptions
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {readonly string[]} keys @returns {value is Record<string, any>} */
function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** @param {unknown} value */
function isIdentifier(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** @param {unknown} code @param {unknown} reason */
function transportCloseErrorCode(code, reason) {
  const closeCode = typeof code === "number" && Number.isSafeInteger(code) && code >= 1000 && code <= 4999 ? code : null;
  const text = Buffer.isBuffer(reason) || reason instanceof Uint8Array
    ? Buffer.from(reason).toString("utf8")
    : typeof reason === "string" ? reason : "";
  const safeReason = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  if (closeCode === null) return "transport_closed";
  return safeReason ? `transport_closed_${closeCode}_${safeReason}` : `transport_closed_${closeCode}`;
}

/** @param {unknown} value */
function isDisplayText(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 500 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/** @param {unknown} value */
function isSessionCreateTitle(value) {
  if (typeof value !== "string" || value.trim() !== value || /\p{Cc}/u.test(value)) return false;
  let scalarCount = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff) || ++scalarCount > 120) return false;
  }
  return scalarCount >= 1;
}

/** @param {unknown} value */
function isTimestamp(value) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : null;
  if (!match || typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] &&
    Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59 &&
    (offsetHourText === undefined || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59));
}

/** @param {unknown} value */
function canonicalControlPlaneUrl(value, allowInsecureLoopback = false) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Remote-control context has an invalid control plane.");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("Remote-control context has an invalid control plane.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== "https:" && !(allowInsecureLoopback && url.protocol === "http:" && loopback)) ||
    url.username || url.password || url.search || url.hash) {
    throw new TypeError("Remote-control context has an invalid control plane.");
  }
  const inputPath = url.pathname.replace(/\/+$/, "") || "/";
  if (inputPath === "/" || inputPath === "/jwork") url.pathname = "/jwork/api";
  else if (inputPath === "/jwork/api" || inputPath === "/api/den") url.pathname = inputPath;
  else throw new TypeError("Remote-control context has an invalid control plane.");
  return url.toString().replace(/\/$/, "");
}

/**
 * Strictly normalizes the complete renderer-to-Main remote-control context.
 * Missing, partial, future-version, or expanded documents throw instead of
 * inheriting enabled policy values. Signed-out contexts must clear identity.
 * @param {unknown} input
 * @returns {Readonly<RemoteControlAgentContext>}
 */
export function normalizeRemoteControlAgentContext(input, { allowInsecureLoopback = false } = {}) {
  const contextKeys = [
    "schemaVersion", "signedIn", "controlPlaneBaseUrl", "userId", "organizationId",
    "policyFresh", "featureGates", "policyVersion", "validatedAt",
  ];
  if (!hasExactKeys(input, contextKeys) || input.schemaVersion !== REMOTE_CONTROL_AGENT_SCHEMA_VERSION ||
    typeof input.signedIn !== "boolean" || typeof input.policyFresh !== "boolean") {
    throw new TypeError("Remote-control context must be a strict schema-version 1 document.");
  }
  const gateKeys = ["schemaVersion", ...FEATURE_GATE_KEYS];
  if (!hasExactKeys(input.featureGates, gateKeys) || input.featureGates.schemaVersion !== 1 ||
    FEATURE_GATE_KEYS.some((key) => typeof input.featureGates[key] !== "boolean")) {
    throw new TypeError("Remote-control feature gates must be a complete schema-version 1 document.");
  }
  if (!(input.policyVersion === null || isIdentifier(input.policyVersion)) ||
    !(input.validatedAt === null || isTimestamp(input.validatedAt))) {
    throw new TypeError("Remote-control policy metadata is invalid.");
  }
  if (input.policyFresh && input.validatedAt === null) {
    throw new TypeError("Fresh remote-control policy requires a validation timestamp.");
  }
  /** @type {RemoteControlFeatureGates} */
  const featureGates = {
    schemaVersion: 1,
    enrollment: input.featureGates.enrollment,
    readOnlyControl: input.featureGates.readOnlyControl,
    sessionMutation: input.featureGates.sessionMutation,
    interactions: input.featureGates.interactions,
    backgroundLifecycle: input.featureGates.backgroundLifecycle,
    eventCompaction: input.featureGates.eventCompaction,
    multiInstanceRouting: input.featureGates.multiInstanceRouting,
    payloadEncryption: input.featureGates.payloadEncryption,
    busySessionSteer: input.featureGates.busySessionSteer,
    busySessionEnqueue: input.featureGates.busySessionEnqueue,
    nativeMobile: input.featureGates.nativeMobile,
  };
  if (!input.signedIn) {
    if (input.controlPlaneBaseUrl !== null || input.userId !== null || input.organizationId !== null || input.policyFresh) {
      throw new TypeError("Signed-out remote-control context must clear identity and fresh policy.");
    }
    return Object.freeze({
      schemaVersion: 1,
      signedIn: false,
      controlPlaneBaseUrl: null,
      userId: null,
      organizationId: null,
      policyFresh: false,
      featureGates: Object.freeze(featureGates),
      policyVersion: input.policyVersion,
      validatedAt: input.validatedAt,
    });
  }
  if (!isIdentifier(input.userId) || !isIdentifier(input.organizationId)) {
    throw new TypeError("Signed-in remote-control identity is invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    signedIn: true,
    controlPlaneBaseUrl: canonicalControlPlaneUrl(input.controlPlaneBaseUrl, allowInsecureLoopback),
    userId: input.userId,
    organizationId: input.organizationId,
    policyFresh: input.policyFresh,
    featureGates: Object.freeze(featureGates),
    policyVersion: input.policyVersion,
    validatedAt: input.validatedAt,
  });
}

/** @param {RemoteControlAgentContext | null} context */
function identityKey(context) {
  return context?.signedIn
    ? `${context.controlPlaneBaseUrl}\u0000${context.userId}\u0000${context.organizationId}`
    : null;
}

/** @param {RemoteControlAgentContext} context */
function credentialContext(context) {
  return {
    controlPlaneBaseUrl: /** @type {string} */ (context.controlPlaneBaseUrl),
    userId: /** @type {string} */ (context.userId),
    organizationId: /** @type {string} */ (context.organizationId),
  };
}

/** @param {unknown} value @param {Set<object>} [seen] */
function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((item) => isJsonValue(item, seen));
}

/** @param {unknown} value */
function validCapabilities(value) {
  if (!hasExactKeys(value, ["schemaVersion", "operations", "features"]) || value.schemaVersion !== 1 ||
    !Array.isArray(value.operations) || value.operations.length > OPERATION_NAMES.size ||
    !Array.isArray(value.features) || value.features.length > FEATURE_NAMES.size) return false;
  const seen = new Set();
  const validOperations = value.operations.every((capability) => {
    if (!hasExactKeys(capability, ["operation", "payloadVersions"]) ||
      !OPERATION_NAMES.has(capability.operation) || seen.has(capability.operation) ||
      !Array.isArray(capability.payloadVersions) || capability.payloadVersions.length !== 1 || capability.payloadVersions[0] !== 1) return false;
    seen.add(capability.operation);
    return true;
  });
  const seenFeatures = new Set();
  return validOperations && value.features.every((feature) => {
    if (!FEATURE_NAMES.has(feature) || seenFeatures.has(feature)) return false;
    seenFeatures.add(feature);
    return true;
  });
}

/** @param {unknown} value */
function validError(value) {
  if (!isRecord(value)) return false;
  const keys = Object.hasOwn(value, "currentRunId")
    ? ["schemaVersion", "code", "message", "retryable", "correlationId", "currentRunId"]
    : ["schemaVersion", "code", "message", "retryable", "correlationId"];
  return hasExactKeys(value, keys) && value.schemaVersion === 1 && Object.hasOwn(ERROR_MESSAGES, value.code) &&
    isDisplayText(value.message) && typeof value.retryable === "boolean" &&
    (value.correlationId === null || isIdentifier(value.correlationId)) &&
    (!Object.hasOwn(value, "currentRunId") || value.currentRunId === null || isIdentifier(value.currentRunId));
}

/** @param {RemoteControlErrorCode} code @param {string | null} correlationId @param {boolean} [retryable] */
function safeError(code, correlationId, retryable = false) {
  return {
    schemaVersion: 1,
    code,
    message: ERROR_MESSAGES[code],
    retryable,
    correlationId,
  };
}

/** @param {unknown} error @param {string} correlationId */
function safeDispatchError(error, correlationId) {
  const code = isRecord(error) && Object.hasOwn(ERROR_MESSAGES, error.code)
    ? /** @type {RemoteControlErrorCode} */ (error.code)
    : "internal_error";
  const normalized = safeError(code, correlationId, isRecord(error) && error.retryable === true);
  if (isRecord(error) && isIdentifier(error.currentRunId)) return { ...normalized, currentRunId: error.currentRunId };
  return normalized;
}

/** @param {unknown} value */
function validRequest(value) {
  if (!isRecord(value) || !hasExactKeys(value, ["operation", "payloadVersion", "arguments"]) ||
    !OPERATION_NAMES.has(value.operation) || value.payloadVersion !== 1 || !isRecord(value.arguments)) return false;
  const args = value.arguments;
  switch (value.operation) {
    case "workspace.list": return hasExactKeys(args, []);
    case "session.list": return hasExactKeys(args, ["workspaceId"]) && isIdentifier(args.workspaceId);
    case "session.snapshot": return hasExactKeys(args, ["workspaceId", "sessionId"]) && isIdentifier(args.workspaceId) && isIdentifier(args.sessionId);
    case "session.create": return (hasExactKeys(args, ["workspaceId", "title"]) || hasExactKeys(args, ["workspaceId", "title", "runtimeId"])) &&
      isIdentifier(args.workspaceId) && isSessionCreateTitle(args.title) &&
      (!Object.hasOwn(args, "runtimeId") || isIdentifier(args.runtimeId));
    case "session.prompt": return (hasExactKeys(args, ["workspaceId", "sessionId", "prompt"]) || hasExactKeys(args, ["workspaceId", "sessionId", "prompt", "whenBusy"])) &&
      isIdentifier(args.workspaceId) && isIdentifier(args.sessionId) && typeof args.prompt === "string" && args.prompt.trim().length >= 1 && Buffer.byteLength(args.prompt, "utf8") <= 200_000 &&
      (!Object.hasOwn(args, "whenBusy") || ["reject", "steer", "enqueue"].includes(args.whenBusy));
    case "session.abort": return hasExactKeys(args, ["workspaceId", "sessionId", "expectedRunId"]) && isIdentifier(args.workspaceId) &&
      isIdentifier(args.sessionId) && isIdentifier(args.expectedRunId);
    case "session.pending.cancel": return hasExactKeys(args, ["workspaceId", "sessionId", "pendingOperationId"]) &&
      isIdentifier(args.workspaceId) && isIdentifier(args.sessionId) && isIdentifier(args.pendingOperationId);
    case "interaction.permission.reply": return hasExactKeys(args, ["workspaceId", "sessionId", "interactionId", "response"]) &&
      isIdentifier(args.workspaceId) && isIdentifier(args.sessionId) && isIdentifier(args.interactionId) &&
      (args.response === "allow_once" || args.response === "reject");
    case "interaction.question.reply": {
      if (!hasExactKeys(args, ["workspaceId", "sessionId", "interactionId", "answers"]) ||
        !isIdentifier(args.workspaceId) || !isIdentifier(args.sessionId) || !isIdentifier(args.interactionId) ||
        !Array.isArray(args.answers) || args.answers.length < 1 || args.answers.length > 100) return false;
      const questionIds = new Set();
      return args.answers.every((answer) => {
        if (!hasExactKeys(answer, ["questionId", "values"]) || !isIdentifier(answer.questionId) || questionIds.has(answer.questionId) ||
          !Array.isArray(answer.values) || answer.values.length < 1 || answer.values.length > 100 ||
          !answer.values.every((item) => typeof item === "string" && item.length <= 10_000)) return false;
        questionIds.add(answer.questionId);
        return true;
      });
    }
    default: return false;
  }
}

/** @param {unknown} value */
function parseBaseEnvelope(value) {
  if (!hasExactKeys(value, ["protocolVersion", "payloadVersion", "messageId", "sentAt", "encryption", "type", "payload"]) ||
    value.protocolVersion !== 1 || value.payloadVersion !== 1 || !UUID_PATTERN.test(value.messageId) || !isTimestamp(value.sentAt) ||
    !hasExactKeys(value.encryption, ["mode", "keyId"]) || value.encryption.mode !== "none" || value.encryption.keyId !== null ||
    typeof value.type !== "string") return null;
  return value;
}

function parseEncryptedEnvelope(value) {
  if (!hasExactKeys(value, ["protocolVersion", "payloadVersion", "messageId", "sentAt", "encryption", "type", "routing", "payload"]) ||
      value.protocolVersion !== 1 || value.payloadVersion !== 1 || !UUID_PATTERN.test(value.messageId) || !isTimestamp(value.sentAt) ||
      !hasExactKeys(value.encryption, ["mode", "keyId"]) || value.encryption.mode !== "e2ee-v1" || !isIdentifier(value.encryption.keyId) ||
      value.type !== "encrypted.payload" || !isRecord(value.routing) || !hasExactKeys(value.payload, ["nonce", "ciphertext"]) ||
      typeof value.payload.nonce !== "string" || typeof value.payload.ciphertext !== "string") return null;
  return value;
}

/** @param {unknown} value @param {string} deviceId */
function validCommandEnvelope(value, deviceId) {
  const envelope = parseBaseEnvelope(value);
  if (!envelope || envelope.type !== "command.deliver") return false;
  const payload = envelope.payload;
  if (!hasExactKeys(payload, [
    "schemaVersion", "commandId", "controlSessionId", "deviceId", "actor", "request",
    "idempotencyKey", "payloadHash", "createdAt", "expiresAt",
  ]) || payload.schemaVersion !== 1 || !UUID_PATTERN.test(payload.commandId) || !UUID_PATTERN.test(payload.controlSessionId) ||
    payload.deviceId !== deviceId || !hasExactKeys(payload.actor, ["userId", "displayName"]) ||
    !isIdentifier(payload.actor.userId) || !isDisplayText(payload.actor.displayName) || !validRequest(payload.request) ||
    !(payload.idempotencyKey === null || isIdentifier(payload.idempotencyKey)) || !HASH_PATTERN.test(payload.payloadHash) ||
    !isTimestamp(payload.createdAt) || !isTimestamp(payload.expiresAt)) return false;
  return !MUTATION_OPERATIONS.has(payload.request.operation) || payload.idempotencyKey !== null;
}

/** @param {unknown} value @param {string} deviceId */
function rejectedCommandEnvelope(value, deviceId) {
  const envelope = parseBaseEnvelope(value);
  if (!envelope || envelope.type !== "command.deliver" || !isRecord(envelope.payload) ||
    !UUID_PATTERN.test(envelope.payload.commandId ?? "") || envelope.payload.deviceId !== deviceId ||
    !isRecord(envelope.payload.request)) return null;
  const request = envelope.payload.request;
  const code = typeof request.operation !== "string" || !OPERATION_NAMES.has(request.operation)
    ? "operation_unsupported"
    : request.payloadVersion !== 1
      ? "payload_version_unsupported"
      : "invalid_request";
  return { commandId: envelope.payload.commandId, code };
}

/** @param {RemoteControlCapabilities} capabilities @param {Record<string, any>} request */
function capabilityAdvertised(capabilities, request) {
  return capabilities.operations.some((capability) =>
    capability.operation === request.operation && capability.payloadVersions.includes(request.payloadVersion));
}

/** @param {unknown} value */
function validJournalLifecycle(value) {
  return hasExactKeys(value, ["status", "occurredAt", "result", "error"]) && TERMINAL_STATUSES.has(value.status) &&
    isTimestamp(value.occurredAt) && isJsonValue(value.result) && isJsonValue(value.error) &&
    (value.status === "succeeded" ? value.result !== null && value.error === null : value.result === null && validError(value.error));
}

/** @param {unknown} value */
function validWireLifecycle(value) {
  if (!hasExactKeys(value, ["status", "occurredAt", "result", "error"]) || !isTimestamp(value.occurredAt)) return false;
  if (value.status === "accepted" || value.status === "running") return value.result === null && value.error === null;
  return validJournalLifecycle(value);
}

/** @param {unknown} value */
function normalizeActiveRuns(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const run of value) {
    if (result.length >= MAX_ACTIVE_RUNS) break;
    if (!hasExactKeys(run, ["workspaceId", "sessionId", "runId", "status"]) || !isIdentifier(run.workspaceId) ||
        !isIdentifier(run.sessionId) || !isIdentifier(run.runId) || !ACTIVE_RUN_STATUSES.has(run.status)) continue;
    const key = `${run.workspaceId}\u0000${run.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, status: run.status });
  }
  return result;
}

/**
 * Creates the Electron Main remote-control connection owner. The factory has no
 * Electron import; Electron APIs and every transport/persistence boundary are
 * supplied by the composition root.
 *
 * Successful operation handlers may return either a result body or an exact
 * `{ operation, payloadVersion, result }` object. Result bodies are wrapped with
 * the delivered operation and payload version before terminal journaling.
 * @param {RemoteControlAgentOptions} options
 */
export function createRemoteControlAgent(options) {
  if (!isRecord(options)) throw new TypeError("RemoteControlAgent options are required.");
  const {
    settingsStore,
    credentialStore,
    e2eeKeyStore = null,
    operationRegistry,
    commandJournal,
    createCloudClient,
    createWebSocket,
    appVersion,
    platform,
    getDisplayName,
    now = () => new Date(),
    randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
    timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
    logger = {},
    allowInsecureLoopback = false,
    policyMaxAgeMs = DEFAULT_POLICY_MAX_AGE_MS,
    localStopAckTimeoutMs = DEFAULT_LOCAL_STOP_ACK_TIMEOUT_MS,
    getActiveRuns = () => [],
    onSessionBinding = null,
    onSessionUnbound = null,
    onTransportReset = null,
    onControlRevoked = null,
    onPolicyExpired = null,
    onAuthorizationChanged = null,
  } = options;
  if (!settingsStore || typeof settingsStore.read !== "function" || !credentialStore ||
    typeof credentialStore.read !== "function" || typeof credentialStore.delete !== "function" ||
    !(e2eeKeyStore === null || (typeof e2eeKeyStore.active === "function" && typeof e2eeKeyStore.advertisement === "function" && typeof e2eeKeyStore.privateKey === "function" && typeof e2eeKeyStore.revokeAll === "function")) ||
    !operationRegistry || typeof operationRegistry.advertise !== "function" || typeof operationRegistry.dispatch !== "function" ||
    !commandJournal || typeof commandJournal.prepare !== "function" || typeof commandJournal.complete !== "function" ||
    typeof createCloudClient !== "function" || typeof createWebSocket !== "function" || typeof getDisplayName !== "function" ||
    typeof now !== "function" || typeof randomUUID !== "function" || !timers || typeof timers.setTimeout !== "function" ||
    typeof timers.clearTimeout !== "function" || typeof appVersion !== "string" || !SEMVER_PATTERN.test(appVersion) || appVersion.length > 64 ||
    !new Set(["darwin", "windows", "linux"]).has(platform) ||
    !Number.isSafeInteger(policyMaxAgeMs) || policyMaxAgeMs < 1_000 ||
    !Number.isSafeInteger(localStopAckTimeoutMs) || localStopAckTimeoutMs < 1 || localStopAckTimeoutMs > 10_000 ||
    typeof getActiveRuns !== "function" ||
    !(onSessionBinding === null || typeof onSessionBinding === "function") ||
    !(onSessionUnbound === null || typeof onSessionUnbound === "function") ||
    !(onTransportReset === null || typeof onTransportReset === "function") ||
    !(onControlRevoked === null || typeof onControlRevoked === "function") ||
    !(onPolicyExpired === null || typeof onPolicyExpired === "function") ||
    !(onAuthorizationChanged === null || typeof onAuthorizationChanged === "function")) {
    throw new TypeError("RemoteControlAgent dependencies are invalid.");
  }

  let started = false;
  let revoked = false;
  let suspended = false;
  let protocolBlocked = false;
  let localDisabledLatch = false;
  /** @type {RemoteControlAgentContext | null} */
  let context = null;
  /** @type {RemoteControlSettings} */
  let settings = { schemaVersion: 1, enabled: false, backgroundMode: false, launchAtLogin: false, allowBusySessionSteer: false, allowBusySessionEnqueue: false };
  /** @type {RemoteControlCredentialView | null} */
  let enrollment = null;
  /** @type {RemoteControlSocket | null} */
  let socket = null;
  /** @type {RemoteControlCapabilities} */
  let advertisedCapabilities = { schemaVersion: 1, operations: [], features: [] };
  let lifecycleGeneration = 1;
  let provisionalGeneration = 0;
  let connectionGeneration = null;
  let connectionAttempt = 0;
  let reconnectAttempt = 0;
  /** @type {string} */
  let state = REMOTE_CONTROL_AGENT_STATUS.STOPPED;
  let lastErrorCode = null;
  /** @type {unknown} */
  let reconnectTimer = null;
  /** @type {unknown} */
  let heartbeatTimer = null;
  /** @type {unknown} */
  let tokenRefreshTimer = null;
  /** @type {unknown} */
  let tokenExpiryTimer = null;
  /** @type {unknown} */
  let policyExpiryTimer = null;
  /** @type {{ target: RemoteControlSocket, connectionGeneration: number, correlationId: string, timer: unknown, promise: Promise<Readonly<Record<string, unknown>>>, resolve: (value: Readonly<Record<string, unknown>>) => void } | null} */
  let pendingLocalStop = null;
  const intentionalSockets = new WeakSet();
  const failedSockets = new WeakSet();
  const inFlightCommands = new Map();
  /** @type {Map<string, string>} */
  const activeControlSessions = new Map();
  const encryptedControlSessions = new Map();
  let advertisedE2EEKey = null;
  let transportTransition = 0;
  let revocationTransition = 0;
  let authorizationActive = false;
  let resumePolicyFloor = null;

  function timestamp() {
    const value = new Date(now());
    if (!Number.isFinite(value.getTime())) throw new TypeError("RemoteControlAgent clock is invalid.");
    return value;
  }

  function messageId() {
    const value = randomUUID();
    if (!UUID_PATTERN.test(value)) throw new TypeError("RemoteControlAgent UUID source is invalid.");
    return value;
  }

  /** @param {"debug" | "info" | "warn" | "error"} level @param {string} code */
  function log(level, code) {
    try {
      logger[level]?.("Remote control agent state changed.", { code });
    } catch {}
  }

  function clearTimer(name) {
    const handle = name === "reconnect" ? reconnectTimer
      : name === "heartbeat" ? heartbeatTimer
        : name === "token-expiry" ? tokenExpiryTimer
          : name === "policy-expiry" ? policyExpiryTimer
            : tokenRefreshTimer;
    if (handle !== null) timers.clearTimeout(handle);
    if (name === "reconnect") reconnectTimer = null;
    else if (name === "heartbeat") heartbeatTimer = null;
    else if (name === "token-expiry") tokenExpiryTimer = null;
    else if (name === "policy-expiry") policyExpiryTimer = null;
    else tokenRefreshTimer = null;
  }

  function clearTimers() {
    clearTimer("reconnect");
    clearTimer("heartbeat");
    clearTimer("refresh");
    clearTimer("token-expiry");
    clearTimer("policy-expiry");
  }

  function finishLocalStop() {
    const pending = pendingLocalStop;
    if (!pending) return;
    pendingLocalStop = null;
    timers.clearTimeout(pending.timer);
    if (socket === pending.target) {
      socket = null;
      connectionGeneration = null;
    }
    closeSocket(pending.target);
    pending.resolve(status());
  }

  /** @param {RemoteControlSocket | null} target */
  function closeSocket(target) {
    if (!target) return;
    intentionalSockets.add(target);
    try { target.close(1000, "remote control stopped"); } catch {}
  }

  function activeRuns() {
    try { return normalizeActiveRuns(getActiveRuns()); } catch { return []; }
  }

  /** @param {string} value */
  function boundedControllerDisplayName(value) {
    return [...value].slice(0, MAX_CONTROLLER_DISPLAY_NAME_LENGTH).join("");
  }

  function controllerDisplayNames() {
    const names = [];
    const seen = new Set();
    for (const displayName of activeControlSessions.values()) {
      if (seen.has(displayName)) continue;
      seen.add(displayName);
      names.push(displayName);
      if (names.length >= MAX_CONTROLLER_DISPLAY_NAMES) break;
    }
    return names;
  }

  function notifyTransportReset() {
    const hadActiveControl = activeControlSessions.size > 0;
    activeControlSessions.clear();
    const transition = hadActiveControl ? ++transportTransition : null;
    try { onTransportReset?.({ hadActiveControl, transition }); } catch {}
  }

  /** @param {"local" | "cloud"} source */
  function notifyControlRevoked(source) {
    try { onControlRevoked?.({ source, transition: ++revocationTransition }); } catch {}
  }

  /** @param {boolean} value */
  function setAuthorizationActive(value) {
    const next = value === true;
    if (next === authorizationActive) return;
    authorizationActive = next;
    try { onAuthorizationChanged?.(next); } catch {}
  }

  /** Synchronously fences async completions, cancels timers, and closes transport. */
  function invalidateTransport() {
    notifyTransportReset();
    lifecycleGeneration += 1;
    connectionAttempt += 1;
    clearTimers();
    const prior = socket;
    socket = null;
    connectionGeneration = null;
    closeSocket(prior);
  }

  function contextAllowsConnection() {
    const validatedAt = context?.validatedAt === null ? Number.NaN : Date.parse(context?.validatedAt ?? "");
    const policyAge = timestamp().getTime() - validatedAt;
    return started && !suspended && !revoked && !protocolBlocked && !localDisabledLatch && settings.enabled === true && context?.signedIn === true &&
      context.policyFresh === true && context.featureGates.schemaVersion === 1 &&
      Number.isFinite(policyAge) && policyAge >= 0 && policyAge < policyMaxAgeMs &&
      context.featureGates.enrollment === true && context.featureGates.readOnlyControl === true;
  }

  function executionSleepAuthorized() {
    const validatedAt = Date.parse(context?.validatedAt ?? "");
    return contextAllowsConnection() && context?.featureGates.sessionMutation === true &&
      (resumePolicyFloor === null || validatedAt >= resumePolicyFloor);
  }

  function schedulePolicyExpiry() {
    clearTimer("policy-expiry");
    if (!context?.policyFresh || context.validatedAt === null) return;
    const generation = lifecycleGeneration;
    const delay = Math.max(1, Math.min(Date.parse(context.validatedAt) + policyMaxAgeMs - timestamp().getTime(), MAX_TIMER_DELAY));
    policyExpiryTimer = timers.setTimeout(() => {
      policyExpiryTimer = null;
      if (generation !== lifecycleGeneration || contextAllowsConnection()) return;
      lastErrorCode = "policy_unavailable";
      setAuthorizationActive(false);
      invalidateTransport();
      state = REMOTE_CONTROL_AGENT_STATUS.DISABLED;
      try { onPolicyExpired?.(); } catch {}
    }, delay);
  }

  /** @param {RemoteControlCredentialView | null} value @param {RemoteControlAgentContext} expected */
  function validEnrollment(value, expected) {
    return value !== null && value.schemaVersion === 1 && value.state === "enrolled" && UUID_PATTERN.test(value.deviceId ?? "") &&
      isRecord(value.context) && value.context.controlPlaneBaseUrl === expected.controlPlaneBaseUrl &&
      value.context.userId === expected.userId && value.context.organizationId === expected.organizationId;
  }

  function baseEnvelope(type, payload) {
    return {
      protocolVersion: 1,
      payloadVersion: 1,
      messageId: messageId(),
      sentAt: timestamp().toISOString(),
      encryption: { mode: "none", keyId: null },
      type,
      payload,
    };
  }

  function encryptedEnvelope(routing, payload, keyId) {
    return {
      protocolVersion: 1,
      payloadVersion: 1,
      messageId: messageId(),
      sentAt: timestamp().toISOString(),
      encryption: { mode: "e2ee-v1", keyId },
      type: "encrypted.payload",
      routing,
      payload,
    };
  }

  function sendRaw(target, envelope) {
    if (target !== socket) return false;
    try {
      target.send(JSON.stringify(envelope));
      return true;
    } catch {
      transportFailed(target, "transport_send_failed");
      return false;
    }
  }

  /** @param {RemoteControlSocket} target @param {string} type @param {unknown} payload */
  function send(target, type, payload) {
    if (target !== socket) return false;
    try {
      target.send(JSON.stringify(baseEnvelope(type, payload)));
      return true;
    } catch {
      transportFailed(target, "transport_send_failed");
      return false;
    }
  }

  /** @param {JournalLifecycle} lifecycle @param {string} commandId */
  function sendLifecycle(lifecycle, commandId) {
    if (!socket || !validWireLifecycle(lifecycle)) return false;
    const session = [...encryptedControlSessions.values()].find((value) => value.commandIds.has(commandId));
    if (session && TERMINAL_STATUSES.has(lifecycle.status)) {
      const routing = {
        kind: "command-result", commandId, controlSessionId: session.controlSessionId,
        deviceId: enrollment.deviceId, operation: session.operations.get(commandId), status: lifecycle.status,
        desktopKeyId: session.desktopKeyId, desktopStatementHash: session.desktopStatementHash,
        controllerKeyId: session.controllerKeyId,
      };
      const payload = encryptRemoteControlPayload({
        key: session.outboundKey,
        aad: canonicalRemoteControlAAD({ protocolVersion: 1, payloadVersion: 1, ...routing }),
        value: { result: lifecycle.result, error: lifecycle.error },
      });
      return sendRaw(socket, encryptedEnvelope(routing, payload, session.desktopKeyId));
    }
    return send(socket, "command.lifecycle", { commandId, ...lifecycle });
  }

  /** @param {number} seconds @param {RemoteControlSocket} target @param {number} generation */
  function scheduleHeartbeat(seconds, target, generation) {
    clearTimer("heartbeat");
    const delay = Math.max(1_000, Math.min(seconds * 1_000, MAX_TIMER_DELAY));
    heartbeatTimer = timers.setTimeout(() => {
      heartbeatTimer = null;
      void publishHeartbeat(target, generation);
    }, delay);
  }

  /** @param {RemoteControlSocket} target @param {number} generation */
  async function publishHeartbeat(target, generation) {
    if (target !== socket || generation !== lifecycleGeneration || connectionGeneration === null || !contextAllowsConnection()) return;
    let capabilities;
    try {
      capabilities = await operationRegistry.advertise(context);
    } catch {
      transportFailed(target, "capability_advertisement_failed");
      return;
    }
    if (target !== socket || generation !== lifecycleGeneration || !validCapabilities(capabilities)) return;
    advertisedCapabilities = capabilities;
    send(target, "device.heartbeat", {
      deviceId: enrollment.deviceId,
      connectionGeneration,
      appVersion,
      capabilities,
      activeRuns: activeRuns(),
      policyVersion: context.policyVersion,
      localControlEnabled: true,
      ...(advertisedE2EEKey ? { payloadEncryption: advertisedE2EEKey } : {}),
    });
    if (target === socket) scheduleHeartbeat(target.__remoteHeartbeatSeconds ?? 30, target, generation);
  }

  /** @param {string} expiresAt @param {RemoteControlSocket} target @param {number} generation */
  function scheduleTokenRefresh(expiresAt, target, generation) {
    clearTimer("refresh");
    clearTimer("token-expiry");
    const remaining = Date.parse(expiresAt) - timestamp().getTime();
    const delay = Math.max(1_000, Math.min(remaining - TOKEN_REFRESH_MARGIN, MAX_TIMER_DELAY));
    tokenRefreshTimer = timers.setTimeout(() => {
      tokenRefreshTimer = null;
      if (target === socket && generation === lifecycleGeneration) void connectNow(true);
    }, delay);
    tokenExpiryTimer = timers.setTimeout(() => {
      tokenExpiryTimer = null;
      if (target === socket && generation === lifecycleGeneration) {
        transportFailed(target, "token_expired");
      }
    }, Math.max(1, Math.min(remaining, MAX_TIMER_DELAY)));
  }

  function reconnectDelay() {
    const base = Math.min(1_000 * (2 ** Math.min(reconnectAttempt, 5)), RECONNECT_MAX_DELAY);
    reconnectAttempt += 1;
    const entropy = Number.parseInt(messageId().slice(-8), 16) / 0xffffffff;
    return Math.max(250, Math.min(RECONNECT_MAX_DELAY, Math.round(base * (0.8 + entropy * 0.4))));
  }

  /** @param {number} generation */
  function scheduleRefreshRetry(generation) {
    if (tokenRefreshTimer !== null || generation !== lifecycleGeneration || !contextAllowsConnection()) return;
    tokenRefreshTimer = timers.setTimeout(() => {
      tokenRefreshTimer = null;
      if (generation === lifecycleGeneration) void connectNow(true);
    }, reconnectDelay());
  }

  /** @param {number} generation */
  function scheduleReconnect(generation) {
    if (reconnectTimer !== null || generation !== lifecycleGeneration || !contextAllowsConnection()) return;
    state = REMOTE_CONTROL_AGENT_STATUS.BACKOFF;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      if (generation === lifecycleGeneration) void connectNow(false);
    }, reconnectDelay());
  }

  /** @param {RemoteControlSocket} target @param {string} code */
  function transportFailed(target, code) {
    if (target !== socket || intentionalSockets.has(target) || failedSockets.has(target)) return;
    failedSockets.add(target);
    notifyTransportReset();
    lastErrorCode = code;
    clearTimer("heartbeat");
    clearTimer("refresh");
    socket = null;
    connectionGeneration = null;
    try { target.close(); } catch {}
    if (pendingLocalStop?.target === target) finishLocalStop();
    scheduleReconnect(lifecycleGeneration);
    log("warn", code);
  }

  /** @param {unknown} input */
  function decodeMessage(input) {
    const candidate = isRecord(input) && Object.hasOwn(input, "data") ? input.data : input;
    let text;
    if (typeof candidate === "string") text = candidate;
    else if (Buffer.isBuffer(candidate)) text = candidate.toString("utf8");
    else if (candidate instanceof ArrayBuffer) text = Buffer.from(candidate).toString("utf8");
    else return null;
    if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  /** @param {unknown} value @param {RemoteControlSocket} target @param {number} generation */
  async function handleMessage(value, target, generation) {
    if (target !== socket) return;
    const encrypted = parseEncryptedEnvelope(value);
    if (encrypted) {
      if (state !== REMOTE_CONTROL_AGENT_STATUS.CONNECTED || connectionGeneration === null ||
          !context?.featureGates.payloadEncryption || !advertisedCapabilities.features.includes("payload.e2ee-v1") ||
          !e2eeKeyStore || !advertisedE2EEKey) {
        protocolBlocked = true;
        lastErrorCode = "encryption_required";
        invalidateTransport();
        state = REMOTE_CONTROL_AGENT_STATUS.ERROR;
        return;
      }
      const routing = encrypted.routing;
      try {
        if (!hasExactKeys(routing, ["kind", "commandId", "controlSessionId", "deviceId", "actor", "operation", "workspaceId", "sessionId", "idempotencyKey", "payloadHash", "createdAt", "expiresAt", "desktopKeyId", "desktopStatementHash", "controllerKeyId", "controllerPublicKey"]) ||
            routing.kind !== "command" || routing.deviceId !== enrollment?.deviceId || encrypted.encryption.keyId !== routing.desktopKeyId ||
            !UUID_PATTERN.test(routing.commandId ?? "") || !UUID_PATTERN.test(routing.controlSessionId ?? "") ||
            !HASH_PATTERN.test(routing.desktopStatementHash ?? "") || !isIdentifier(routing.controllerKeyId) || !isIdentifier(routing.controllerPublicKey) ||
            !OPERATION_NAMES.has(routing.operation) || !isIdentifier(routing.idempotencyKey) || !HASH_PATTERN.test(routing.payloadHash ?? "") ||
            !isTimestamp(routing.createdAt) || !isTimestamp(routing.expiresAt) ||
            !(routing.workspaceId === null || isIdentifier(routing.workspaceId)) || !(routing.sessionId === null || isIdentifier(routing.sessionId)) ||
            !hasExactKeys(routing.actor, ["userId", "displayName"]) || !isIdentifier(routing.actor.userId) || !isDisplayText(routing.actor.displayName)) {
          throw new Error("invalid routing");
        }
        let session = encryptedControlSessions.get(routing.controlSessionId);
        if (!session) {
          const [privateKey, advertisement, signingCredential] = await Promise.all([
            e2eeKeyStore.privateKey(routing.desktopKeyId),
            e2eeKeyStore.advertisement(routing.desktopKeyId),
            credentialStore.getSigningCredential(credentialContext(/** @type {RemoteControlAgentContext} */ (context))),
          ]);
          const expected = createSignedRemoteControlE2EEKeyAdvertisement(advertisement, signingCredential);
          if (expected.statementHash !== routing.desktopStatementHash) throw new Error("changed signed Desktop statement");
          const binding = {
            privateKey, peerPublicKey: routing.controllerPublicKey, controlSessionId: routing.controlSessionId,
            deviceId: routing.deviceId, desktopKeyId: routing.desktopKeyId, desktopStatementHash: routing.desktopStatementHash,
            controllerKeyId: routing.controllerKeyId,
          };
          session = {
            controlSessionId: routing.controlSessionId, desktopKeyId: routing.desktopKeyId,
            desktopStatementHash: routing.desktopStatementHash, controllerKeyId: routing.controllerKeyId,
            controllerPublicKey: routing.controllerPublicKey,
            inboundKey: deriveRemoteControlE2EEKey({ ...binding, direction: "controller-to-desktop" }),
            outboundKey: deriveRemoteControlE2EEKey({ ...binding, direction: "desktop-to-controller" }),
            commandIds: new Set(), operations: new Map(),
          };
          encryptedControlSessions.set(routing.controlSessionId, session);
        } else if (session.desktopKeyId !== routing.desktopKeyId || session.desktopStatementHash !== routing.desktopStatementHash ||
                   session.controllerKeyId !== routing.controllerKeyId || session.controllerPublicKey !== routing.controllerPublicKey) {
          throw new Error("changed encryption binding");
        }
        const aad = canonicalRemoteControlAAD({
          kind: "command", protocolVersion: 1, payloadVersion: 1, controlSessionId: routing.controlSessionId,
          deviceId: routing.deviceId, operation: routing.operation, workspaceId: routing.workspaceId,
          sessionId: routing.sessionId, idempotencyKey: routing.idempotencyKey, desktopKeyId: routing.desktopKeyId,
          desktopStatementHash: routing.desktopStatementHash, controllerKeyId: routing.controllerKeyId,
        });
        const request = decryptRemoteControlPayload({ key: session.inboundKey, aad, payload: encrypted.payload });
        const command = {
          schemaVersion: 1, commandId: routing.commandId, controlSessionId: routing.controlSessionId,
          deviceId: routing.deviceId, actor: routing.actor, request, idempotencyKey: routing.idempotencyKey,
          payloadHash: routing.payloadHash, createdAt: routing.createdAt, expiresAt: routing.expiresAt,
        };
        if (!validCommandEnvelope(baseEnvelope("command.deliver", command), enrollment?.deviceId ?? "") ||
            (routing.workspaceId ?? null) !== (request.arguments.workspaceId ?? null) ||
            (routing.sessionId ?? null) !== (request.arguments.sessionId ?? null) ||
            createHash("sha256").update(JSON.stringify(encrypted.payload)).digest("hex") !== routing.payloadHash ||
            !capabilityAdvertised(advertisedCapabilities, request)) throw new Error("invalid decrypted command");
        session.commandIds.add(command.commandId);
        session.operations.set(command.commandId, request.operation);
        await acceptCommand(command, generation, connectionGeneration);
      } catch {
        protocolBlocked = true;
        lastErrorCode = "encrypted_payload_invalid";
        invalidateTransport();
        state = REMOTE_CONTROL_AGENT_STATUS.ERROR;
      }
      return;
    }
    const envelope = parseBaseEnvelope(value);
    if (!envelope) {
      protocolBlocked = true;
      lastErrorCode = "invalid_protocol";
      invalidateTransport();
      state = REMOTE_CONTROL_AGENT_STATUS.ERROR;
      return;
    }
    if (pendingLocalStop?.target === target && envelope.type === "device.local_stop_ack") {
      const payload = envelope.payload;
      if (!hasExactKeys(payload, ["deviceId", "connectionGeneration", "correlationId", "closedControlSessions"]) ||
          payload.deviceId !== enrollment?.deviceId ||
          payload.connectionGeneration !== pendingLocalStop.connectionGeneration ||
          payload.correlationId !== pendingLocalStop.correlationId ||
          !Number.isSafeInteger(payload.closedControlSessions) || payload.closedControlSessions < 0) {
        lastErrorCode = "invalid_local_stop_ack";
      }
      finishLocalStop();
      return;
    }
    if (generation !== lifecycleGeneration) return;
    if (context?.featureGates.payloadEncryption && envelope.type === "connection.welcome" && !advertisedE2EEKey) {
      protocolBlocked = true;
      lastErrorCode = "encryption_negotiation_failed";
      invalidateTransport();
      state = REMOTE_CONTROL_AGENT_STATUS.ERROR;
      return;
    }
    if (envelope.type === "connection.welcome") {
      const payload = envelope.payload;
      if (!hasExactKeys(payload, ["deviceId", "connectionGeneration", "heartbeatSeconds", "staleSeconds", "offlineSeconds"]) ||
        payload.deviceId !== enrollment?.deviceId || !Number.isSafeInteger(payload.connectionGeneration) || payload.connectionGeneration <= 0 ||
        !Number.isSafeInteger(payload.heartbeatSeconds) || payload.heartbeatSeconds <= 0 ||
        !Number.isSafeInteger(payload.staleSeconds) || payload.staleSeconds <= 0 ||
        !Number.isSafeInteger(payload.offlineSeconds) || payload.offlineSeconds <= 0) {
        transportFailed(target, "invalid_welcome");
        return;
      }
      connectionGeneration = payload.connectionGeneration;
      target.__remoteHeartbeatSeconds = payload.heartbeatSeconds;
      reconnectAttempt = 0;
      lastErrorCode = null;
      state = REMOTE_CONTROL_AGENT_STATUS.CONNECTED;
      scheduleHeartbeat(payload.heartbeatSeconds, target, generation);
      return;
    }
    if (envelope.type === "cloud.ping") {
      if (!hasExactKeys(envelope.payload, ["nonce"]) || !isIdentifier(envelope.payload.nonce)) {
        transportFailed(target, "invalid_ping");
        return;
      }
      send(target, "device.pong", { nonce: envelope.payload.nonce });
      return;
    }
    if (envelope.type === "device.revoked") {
      if (!hasExactKeys(envelope.payload, ["deviceId", "reason"]) || envelope.payload.deviceId !== enrollment?.deviceId ||
        !isDisplayText(envelope.payload.reason)) {
        transportFailed(target, "invalid_revocation");
        return;
      }
      const changed = !revoked;
      revoked = true;
      localDisabledLatch = true;
      setAuthorizationActive(false);
      lastErrorCode = "device_revoked";
      activeControlSessions.clear();
      encryptedControlSessions.clear();
      invalidateTransport();
      if (changed) notifyControlRevoked("cloud");
      enrollment = null;
      state = REMOTE_CONTROL_AGENT_STATUS.REVOKED;
      try { await credentialStore.delete(); } catch { lastErrorCode = "credentials_delete_failed"; }
      try { await e2eeKeyStore?.revokeAll(); } catch { lastErrorCode = "credentials_delete_failed"; }
      return;
    }
    if (envelope.type === "session.unbound") {
      if (!hasExactKeys(envelope.payload, ["controlSessionId", "reason"]) ||
          !UUID_PATTERN.test(envelope.payload.controlSessionId) ||
          !["closed", "expired", "not_found", "snapshot_required"].includes(envelope.payload.reason)) {
        transportFailed(target, "invalid_session_unbound");
        return;
      }
      try {
        onSessionUnbound?.({
          controlSessionId: envelope.payload.controlSessionId,
          reason: envelope.payload.reason,
        });
      } catch {}
      activeControlSessions.delete(envelope.payload.controlSessionId);
      encryptedControlSessions.delete(envelope.payload.controlSessionId);
      return;
    }
    if (envelope.type === "protocol.error") {
      if (!validError(envelope.payload)) {
        protocolBlocked = true;
        lastErrorCode = "invalid_protocol_error";
      } else {
        lastErrorCode = envelope.payload.code;
        if (envelope.payload.code === "device_revoked") {
          const changed = !revoked;
          revoked = true;
          localDisabledLatch = true;
          setAuthorizationActive(false);
          activeControlSessions.clear();
          encryptedControlSessions.clear();
          invalidateTransport();
          if (changed) notifyControlRevoked("cloud");
          enrollment = null;
          state = REMOTE_CONTROL_AGENT_STATUS.REVOKED;
          try { await credentialStore.delete(); } catch { lastErrorCode = "credentials_delete_failed"; }
          try { await e2eeKeyStore?.revokeAll(); } catch { lastErrorCode = "credentials_delete_failed"; }
          return;
        }
        protocolBlocked = envelope.payload.retryable !== true;
      }
      const shouldRetry = !protocolBlocked;
      invalidateTransport();
      state = shouldRetry ? REMOTE_CONTROL_AGENT_STATUS.BACKOFF : REMOTE_CONTROL_AGENT_STATUS.ERROR;
      if (shouldRetry) scheduleReconnect(lifecycleGeneration);
      return;
    }
    if (envelope.type === "command.deliver") {
      if (context?.featureGates.payloadEncryption) {
        protocolBlocked = true;
        lastErrorCode = "encryption_downgrade";
        invalidateTransport();
        state = REMOTE_CONTROL_AGENT_STATUS.ERROR;
        return;
      }
      if (state !== REMOTE_CONTROL_AGENT_STATUS.CONNECTED || connectionGeneration === null) return;
      if (!validCommandEnvelope(envelope, enrollment?.deviceId ?? "")) {
        const rejected = rejectedCommandEnvelope(envelope, enrollment?.deviceId ?? "");
        if (rejected) {
          sendLifecycle({
            status: "rejected",
            occurredAt: timestamp().toISOString(),
            result: null,
            error: safeError(/** @type {RemoteControlErrorCode} */ (rejected.code), rejected.commandId),
          }, rejected.commandId);
        }
        return;
      }
      if (!capabilityAdvertised(advertisedCapabilities, envelope.payload.request)) {
        sendLifecycle({
          status: "rejected",
          occurredAt: timestamp().toISOString(),
          result: null,
          error: safeError("capability_not_advertised", envelope.payload.commandId),
        }, envelope.payload.commandId);
        return;
      }
      void acceptCommand(envelope.payload, generation, connectionGeneration);
      return;
    }
    protocolBlocked = true;
    lastErrorCode = "unexpected_message_type";
    invalidateTransport();
    state = REMOTE_CONTROL_AGENT_STATUS.ERROR;
  }

  async function acceptCommand(command, generation, activeGeneration) {
    const args = command.request.arguments;
    if (isIdentifier(args.workspaceId) && isIdentifier(args.sessionId)) {
      try {
        const accepted = onSessionBinding?.({
          controlSessionId: command.controlSessionId, deviceId: command.deviceId,
          workspaceId: args.workspaceId, sessionId: args.sessionId, connectionGeneration: activeGeneration,
        });
        if (accepted !== false) activeControlSessions.set(command.controlSessionId, boundedControllerDisplayName(command.actor.displayName));
      } catch {}
    }
    await handleCommand(command, generation);
  }

  /** @param {Record<string, any>} command @param {number} generation */
  async function handleCommand(command, generation) {
    const key = command.idempotencyKey === null
      ? `command:${command.commandId}`
      : `idempotency:${command.deviceId}:${command.idempotencyKey}`;
    const prior = inFlightCommands.get(key);
    if (prior) {
      await prior;
      if (generation === lifecycleGeneration) await handleCommandOnce(command, generation);
      return;
    }
    const work = handleCommandOnce(command, generation);
    inFlightCommands.set(key, work);
    try {
      await work;
    } finally {
      if (inFlightCommands.get(key) === work) inFlightCommands.delete(key);
    }
  }

  /** @param {Record<string, any>} command @param {number} generation */
  async function handleCommandOnce(command, generation) {
    const metadata = {
      commandId: command.commandId,
      deviceId: command.deviceId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      operation: command.request.operation,
      createdAt: command.createdAt,
      expiresAt: command.expiresAt,
    };
    /** @type {JournalPrepareResult} */
    let prepared;
    try {
      prepared = await commandJournal.prepare(metadata);
    } catch {
      sendLifecycle({
        status: "rejected",
        occurredAt: timestamp().toISOString(),
        result: null,
        error: safeError("delivery_failed", command.commandId),
      }, command.commandId);
      return;
    }
    if (generation !== lifecycleGeneration || !contextAllowsConnection()) return;
    if (prepared.action === "replay") {
      if (validJournalLifecycle(prepared.lifecycle)) sendLifecycle(prepared.lifecycle, prepared.commandId);
      return;
    }
    if (prepared.action === "reject") {
      const code = Object.hasOwn(ERROR_MESSAGES, prepared.error.code)
        ? /** @type {RemoteControlErrorCode} */ (prepared.error.code)
        : "delivery_failed";
      const status = code === "command_expired" ? "expired" : code === "delivery_failed" ? "failed" : "rejected";
      sendLifecycle({
        status,
        occurredAt: timestamp().toISOString(),
        result: null,
        error: safeError(code, prepared.commandId ?? command.commandId),
      }, prepared.commandId ?? command.commandId);
      return;
    }
    sendLifecycle({ status: "accepted", occurredAt: timestamp().toISOString(), result: null, error: null }, command.commandId);
    sendLifecycle({ status: "running", occurredAt: timestamp().toISOString(), result: null, error: null }, command.commandId);

    let terminal;
    try {
      const dispatched = await operationRegistry.dispatch(command.request, {
        advertisedCapabilities,
        context,
        correlationId: command.commandId,
      });
      if (dispatched.ok === true) {
        const value = dispatched.value;
        const fullResult = hasExactKeys(value, ["operation", "payloadVersion", "result"]) &&
          value.operation === command.request.operation && value.payloadVersion === command.request.payloadVersion
          ? value
          : { operation: command.request.operation, payloadVersion: command.request.payloadVersion, result: value };
        if (!isJsonValue(fullResult)) throw new TypeError("Operation returned a non-JSON result.");
        terminal = { status: "succeeded", occurredAt: timestamp().toISOString(), result: fullResult, error: null };
      } else {
        terminal = {
          status: "failed",
          occurredAt: timestamp().toISOString(),
          result: null,
          error: safeDispatchError(dispatched.error, command.commandId),
        };
      }
    } catch {
      terminal = {
        status: "failed",
        occurredAt: timestamp().toISOString(),
        result: null,
        error: safeError("internal_error", command.commandId),
      };
    }

    try {
      const completed = await commandJournal.complete(command.commandId, terminal);
      const persisted = isRecord(completed) && completed.action === "replay" && validJournalLifecycle(completed.lifecycle)
        ? completed.lifecycle
        : terminal;
      if (generation === lifecycleGeneration) sendLifecycle(persisted, command.commandId);
    } catch {
      const failed = {
        status: "failed",
        occurredAt: timestamp().toISOString(),
        result: null,
        error: safeError("delivery_failed", command.commandId),
      };
      let persisted = false;
      try {
        await commandJournal.complete(command.commandId, failed);
        persisted = true;
      } catch {}
      if (persisted && generation === lifecycleGeneration) sendLifecycle(failed, command.commandId);
    }
  }

  /** @param {RemoteControlSocket} target @param {number} generation @param {string} expiresAt */
  function bindSocket(target, generation, expiresAt) {
    target.on("open", () => { void (async () => {
      if (target !== socket || generation !== lifecycleGeneration || !contextAllowsConnection()) return;
      let capabilities;
      try { capabilities = await operationRegistry.advertise(context); } catch { transportFailed(target, "capability_advertisement_failed"); return; }
      if (target !== socket || generation !== lifecycleGeneration || !validCapabilities(capabilities)) {
        transportFailed(target, "invalid_capability_advertisement");
        return;
      }
      advertisedCapabilities = capabilities;
      advertisedE2EEKey = null;
      if (context.featureGates.payloadEncryption) {
        if (!capabilities.features.includes("payload.e2ee-v1") || !e2eeKeyStore) {
          transportFailed(target, "encryption_unavailable");
          return;
        }
        try {
          const [advertisement, signingCredential] = await Promise.all([
            e2eeKeyStore.active(),
            credentialStore.getSigningCredential(credentialContext(/** @type {RemoteControlAgentContext} */ (context))),
          ]);
          advertisedE2EEKey = createSignedRemoteControlE2EEKeyAdvertisement(advertisement, signingCredential);
        } catch {
          transportFailed(target, "encryption_key_unavailable");
          return;
        }
      }
      provisionalGeneration += 1;
      send(target, "device.hello", {
        deviceId: enrollment.deviceId,
        connectionGeneration: provisionalGeneration,
        appVersion,
        capabilities,
        activeRuns: activeRuns(),
        policyVersion: context.policyVersion,
        localControlEnabled: true,
        ...(advertisedE2EEKey ? { payloadEncryption: advertisedE2EEKey } : {}),
      });
      state = REMOTE_CONTROL_AGENT_STATUS.AWAITING_WELCOME;
      scheduleTokenRefresh(expiresAt, target, generation);
    })(); });
    target.on("message", (data) => {
      const decoded = decodeMessage(data);
      if (decoded === null) transportFailed(target, "invalid_message");
      else void handleMessage(decoded, target, generation);
    });
    target.on("error", () => transportFailed(target, "transport_error"));
    target.on("close", (code, reason) => {
      if (target !== socket || intentionalSockets.has(target)) return;
      transportFailed(target, transportCloseErrorCode(code, reason));
    });
  }

  /** @param {boolean} replace */
  async function connectNow(replace) {
    if (!contextAllowsConnection() || (!replace && socket !== null)) return;
    const generation = lifecycleGeneration;
    const attempt = ++connectionAttempt;
    const activeContext = /** @type {RemoteControlAgentContext} */ (context);
    state = REMOTE_CONTROL_AGENT_STATUS.CONNECTING;
    let credential;
    try {
      credential = await credentialStore.read(credentialContext(activeContext));
    } catch {
      if (generation === lifecycleGeneration && attempt === connectionAttempt) {
        enrollment = null;
        lastErrorCode = "credentials_unavailable";
        state = REMOTE_CONTROL_AGENT_STATUS.UNENROLLED;
      }
      return;
    }
    if (generation !== lifecycleGeneration || attempt !== connectionAttempt || !contextAllowsConnection()) return;
    if (!validEnrollment(credential, activeContext)) {
      enrollment = null;
      lastErrorCode = credential === null ? null : "credentials_context_mismatch";
      state = REMOTE_CONTROL_AGENT_STATUS.UNENROLLED;
      return;
    }
    enrollment = credential;
    let token;
    try {
      token = await createCloudClient(/** @type {string} */ (activeContext.controlPlaneBaseUrl)).issueAgentToken({
        credentials: credentialStore,
        context: credentialContext(activeContext),
      });
    } catch {
      if (generation === lifecycleGeneration && attempt === connectionAttempt) {
        lastErrorCode = "token_unavailable";
        if (replace && socket !== null) scheduleRefreshRetry(generation);
        else scheduleReconnect(generation);
      }
      return;
    }
    if (generation !== lifecycleGeneration || attempt !== connectionAttempt || !contextAllowsConnection()) return;
    if (!isRecord(token) || typeof token.accessToken !== "string" || !token.accessToken || !isTimestamp(token.expiresAt) ||
      Date.parse(token.expiresAt) <= timestamp().getTime() || typeof token.webSocketUrl !== "string" || !/^wss:\/\//.test(token.webSocketUrl)) {
      lastErrorCode = "invalid_token";
      if (replace && socket !== null) scheduleRefreshRetry(generation);
      else scheduleReconnect(generation);
      return;
    }
    let nextSocket;
    try { nextSocket = createWebSocket({ url: token.webSocketUrl, accessToken: token.accessToken }); }
    catch {
      lastErrorCode = "transport_create_failed";
      if (replace && socket !== null) scheduleRefreshRetry(generation);
      else scheduleReconnect(generation);
      return;
    }
    if (!nextSocket || typeof nextSocket.on !== "function" || typeof nextSocket.send !== "function" || typeof nextSocket.close !== "function") {
      lastErrorCode = "transport_create_failed";
      if (replace && socket !== null) scheduleRefreshRetry(generation);
      else scheduleReconnect(generation);
      return;
    }
    if (generation !== lifecycleGeneration || attempt !== connectionAttempt || !contextAllowsConnection()) {
      closeSocket(nextSocket);
      return;
    }
    const prior = socket;
    if (prior) notifyTransportReset();
    socket = nextSocket;
    connectionGeneration = null;
    bindSocket(nextSocket, generation, token.expiresAt);
    closeSocket(prior);
  }

  async function reconcile() {
    if (!contextAllowsConnection()) {
      invalidateTransport();
      if (!started) state = REMOTE_CONTROL_AGENT_STATUS.STOPPED;
      else if (!context?.signedIn) state = REMOTE_CONTROL_AGENT_STATUS.WAITING_FOR_CONTEXT;
      else state = revoked ? REMOTE_CONTROL_AGENT_STATUS.REVOKED : REMOTE_CONTROL_AGENT_STATUS.DISABLED;
      return;
    }
    if (socket) {
      if (connectionGeneration !== null) void publishHeartbeat(socket, lifecycleGeneration);
      return;
    }
    await connectNow(false);
  }

  /** Load local settings and reconcile the transport. A stop-all latch clears only after Main confirms the persisted disabled state. */
  async function refreshLocalSettings() {
    const generation = lifecycleGeneration;
    let next;
    try { next = await settingsStore.read(); } catch { next = null; }
    if (generation !== lifecycleGeneration && !started) return status();
    const legacy = hasExactKeys(next, ["schemaVersion", "enabled", "backgroundMode", "launchAtLogin"]);
    const current = hasExactKeys(next, ["schemaVersion", "enabled", "backgroundMode", "launchAtLogin", "allowBusySessionSteer", "allowBusySessionEnqueue"]);
    const valid = (legacy || current) && next.schemaVersion === 1 && typeof next.enabled === "boolean" &&
      typeof next.backgroundMode === "boolean" && typeof next.launchAtLogin === "boolean" &&
      (!current || (typeof next.allowBusySessionSteer === "boolean" && typeof next.allowBusySessionEnqueue === "boolean"));
    settings = valid ? {
      ...next,
      allowBusySessionSteer: current ? next.allowBusySessionSteer : false,
      allowBusySessionEnqueue: current ? next.allowBusySessionEnqueue : false,
    } : { schemaVersion: 1, enabled: false, backgroundMode: false, launchAtLogin: false, allowBusySessionSteer: false, allowBusySessionEnqueue: false };
    if (!settings.enabled) localDisabledLatch = false;
    if (!settings.enabled) {
      setAuthorizationActive(false);
      invalidateTransport();
    }
    await reconcile();
    setAuthorizationActive(executionSleepAuthorized());
    return status();
  }

  /** Starts the agent and loads fail-closed local settings. */
  async function start() {
    if (started) return status();
    started = true;
    protocolBlocked = false;
    state = REMOTE_CONTROL_AGENT_STATUS.WAITING_FOR_CONTEXT;
    await refreshLocalSettings();
    return status();
  }

  /** @param {unknown} input */
  async function syncContext(input) {
    let next;
    try { next = normalizeRemoteControlAgentContext(input, { allowInsecureLoopback }); }
    catch (error) {
      setAuthorizationActive(false);
      context = null;
      protocolBlocked = false;
      invalidateTransport();
      state = started ? REMOTE_CONTROL_AGENT_STATUS.WAITING_FOR_CONTEXT : REMOTE_CONTROL_AGENT_STATUS.STOPPED;
      throw error;
    }
    const switched = identityKey(context) !== identityKey(next);
    if (switched) {
      setAuthorizationActive(false);
      invalidateTransport();
      encryptedControlSessions.clear();
      enrollment = null;
      revoked = false;
      protocolBlocked = false;
      lastErrorCode = null;
    }
    context = next;
    if (!next.signedIn || !next.policyFresh || !next.featureGates.enrollment || !next.featureGates.readOnlyControl) {
      setAuthorizationActive(false);
      invalidateTransport();
    }
    schedulePolicyExpiry();
    await reconcile();
    setAuthorizationActive(executionSleepAuthorized());
    return status();
  }

  /** Consumes a renderer-created one-time grant for the current eligible context. */
  /** @param {{ grant?: string }} [input] */
  async function enroll({ grant } = {}) {
    if (!contextAllowsConnection() || !context || typeof grant !== "string" || !grant) {
      throw new TypeError("Remote control is not eligible for enrollment.");
    }
    const generation = lifecycleGeneration;
    const activeContext = context;
    const displayName = await getDisplayName();
    if (generation !== lifecycleGeneration || activeContext !== context || !contextAllowsConnection()) return status();
    const credential = await createCloudClient(/** @type {string} */ (activeContext.controlPlaneBaseUrl)).enrollDevice({
      credentials: credentialStore,
      context: credentialContext(activeContext),
      grant,
      displayName,
      platform,
    });
    if (generation !== lifecycleGeneration || activeContext !== context || !contextAllowsConnection()) return status();
    if (!validEnrollment(credential, activeContext)) throw new TypeError("Enrollment returned an invalid device binding.");
    enrollment = credential;
    revoked = false;
    await connectNow(false);
    return status();
  }

  /** Immediately rejects operations, then gives Cloud a bounded opportunity to acknowledge device-wide closure. */
  function stopAll() {
    if (pendingLocalStop) return pendingLocalStop.promise;
    const changed = !localDisabledLatch;
    localDisabledLatch = true;
    setAuthorizationActive(false);
    activeControlSessions.clear();
    encryptedControlSessions.clear();
    notifyTransportReset();
    lifecycleGeneration += 1;
    connectionAttempt += 1;
    clearTimers();
    if (changed) notifyControlRevoked("local");
    state = REMOTE_CONTROL_AGENT_STATUS.DISABLED;
    const target = socket;
    const generation = connectionGeneration;
    if (!target || generation === null || !enrollment?.deviceId) {
      socket = null;
      connectionGeneration = null;
      closeSocket(target);
      return Promise.resolve(status());
    }
    const correlationId = messageId();
    /** @type {(value: Readonly<Record<string, unknown>>) => void} */
    let resolve = () => {};
    const promise = new Promise((settle) => { resolve = settle; });
    const timer = timers.setTimeout(finishLocalStop, localStopAckTimeoutMs);
    pendingLocalStop = { target, connectionGeneration: generation, correlationId, timer, promise, resolve };
    try {
      target.send(JSON.stringify(baseEnvelope("device.local_stop", {
        deviceId: enrollment.deviceId,
        connectionGeneration: generation,
        correlationId,
      })));
    } catch {
      lastErrorCode = "transport_send_failed";
      finishLocalStop();
    }
    return promise;
  }

  /** Stops transport synchronously before deleting the platform-protected key. */
  async function deleteCredential() {
    setAuthorizationActive(false);
    invalidateTransport();
    encryptedControlSessions.clear();
    enrollment = null;
    revoked = false;
    await credentialStore.delete();
    await e2eeKeyStore?.revokeAll();
    state = started ? REMOTE_CONTROL_AGENT_STATUS.UNENROLLED : REMOTE_CONTROL_AGENT_STATUS.STOPPED;
    return status();
  }

  /** Idempotently stops the agent; transport and timers are gone before this method returns its promise. */
  async function stop() {
    if (!started && socket === null && reconnectTimer === null && heartbeatTimer === null && tokenRefreshTimer === null) return status();
    started = false;
    setAuthorizationActive(false);
    activeControlSessions.clear();
    encryptedControlSessions.clear();
    invalidateTransport();
    state = REMOTE_CONTROL_AGENT_STATUS.STOPPED;
    return status();
  }

  /** Fences transport immediately and invalidates policy obtained before system sleep. */
  async function suspend() {
    if (suspended) return status();
    suspended = true;
    resumePolicyFloor = timestamp().getTime();
    setAuthorizationActive(false);
    if (context?.signedIn) context = Object.freeze({ ...context, policyFresh: false, validatedAt: null });
    lastErrorCode = "device_offline";
    invalidateTransport();
    state = started ? REMOTE_CONTROL_AGENT_STATUS.DISABLED : REMOTE_CONTROL_AGENT_STATUS.STOPPED;
    try { onPolicyExpired?.(); } catch {}
    return status();
  }

  /** Re-enters normal reconciliation; a post-suspend context sync must supply fresh policy and a new token. */
  async function resume() {
    if (!suspended) return status();
    suspended = false;
    await reconcile();
    setAuthorizationActive(executionSleepAuthorized());
    return status();
  }

  /** @param {unknown} event @param {{ connectionGeneration?: unknown }} [options] */
  function publishSessionEvent(event, options = {}) {
    const parsed = desktopRemoteSessionEventSchema.safeParse(event);
    if (!parsed.success || !socket || state !== REMOTE_CONTROL_AGENT_STATUS.CONNECTED || connectionGeneration === null ||
        options.connectionGeneration !== connectionGeneration || parsed.data.deviceId !== enrollment?.deviceId) return false;
    if (context?.featureGates.payloadEncryption) {
      const session = encryptedControlSessions.get(parsed.data.controlSessionId);
      if (!session) return false;
      const occurredAt = new Date(parsed.data.occurredAt).toISOString();
      const routing = {
        kind: "session-event", eventId: parsed.data.eventId, controlSessionId: parsed.data.controlSessionId,
        deviceId: parsed.data.deviceId, workspaceId: parsed.data.workspaceId, sessionId: parsed.data.sessionId,
        sourceSequence: parsed.data.sequence, eventType: parsed.data.data.type, occurredAt,
        desktopKeyId: session.desktopKeyId, desktopStatementHash: session.desktopStatementHash,
        controllerKeyId: session.controllerKeyId,
      };
      const payload = encryptRemoteControlPayload({
        key: session.outboundKey,
        aad: canonicalRemoteControlAAD({ protocolVersion: 1, payloadVersion: 1, ...routing }),
        value: parsed.data.data,
      });
      return sendRaw(socket, encryptedEnvelope(routing, payload, session.desktopKeyId));
    }
    return send(socket, "session.event", parsed.data);
  }

  /** Returns content- and credential-free diagnostic state. */
  function status() {
    return Object.freeze({
      schemaVersion: 1,
      state,
      started,
      connected: state === REMOTE_CONTROL_AGENT_STATUS.CONNECTED,
      enrolled: enrollment?.state === "enrolled",
      revoked,
      localControlEnabled: contextAllowsConnection(),
      activeControlSessionCount: activeControlSessions.size,
      controllerDisplayNames: controllerDisplayNames(),
      lifecycleGeneration,
      connectionGeneration,
      lastErrorCode,
    });
  }

  return Object.freeze({ start, syncContext, enroll, refreshLocalSettings, stopAll, deleteCredential, publishSessionEvent, suspend, resume, stop, status });
}
