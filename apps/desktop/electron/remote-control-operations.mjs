export const REMOTE_CONTROL_OPERATION_SCHEMA_VERSION = 1;
export const REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION = 1;

/** @typedef {"invalid_request" | "feature_disabled" | "policy_unavailable" | "forbidden" | "operation_unsupported" | "payload_version_unsupported" | "capability_not_advertised" | "workspace_not_found" | "session_not_found" | "session_busy" | "run_mismatch" | "interaction_not_found" | "interaction_expired" | "already_resolved" | "internal_error"} RemoteControlOperationErrorCode */
/** @typedef {{ operation: string, payloadVersions: number[] }} RemoteControlOperationCapability */
/** @typedef {{ schemaVersion: number, operations: RemoteControlOperationCapability[], features: string[] }} RemoteControlCapabilityAdvertisement */
/** @typedef {{ schemaVersion: number, code: RemoteControlOperationErrorCode, message: string, retryable: boolean, correlationId: string | null }} RemoteControlOperationError */
/** @typedef {{ ok: boolean, value?: unknown, error?: RemoteControlOperationError }} RemoteControlOperationDispatchResult */
/** @typedef {{ operation: string, payloadVersion: number, arguments: unknown, context: unknown }} RemoteControlOperationExecutionInput */
/**
 * @typedef {{
 *   operation: string,
 *   payloadVersions: readonly number[],
 *   requiredGates: readonly string[],
 *   validateArguments(argumentsValue: unknown): unknown | Promise<unknown>,
 *   execute(input: RemoteControlOperationExecutionInput): unknown | Promise<unknown>
 * }} RemoteControlOperationRegistration
 */
/** @typedef {{ registrations?: RemoteControlOperationRegistration[], getFeatureGates?: (context: unknown) => unknown | Promise<unknown>, isOperationAllowed?: (input: { operation: string, context: unknown }) => boolean | Promise<boolean> }} RemoteControlOperationRegistryOptions */
/** @typedef {{ advertisedCapabilities?: unknown, context?: unknown, correlationId?: unknown }} RemoteControlOperationDispatchOptions */
/** @typedef {{ advertise(context?: unknown): Promise<RemoteControlCapabilityAdvertisement>, dispatch(request: unknown, options?: RemoteControlOperationDispatchOptions): Promise<RemoteControlOperationDispatchResult> }} RemoteControlOperationRegistry */

/** @type {Array<readonly [string, readonly string[]]>} */
const OPERATION_DEFINITIONS = [
  ["workspace.list", ["enrollment", "readOnlyControl"]],
  ["session.list", ["enrollment", "readOnlyControl"]],
  ["session.snapshot", ["enrollment", "readOnlyControl"]],
  ["session.prompt", ["enrollment", "readOnlyControl", "sessionMutation"]],
  ["session.abort", ["enrollment", "readOnlyControl", "sessionMutation"]],
  [
    "interaction.permission.reply",
    ["enrollment", "readOnlyControl", "sessionMutation", "interactions"],
  ],
  [
    "interaction.question.reply",
    ["enrollment", "readOnlyControl", "sessionMutation", "interactions"],
  ],
];

export const REMOTE_CONTROL_OPERATION_NAMES = Object.freeze(
  OPERATION_DEFINITIONS.map(([operation]) => operation),
);

/** @type {Readonly<Record<string, readonly string[]>>} */
export const REMOTE_CONTROL_REQUIRED_GATES = Object.freeze(
  Object.fromEntries(
    OPERATION_DEFINITIONS.map(([operation, requiredGates]) => [
      operation,
      Object.freeze([...requiredGates]),
    ]),
  ),
);

/** @type {Readonly<Record<RemoteControlOperationErrorCode, readonly [string, boolean]>>} */
const ERROR_DETAILS = Object.freeze({
  invalid_request: ["The remote operation request is invalid.", false],
  feature_disabled: ["The remote operation is disabled.", false],
  policy_unavailable: ["Remote operation policy is unavailable.", true],
  forbidden: ["The remote operation is denied by policy.", false],
  operation_unsupported: ["The remote operation is not supported.", false],
  payload_version_unsupported: ["The remote operation payload version is not supported.", false],
  capability_not_advertised: ["The remote operation was not advertised.", false],
  workspace_not_found: ["The workspace was not found.", false],
  session_not_found: ["The session was not found.", false],
  session_busy: ["The session is busy with an active run.", false],
  run_mismatch: ["The expected run does not match the active run.", false],
  interaction_not_found: ["The interaction was not found.", false],
  interaction_expired: ["The interaction has expired.", false],
  already_resolved: ["The interaction was already resolved.", false],
  internal_error: ["The remote operation failed.", false],
});

export class RemoteControlOperationExecutionError extends Error {
  /**
   * @param {string} code
   * @param {{ currentRunId?: string } | undefined} [metadata]
   */
  constructor(code, metadata) {
    super("The remote operation failed.");
    this.name = "RemoteControlOperationExecutionError";
    this.code = code;
    if (metadata && typeof metadata.currentRunId === "string") {
      this.currentRunId = metadata.currentRunId;
    }
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {string | null} */
function safeCorrelationId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

/** @param {RemoteControlOperationErrorCode} code @param {unknown} correlationId @returns {RemoteControlOperationError} */
function operationError(code, correlationId) {
  const [message, retryable] = ERROR_DETAILS[code];
  return {
    schemaVersion: REMOTE_CONTROL_OPERATION_SCHEMA_VERSION,
    code,
    message,
    retryable,
    correlationId: safeCorrelationId(correlationId),
  };
}

/** @param {RemoteControlOperationErrorCode} code @param {unknown} correlationId @returns {RemoteControlOperationDispatchResult} */
function rejected(code, correlationId) {
  return { ok: false, error: operationError(code, correlationId) };
}

/** @param {readonly string[]} left @param {readonly string[]} right */
function sameItems(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

/** @param {RemoteControlOperationRegistration} registration @returns {Readonly<RemoteControlOperationRegistration>} */
function normalizeRegistration(registration) {
  if (!isRecord(registration) || !REMOTE_CONTROL_OPERATION_NAMES.includes(registration.operation)) {
    throw new TypeError("Remote operation registrations must name a known semantic operation.");
  }

  const requiredGates = REMOTE_CONTROL_REQUIRED_GATES[registration.operation];
  if (!Array.isArray(registration.requiredGates) || !sameItems(registration.requiredGates, requiredGates)) {
    throw new TypeError(`Remote operation ${registration.operation} must declare its required gates.`);
  }

  if (
    !Array.isArray(registration.payloadVersions) ||
    registration.payloadVersions.length !== 1 ||
    registration.payloadVersions[0] !== REMOTE_CONTROL_OPERATION_PAYLOAD_VERSION
  ) {
    throw new TypeError(`Remote operation ${registration.operation} must explicitly support payload version 1.`);
  }
  if (typeof registration.validateArguments !== "function" || typeof registration.execute !== "function") {
    throw new TypeError(`Remote operation ${registration.operation} requires validation and execution handlers.`);
  }

  return Object.freeze({
    operation: registration.operation,
    payloadVersions: Object.freeze([...registration.payloadVersions]),
    requiredGates: Object.freeze([...registration.requiredGates]),
    validateArguments: registration.validateArguments,
    execute: registration.execute,
  });
}

/** @param {Readonly<RemoteControlOperationRegistration>} registration @param {unknown} gates */
function gatesEnable(registration, gates) {
  return isRecord(gates) && registration.requiredGates.every((gate) => gates[gate] === true);
}

/** @param {unknown} advertisement @param {string} operation @param {number} payloadVersion */
function advertisedIncludes(advertisement, operation, payloadVersion) {
  if (!isRecord(advertisement) || !Array.isArray(advertisement.operations)) return false;
  return advertisement.operations.some(
    (capability) =>
      isRecord(capability) &&
      capability.operation === operation &&
      Array.isArray(capability.payloadVersions) &&
      capability.payloadVersions.includes(payloadVersion),
  );
}

/**
 * Creates a closed semantic operation boundary. No production handlers are
 * registered here; later phases must inject each concrete local adapter.
 *
 * @param {RemoteControlOperationRegistryOptions} options
 * @returns {RemoteControlOperationRegistry}
 */
export function createRemoteControlOperationRegistry({
  registrations = [],
  getFeatureGates = () => ({}),
  isOperationAllowed = () => false,
} = {}) {
  if (!Array.isArray(registrations)) {
    throw new TypeError("Remote operation registrations must be an array.");
  }
  if (typeof getFeatureGates !== "function" || typeof isOperationAllowed !== "function") {
    throw new TypeError("Remote operation policy dependencies must be functions.");
  }

  /** @type {Map<string, Readonly<RemoteControlOperationRegistration>>} */
  const handlers = new Map();
  for (const candidate of registrations) {
    const registration = normalizeRegistration(candidate);
    if (handlers.has(registration.operation)) {
      throw new TypeError(`Remote operation ${registration.operation} is registered more than once.`);
    }
    handlers.set(registration.operation, registration);
  }

  /** @param {unknown} [context] @returns {Promise<RemoteControlCapabilityAdvertisement>} */
  async function advertise(context) {
    let gates;
    try {
      gates = await getFeatureGates(context);
    } catch {
      gates = null;
    }

    return {
      schemaVersion: REMOTE_CONTROL_OPERATION_SCHEMA_VERSION,
      operations: REMOTE_CONTROL_OPERATION_NAMES.flatMap((operation) => {
        const registration = handlers.get(operation);
        return registration && gatesEnable(registration, gates)
          ? [{ operation, payloadVersions: [...registration.payloadVersions] }]
          : [];
      }),
      features: [],
    };
  }

  /**
   * @param {unknown} request
   * @param {RemoteControlOperationDispatchOptions} [options]
   * @returns {Promise<RemoteControlOperationDispatchResult>}
   */
  async function dispatch(
    request,
    { advertisedCapabilities, context, correlationId = null } = {},
  ) {
    if (!isRecord(request) || typeof request.operation !== "string") {
      return rejected("invalid_request", correlationId);
    }

    const registration = handlers.get(request.operation);
    if (!registration) return rejected("operation_unsupported", correlationId);

    if (
      typeof request.payloadVersion !== "number" ||
      !registration.payloadVersions.includes(request.payloadVersion)
    ) {
      return rejected("payload_version_unsupported", correlationId);
    }

    let gates;
    try {
      gates = await getFeatureGates(context);
    } catch {
      return rejected("policy_unavailable", correlationId);
    }
    if (!gatesEnable(registration, gates)) return rejected("feature_disabled", correlationId);

    let allowed;
    try {
      allowed = await isOperationAllowed({ operation: registration.operation, context });
    } catch {
      return rejected("policy_unavailable", correlationId);
    }
    if (allowed !== true) return rejected("forbidden", correlationId);

    if (!advertisedIncludes(advertisedCapabilities, request.operation, request.payloadVersion)) {
      return rejected("capability_not_advertised", correlationId);
    }

    if (
      !Object.hasOwn(request, "arguments") ||
      Object.keys(request).some((key) => !["operation", "payloadVersion", "arguments"].includes(key))
    ) {
      return rejected("invalid_request", correlationId);
    }

    let validatedArguments;
    try {
      validatedArguments = await registration.validateArguments(request.arguments);
    } catch {
      return rejected("invalid_request", correlationId);
    }

    try {
      const value = await registration.execute({
        operation: registration.operation,
        payloadVersion: request.payloadVersion,
        arguments: validatedArguments,
        context,
      });
      return { ok: true, value };
    } catch (error) {
      if (error instanceof RemoteControlOperationExecutionError && Object.hasOwn(ERROR_DETAILS, error.code)) {
        return rejected(/** @type {RemoteControlOperationErrorCode} */ (error.code), correlationId);
      }
      return rejected("internal_error", correlationId);
    }
  }

  return Object.freeze({ advertise, dispatch });
}
