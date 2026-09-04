import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, KeyObject, sign as nodeSign } from "node:crypto";

export const REMOTE_CONTROL_CLOUD_SCHEMA_VERSION = 1;
export const DESKTOP_AGENT_AUDIENCE = "jugglework-desktop-agent";
export const DESKTOP_AGENT_SCOPE = "desktop-agent:connect";

const JSON_RESPONSE_LIMIT = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEVICE_STATUS_ERROR_CODES = new Set(["device_revoked", "device_disabled"]);

/** @typedef {{ controlPlaneBaseUrl: string, userId: string, organizationId: string }} RemoteControlCloudContext */
/** @typedef {{ controlPlaneBaseUrl: string, apiBaseUrl: string, resourceUrl: string, webSocketUrl: string, enrollmentExchangeUrl: string }} RemoteControlCloudUrls */
/** @typedef {(url: string, init: { method: string, redirect: RequestRedirect, headers: Record<string, string>, body: string, signal?: AbortSignal }) => Promise<Response>} RemoteControlFetcher */
/** @typedef {(algorithm: null, data: NodeJS.ArrayBufferView, key: import("node:crypto").KeyLike) => Buffer} RemoteControlSigner */
/** @typedef {{ deviceId: string, keyId: string, publicKeyFingerprint: string, enrolledAt: string }} RemoteControlEnrollmentBinding */
/** @typedef {{ publicKey: string }} RemoteControlPendingCredential */
/** @typedef {{ deviceId: string, keyId: string, privateKey: import("node:crypto").KeyObject | string | Buffer }} RemoteControlSigningCredential */
/**
 * @template T
 * @typedef {{
 *   credentials: {
 *     prepareEnrollment(context: RemoteControlCloudContext): Promise<RemoteControlPendingCredential>,
 *     completeEnrollment(context: RemoteControlCloudContext, binding: RemoteControlEnrollmentBinding): Promise<T>,
 *   },
 *   context: RemoteControlCloudContext,
 *   grant: string,
 *   displayName: string,
 *   platform: string,
 *   signal?: AbortSignal,
 * }} RemoteControlEnrollDeviceOptions
 */
/** @typedef {{ credentials: { getSigningCredential(context: RemoteControlCloudContext): Promise<RemoteControlSigningCredential> }, context: RemoteControlCloudContext }} RemoteControlIssueTokenOptions */
/** @typedef {{ accessToken: string, tokenType: "Bearer", expiresAt: string, resource: string, webSocketUrl: string }} RemoteControlAgentToken */
/**
 * @typedef {{
 *   controlPlaneBaseUrl?: string,
 *   fetcher?: RemoteControlFetcher,
 *   now?: () => Date,
 *   allowInsecureLoopback?: boolean,
 *   signer?: RemoteControlSigner,
 * }} RemoteControlCloudClientOptions
 */
/**
 * @typedef {{
 *   urls: Readonly<RemoteControlCloudUrls>,
 *   enrollDevice: <T>(input: RemoteControlEnrollDeviceOptions<T>) => Promise<T>,
 *   issueAgentToken(input: RemoteControlIssueTokenOptions): Promise<Readonly<RemoteControlAgentToken>>,
 * }} RemoteControlCloudClient
 */

export class RemoteControlCloudError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown, status?: number }} [options] */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "RemoteControlCloudError";
    this.code = code;
    this.status = options.status ?? null;
  }
}

/** @param {string} code @param {string} message @param {{ cause?: unknown, status?: number }} [options] @returns {never} */
function fail(code, message, options) {
  throw new RemoteControlCloudError(code, message, options);
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
}

/**
 * Derive the canonical API, Desktop-agent resource, and WebSocket endpoints.
 * Accepted control-plane paths are the origin, /jwork, /jwork/api, and the
 * legacy /api/den proxy. HTTPS is required except for explicitly allowed local
 * development endpoints.
 * @param {unknown} controlPlaneBaseUrl
 * @param {{ allowInsecureLoopback?: boolean }} [options]
 * @returns {Readonly<RemoteControlCloudUrls>}
 */
export function deriveRemoteControlCloudUrls(controlPlaneBaseUrl, { allowInsecureLoopback = false } = {}) {
  if (typeof controlPlaneBaseUrl !== "string" || !controlPlaneBaseUrl.trim()) {
    fail("invalid_control_plane_url", "A control-plane base URL is required.");
  }
  let url;
  try {
    url = new URL(controlPlaneBaseUrl.trim());
  } catch (cause) {
    fail("invalid_control_plane_url", "The control-plane base URL is invalid.", { cause });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail("invalid_control_plane_url", "The control-plane base URL is not an eligible HTTP endpoint.");
  }
  if (url.protocol !== "https:" && !(allowInsecureLoopback && isLoopback(url.hostname))) {
    fail("insecure_control_plane_url", "Remote control requires HTTPS outside explicit loopback development.");
  }

  const inputPath = url.pathname.replace(/\/+$/, "") || "/";
  let apiPath;
  if (inputPath === "/") apiPath = "/jwork/api";
  else if (inputPath === "/jwork") apiPath = "/jwork/api";
  else if (inputPath === "/jwork/api" || inputPath === "/api/den") apiPath = inputPath;
  else fail("invalid_control_plane_url", "The control-plane base URL has an unsupported path.");

  url.pathname = apiPath;
  const apiBaseUrl = url.toString().replace(/\/$/, "");
  const resourceUrl = `${apiBaseUrl}/desktop-agent/v1`;
  const webSocket = new URL(`${resourceUrl}/connect`);
  webSocket.protocol = webSocket.protocol === "https:" ? "wss:" : "ws:";
  return Object.freeze({
    controlPlaneBaseUrl: apiBaseUrl,
    apiBaseUrl,
    resourceUrl,
    webSocketUrl: webSocket.toString(),
    enrollmentExchangeUrl: `${apiBaseUrl}/v1/desktop-devices/enrollment-grants/exchange`,
  });
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_response", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("invalid_response", `${label} contains missing or unknown fields.`);
  }
  return value;
}

function canonicalUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("invalid_response", `${label} must be a canonical UUID.`);
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
    fail("invalid_response", `${label} is invalid.`);
  }
  return value;
}

function canonicalDate(value, label) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : null;
  if (!match) fail("invalid_response", `${label} must be an RFC 3339 timestamp.`);
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
  ) fail("invalid_response", `${label} must be a valid RFC 3339 timestamp.`);
  return value;
}

function canonicalBase64Url(value, byteLength, label, code = "invalid_response") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail(code, `${label} must be canonical base64url.`);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    fail(code, `${label} must be canonical base64url.`);
  }
  if (decoded.length !== byteLength || decoded.toString("base64url") !== value) {
    fail(code, `${label} must be canonical base64url.`);
  }
  return decoded;
}

function canonicalOpaque(value, prefix, label) {
  if (typeof value !== "string" || value.length > 128 || !value.startsWith(prefix)) {
    fail("invalid_response", `${label} is invalid.`);
  }
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) fail("invalid_response", `${label} is invalid.`);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length < 16 || decoded.toString("base64url") !== encoded) {
    fail("invalid_response", `${label} is invalid.`);
  }
  return value;
}

function validatePublicKey(value, code = "invalid_enrollment_input") {
  return canonicalBase64Url(value, 32, "Ed25519 public key", code);
}

function fingerprint(publicKey) {
  return createHash("sha256").update(validatePublicKey(publicKey)).digest("hex");
}

function validatePlatform(platform) {
  if (!new Set(["darwin", "windows", "linux"]).has(platform)) {
    fail("invalid_enrollment_input", "The device platform is invalid.");
  }
  return platform;
}

function validateEnrollmentInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid_enrollment_input", "Enrollment input is required.");
  }
  if (typeof input.grant !== "string" || input.grant.length > 128 || !input.grant.startsWith("jwenroll_")) {
    fail("invalid_enrollment_input", "The one-time enrollment grant is invalid.");
  }
  const encodedGrant = input.grant.slice("jwenroll_".length);
  const rawGrant = Buffer.from(encodedGrant, "base64url");
  if (rawGrant.length < 16 || rawGrant.toString("base64url") !== encodedGrant) {
    fail("invalid_enrollment_input", "The one-time enrollment grant is invalid.");
  }
  if (
    typeof input.displayName !== "string" ||
    input.displayName.length < 1 ||
    input.displayName.length > 500 ||
    input.displayName.trim() !== input.displayName ||
    /[\u0000-\u001f\u007f]/.test(input.displayName)
  ) {
    fail("invalid_enrollment_input", "The device display name is invalid.");
  }
  validatePlatform(input.platform);
  validatePublicKey(input.publicKey);
}

async function strictJsonResponse(response, expectedStatus, { acceptedDeviceStatusCodes = null } = {}) {
  if (!response || typeof response.status !== "number" || typeof response.text !== "function") {
    fail("invalid_response", "The control plane returned an invalid HTTP response.");
  }
  if (response.status !== expectedStatus) {
    let errorCode = "unexpected_status";
    try {
      const text = await response.text();
      if (text && Buffer.byteLength(text, "utf8") <= JSON_RESPONSE_LIMIT) {
        const payload = JSON.parse(text);
        if (acceptedDeviceStatusCodes && response.status === 403 &&
            payload && typeof payload === "object" && !Array.isArray(payload) &&
            DEVICE_STATUS_ERROR_CODES.has(payload.error) && acceptedDeviceStatusCodes.has(payload.error)) {
          errorCode = payload.error;
        }
      }
    } catch {}
    fail(errorCode, `The control plane returned HTTP ${response.status}.`, { status: response.status });
  }
  if (response.redirected === true) fail("invalid_response", "The control plane response was redirected.");
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    fail("invalid_response", "The control plane response is not JSON.");
  }
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    fail("invalid_response", "The control plane response could not be read.", { cause });
  }
  if (!text || Buffer.byteLength(text, "utf8") > JSON_RESPONSE_LIMIT) {
    fail("invalid_response", "The control plane JSON response has an invalid size.");
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    fail("invalid_response", "The control plane returned malformed JSON.", { cause });
  }
}

/** Build the exact LF-terminated bytes verified by the Desktop-agent API. */
export function buildDesktopAgentProofSigningMessage({ challengeId, challenge, deviceId, keyId, resource }) {
  canonicalUuid(challengeId, "challengeId");
  canonicalOpaque(challenge, "jwdpop_", "challenge");
  canonicalUuid(deviceId, "deviceId");
  canonicalUuid(keyId, "keyId");
  if (typeof resource !== "string" || resource.includes("\n") || resource.includes("\r")) {
    fail("invalid_response", "The Desktop-agent resource is invalid.");
  }
  return Buffer.from(
    `jugglework.desktop-agent.pop.v1\nchallenge_id=${challengeId}\nchallenge=${challenge}\ndevice_id=${deviceId}\nkey_id=${keyId}\naudience=${DESKTOP_AGENT_AUDIENCE}\nresource=${resource}\nscopes=${DESKTOP_AGENT_SCOPE}\n`,
    "utf8",
  );
}

/**
 * Create the Main-process Cloud client. It consumes renderer-created grants but
 * never creates them, and returns short-lived agent tokens only to its caller.
 * @param {RemoteControlCloudClientOptions} [options]
 * @returns {Readonly<RemoteControlCloudClient>}
 */
export function createRemoteControlCloudClient({
  controlPlaneBaseUrl,
  fetcher = globalThis.fetch,
  now = () => new Date(),
  allowInsecureLoopback = false,
  signer = nodeSign,
} = {}) {
  if (typeof fetcher !== "function") fail("invalid_client", "A fetch implementation is required.");
  if (typeof now !== "function" || typeof signer !== "function") fail("invalid_client", "Cloud client dependencies are invalid.");
  const urls = deriveRemoteControlCloudUrls(controlPlaneBaseUrl, { allowInsecureLoopback });

  /** @param {string} url @param {unknown} body @param {number} expectedStatus @param {AbortSignal | undefined} [signal] @param {{ acceptedDeviceStatusCodes?: Set<string> | null }} [options] @returns {Promise<any>} */
  async function post(url, body, expectedStatus, signal, options = {}) {
    let response;
    try {
      response = await fetcher(url, {
        method: "POST",
        redirect: "error",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch {
      // Fetch implementations can include request bodies in their errors. Do
      // not retain a cause that could carry a one-time grant or proof value.
      fail("network_unavailable", "The remote-control control plane is unavailable.");
    }
    return strictJsonResponse(response, expectedStatus, options);
  }

  /**
   * @param {{ grant: string, displayName: string, platform: string, publicKey: string, expectedUserId: string, expectedOrganizationId: string, signal?: AbortSignal }} input
   * @returns {Promise<RemoteControlEnrollmentBinding>}
   */
  async function exchangeEnrollmentGrant(input) {
    validateEnrollmentInput(input);
    const payload = await post(urls.enrollmentExchangeUrl, {
      schemaVersion: REMOTE_CONTROL_CLOUD_SCHEMA_VERSION,
      grant: input.grant,
      device: { displayName: input.displayName, platform: input.platform },
      credential: { algorithm: "Ed25519", publicKey: input.publicKey },
    }, 201, input.signal);
    exactObject(payload, ["schemaVersion", "device", "credential"], "enrollment response");
    if (payload.schemaVersion !== REMOTE_CONTROL_CLOUD_SCHEMA_VERSION) fail("invalid_response", "The enrollment schema version is unsupported.");
    const device = exactObject(payload.device, [
      "id", "ownerUserId", "organizationId", "displayName", "platform", "enrollmentStatus", "enrolledAt",
    ], "enrolled device");
    const credential = exactObject(payload.credential, [
      "keyId", "algorithm", "publicKeyFingerprint", "createdAt",
    ], "enrolled credential");
    canonicalUuid(device.id, "device.id");
    canonicalIdentifier(device.ownerUserId, "device.ownerUserId");
    canonicalIdentifier(device.organizationId, "device.organizationId");
    canonicalDate(device.enrolledAt, "device.enrolledAt");
    canonicalDate(credential.createdAt, "credential.createdAt");
    canonicalUuid(credential.keyId, "credential.keyId");
    if (
      device.ownerUserId !== input.expectedUserId ||
      device.organizationId !== input.expectedOrganizationId ||
      device.displayName !== input.displayName ||
      device.platform !== input.platform ||
      device.enrollmentStatus !== "enrolled" ||
      credential.algorithm !== "Ed25519" ||
      credential.publicKeyFingerprint !== fingerprint(input.publicKey)
    ) {
      fail("enrollment_binding_mismatch", "The enrollment response does not match the local device context.");
    }
    return {
      deviceId: device.id,
      keyId: credential.keyId,
      publicKeyFingerprint: credential.publicKeyFingerprint,
      enrolledAt: device.enrolledAt,
    };
  }

  /** @template T @param {RemoteControlEnrollDeviceOptions<T>} input @returns {Promise<T>} */
  async function enrollDevice({ credentials, context, grant, displayName, platform, signal }) {
    if (
      !credentials ||
      typeof credentials.prepareEnrollment !== "function" ||
      typeof credentials.completeEnrollment !== "function"
    ) {
      fail("invalid_client", "A remote-control credential store is required.");
    }
    const contextUrls = deriveRemoteControlCloudUrls(context?.controlPlaneBaseUrl, { allowInsecureLoopback });
    if (contextUrls.controlPlaneBaseUrl !== urls.controlPlaneBaseUrl) {
      fail("context_mismatch", "The enrollment context targets a different control plane.");
    }
    canonicalIdentifier(context?.userId, "context.userId");
    canonicalIdentifier(context?.organizationId, "context.organizationId");

    // This durable pending write intentionally precedes the one-time network exchange.
    const pending = await credentials.prepareEnrollment(context);
    const binding = await exchangeEnrollmentGrant({
      grant,
      displayName,
      platform,
      publicKey: pending.publicKey,
      expectedUserId: context.userId,
      expectedOrganizationId: context.organizationId,
      signal,
    });
    return credentials.completeEnrollment(context, binding);
  }

  /** @param {string} deviceId @param {string} keyId @returns {Promise<any>} */
  async function fetchChallenge(deviceId, keyId) {
    canonicalUuid(deviceId, "deviceId");
    canonicalUuid(keyId, "keyId");
    const payload = await post(`${urls.apiBaseUrl}/v1/desktop-devices/${deviceId}/auth-challenges`, {
      schemaVersion: REMOTE_CONTROL_CLOUD_SCHEMA_VERSION,
      keyId,
    }, 201, undefined, { acceptedDeviceStatusCodes: DEVICE_STATUS_ERROR_CODES });
    exactObject(payload, [
      "schemaVersion", "challengeId", "challenge", "deviceId", "keyId", "audience", "resource", "scopes", "expiresAt",
    ], "challenge response");
    if (payload.schemaVersion !== REMOTE_CONTROL_CLOUD_SCHEMA_VERSION) fail("invalid_response", "The challenge schema version is unsupported.");
    canonicalUuid(payload.challengeId, "challengeId");
    canonicalOpaque(payload.challenge, "jwdpop_", "challenge");
    canonicalDate(payload.expiresAt, "challenge.expiresAt");
    if (
      payload.deviceId !== deviceId ||
      payload.keyId !== keyId ||
      payload.audience !== DESKTOP_AGENT_AUDIENCE ||
      payload.resource !== urls.resourceUrl ||
      !Array.isArray(payload.scopes) ||
      payload.scopes.length !== 1 ||
      payload.scopes[0] !== DESKTOP_AGENT_SCOPE ||
      new Date(payload.expiresAt).getTime() <= new Date(now()).getTime()
    ) {
      fail("challenge_binding_mismatch", "The Desktop-agent challenge is expired or incorrectly bound.");
    }
    return payload;
  }

  /** @param {RemoteControlIssueTokenOptions} input @returns {Promise<Readonly<RemoteControlAgentToken>>} */
  async function issueAgentToken({ credentials, context }) {
    if (!credentials || typeof credentials.getSigningCredential !== "function") {
      fail("invalid_client", "A remote-control credential store is required.");
    }
    const contextUrls = deriveRemoteControlCloudUrls(context?.controlPlaneBaseUrl, { allowInsecureLoopback });
    if (contextUrls.controlPlaneBaseUrl !== urls.controlPlaneBaseUrl) {
      fail("context_mismatch", "The authentication context targets a different control plane.");
    }
    const credential = await credentials.getSigningCredential(context);
    const challenge = await fetchChallenge(credential.deviceId, credential.keyId);
    const message = buildDesktopAgentProofSigningMessage({
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      deviceId: credential.deviceId,
      keyId: credential.keyId,
      resource: challenge.resource,
    });
    let privateKey;
    let signature;
    try {
      privateKey = credential.privateKey instanceof KeyObject
        ? credential.privateKey
        : createPrivateKey(credential.privateKey);
      if (privateKey.type !== "private") throw new Error("not a private key");
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
      signature = signer(null, message, privateKey);
    } catch (cause) {
      fail("signing_failed", "The device proof could not be signed with Ed25519.", { cause });
    }
    const canonicalSignature = Buffer.from(signature).toString("base64url");
    canonicalBase64Url(canonicalSignature, 64, "Ed25519 signature", "signing_failed");

    const payload = await post(`${urls.apiBaseUrl}/v1/desktop-devices/${credential.deviceId}/agent-tokens`, {
      schemaVersion: REMOTE_CONTROL_CLOUD_SCHEMA_VERSION,
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      keyId: credential.keyId,
      signature: canonicalSignature,
    }, 200, undefined, { acceptedDeviceStatusCodes: DEVICE_STATUS_ERROR_CODES });
    exactObject(payload, [
      "schemaVersion", "tokenType", "accessToken", "deviceId", "audience", "resource", "scopes", "expiresAt",
    ], "agent token response");
    if (payload.schemaVersion !== REMOTE_CONTROL_CLOUD_SCHEMA_VERSION) fail("invalid_response", "The agent-token schema version is unsupported.");
    canonicalOpaque(payload.accessToken, "jwdagent_", "accessToken");
    canonicalDate(payload.expiresAt, "agentToken.expiresAt");
    if (
      payload.tokenType !== "Bearer" ||
      payload.deviceId !== credential.deviceId ||
      payload.audience !== DESKTOP_AGENT_AUDIENCE ||
      payload.resource !== urls.resourceUrl ||
      !Array.isArray(payload.scopes) ||
      payload.scopes.length !== 1 ||
      payload.scopes[0] !== DESKTOP_AGENT_SCOPE ||
      new Date(payload.expiresAt).getTime() <= new Date(now()).getTime()
    ) {
      fail("token_binding_mismatch", "The Desktop-agent token is expired or incorrectly bound.");
    }
    return Object.freeze({
      accessToken: payload.accessToken,
      tokenType: "Bearer",
      expiresAt: payload.expiresAt,
      resource: payload.resource,
      webSocketUrl: urls.webSocketUrl,
    });
  }

  return Object.freeze({ urls, enrollDevice, issueAgentToken });
}
