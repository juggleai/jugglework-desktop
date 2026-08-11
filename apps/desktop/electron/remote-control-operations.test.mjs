import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REMOTE_CONTROL_REQUIRED_GATES,
  RemoteControlOperationExecutionError,
  createRemoteControlOperationRegistry,
} from "./remote-control-operations.mjs";

const enabledReadGates = {
  enrollment: true,
  readOnlyControl: true,
  sessionMutation: false,
  interactions: false,
};

/** @typedef {NonNullable<Parameters<typeof createRemoteControlOperationRegistry>[0]>["registrations"][number]} OperationRegistration */
/** @typedef {Parameters<OperationRegistration["execute"]>[0]} OperationExecutionInput */

/** @param {Partial<OperationRegistration>} [overrides] @returns {OperationRegistration} */
function readRegistration(overrides = {}) {
  return {
    operation: "workspace.list",
    payloadVersions: [1],
    requiredGates: [...REMOTE_CONTROL_REQUIRED_GATES["workspace.list"]],
    validateArguments(value) {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) {
        throw new TypeError("invalid");
      }
      return Object.freeze({});
    },
    async execute() {
      return { workspaces: [] };
    },
    ...overrides,
  };
}

/** @param {string} [operation] @param {number[]} [payloadVersions] */
function advertised(operation = "workspace.list", payloadVersions = [1]) {
  return { schemaVersion: 1, operations: [{ operation, payloadVersions }], features: [] };
}

describe("remote-control operation registry", () => {
  it("starts empty and never claims unimplemented production read handlers", async () => {
    const registry = createRemoteControlOperationRegistry({
      getFeatureGates: () => enabledReadGates,
      isOperationAllowed: () => true,
    });

    assert.deepEqual(await registry.advertise(), {
      schemaVersion: 1,
      operations: [],
      features: [],
    });
    assert.equal(
      (await registry.dispatch(
        { operation: "workspace.list", payloadVersion: 1, arguments: {} },
        { advertisedCapabilities: advertised() },
      )).error.code,
      "operation_unsupported",
    );
  });

  it("advertises only registered handlers whose required gates are enabled", async () => {
    const registry = createRemoteControlOperationRegistry({
      registrations: [
        readRegistration(),
        {
          operation: "session.prompt",
          payloadVersions: [1],
          requiredGates: [...REMOTE_CONTROL_REQUIRED_GATES["session.prompt"]],
          validateArguments: (value) => value,
          execute: async () => ({ runId: "run", generation: 1 }),
        },
      ],
      getFeatureGates: () => enabledReadGates,
      isOperationAllowed: () => true,
    });

    assert.deepEqual(await registry.advertise(), advertised());
  });

  it("advertises E2EE only when its gate and secure local key storage are ready", async () => {
    let ready = true;
    let checks = 0;
    const registry = createRemoteControlOperationRegistry({
      registrations: [readRegistration()],
      getFeatureGates: () => ({ ...enabledReadGates, payloadEncryption: true }),
      isOperationAllowed: () => true,
      isPayloadEncryptionReady: async () => {
        checks += 1;
        return ready;
      },
    });

    assert.deepEqual((await registry.advertise()).features, ["payload.e2ee-v1"]);
    ready = false;
    assert.deepEqual((await registry.advertise()).features, []);
    assert.equal(checks, 2);

    const disabled = createRemoteControlOperationRegistry({
      getFeatureGates: () => ({ ...enabledReadGates, payloadEncryption: false }),
      isPayloadEncryptionReady: () => { throw new Error("must not run"); },
    });
    assert.deepEqual((await disabled.advertise()).features, []);
  });

  it("fails closed when the secure-key readiness check fails", async () => {
    const registry = createRemoteControlOperationRegistry({
      getFeatureGates: () => ({ ...enabledReadGates, payloadEncryption: true }),
      isPayloadEncryptionReady: async () => { throw new Error("keychain unavailable"); },
    });

    assert.deepEqual((await registry.advertise()).features, []);
  });

  it("registers session.create behind all mutation gates", async () => {
    const create = {
      operation: "session.create",
      payloadVersions: [1],
      requiredGates: [...REMOTE_CONTROL_REQUIRED_GATES["session.create"]],
      validateArguments: (value) => value,
      execute: async () => ({ sessionId: "ses_created" }),
    };
    const registry = createRemoteControlOperationRegistry({
      registrations: [create],
      getFeatureGates: () => ({ ...enabledReadGates, sessionMutation: true }),
      isOperationAllowed: () => true,
    });
    assert.deepEqual(await registry.advertise(), advertised("session.create"));
    assert.deepEqual(REMOTE_CONTROL_REQUIRED_GATES["session.create"], ["enrollment", "readOnlyControl", "sessionMutation"]);
  });

  it("requires explicit closed registrations", () => {
    assert.throws(
      () => createRemoteControlOperationRegistry({ registrations: [readRegistration({ operation: "http.proxy" })] }),
      /known semantic operation/,
    );
    assert.throws(
      () => createRemoteControlOperationRegistry({
        registrations: [readRegistration(/** @type {Partial<OperationRegistration>} */ ({ execute: undefined }))],
      }),
      /validation and execution handlers/,
    );
    assert.throws(
      () => createRemoteControlOperationRegistry({
        registrations: [readRegistration({ requiredGates: ["enrollment"] })],
      }),
      /required gates/,
    );
  });

  it("rejects unknown operations, unsupported versions, disabled gates, denied policy, and unadvertised calls before execute", async () => {
    let executions = 0;
    let gates = enabledReadGates;
    let allowed = true;
    const registry = createRemoteControlOperationRegistry({
      registrations: [readRegistration({ execute: async () => { executions += 1; } })],
      getFeatureGates: () => gates,
      isOperationAllowed: () => allowed,
    });
    const context = { localOnly: true };

    const unknown = await registry.dispatch(
      { operation: "http.proxy", payloadVersion: 1, arguments: { url: "http://localhost" } },
      { advertisedCapabilities: advertised(), context, correlationId: "corr-1" },
    );
    assert.deepEqual(unknown, {
      ok: false,
      error: {
        schemaVersion: 1,
        code: "operation_unsupported",
        message: "The remote operation is not supported.",
        retryable: false,
        correlationId: "corr-1",
      },
    });

    assert.equal(
      (await registry.dispatch(
        { operation: "workspace.list", payloadVersion: 2, arguments: {} },
        { advertisedCapabilities: advertised() },
      )).error.code,
      "payload_version_unsupported",
    );

    gates = { ...enabledReadGates, readOnlyControl: false };
    assert.equal(
      (await registry.dispatch(
        { operation: "workspace.list", payloadVersion: 1, arguments: {} },
        { advertisedCapabilities: advertised() },
      )).error.code,
      "feature_disabled",
    );

    gates = enabledReadGates;
    allowed = false;
    assert.equal(
      (await registry.dispatch(
        { operation: "workspace.list", payloadVersion: 1, arguments: {} },
        { advertisedCapabilities: advertised() },
      )).error.code,
      "forbidden",
    );

    allowed = true;
    assert.equal(
      (await registry.dispatch(
        { operation: "workspace.list", payloadVersion: 1, arguments: {} },
        { advertisedCapabilities: { schemaVersion: 1, operations: [], features: [] } },
      )).error.code,
      "capability_not_advertised",
    );
    assert.equal(executions, 0);
  });

  it("validates arguments before executing and passes only validated semantic input", async () => {
    /** @type {OperationExecutionInput[]} */
    const calls = [];
    const registry = createRemoteControlOperationRegistry({
      registrations: [
        readRegistration({
          validateArguments(value) {
            if (!value || typeof value !== "object" || !("safe" in value) || value.safe !== true) {
              throw new TypeError("unsafe");
            }
            return { safe: true };
          },
          async execute(value) {
            calls.push(value);
            return { workspaces: [] };
          },
        }),
      ],
      getFeatureGates: () => enabledReadGates,
      isOperationAllowed: () => true,
    });
    const context = { source: "remote" };

    assert.equal(
      (await registry.dispatch(
        { operation: "workspace.list", payloadVersion: 1, arguments: { unsafe: true } },
        { advertisedCapabilities: advertised(), context },
      )).error.code,
      "invalid_request",
    );
    assert.equal(calls.length, 0);

    assert.deepEqual(
      await registry.dispatch(
        { operation: "workspace.list", payloadVersion: 1, arguments: { safe: true } },
        { advertisedCapabilities: advertised(), context },
      ),
      { ok: true, value: { workspaces: [] } },
    );
    assert.deepEqual(calls, [{
      operation: "workspace.list",
      payloadVersion: 1,
      arguments: { safe: true },
        context,
        correlationId: null,
    }]);
  });

  it("passes only a safe correlationId to execute and preserves currentRunId in controlled errors", async () => {
    const seen = [];
    const registry = createRemoteControlOperationRegistry({
      registrations: [readRegistration({
        execute(input) {
          seen.push(input.correlationId);
          throw new RemoteControlOperationExecutionError("run_mismatch", { currentRunId: "run_current" });
        },
      })],
      getFeatureGates: () => enabledReadGates,
      isOperationAllowed: () => true,
    });
    const request = { operation: "workspace.list", payloadVersion: 1, arguments: {} };
    const result = await registry.dispatch(request, { advertisedCapabilities: advertised(), correlationId: "command_safe" });
    assert.deepEqual(seen, ["command_safe"]);
    assert.equal(result.error.currentRunId, "run_current");

    await registry.dispatch(request, { advertisedCapabilities: advertised(), correlationId: "bad\ncommand" });
    assert.deepEqual(seen, ["command_safe", null]);
  });

  it("returns content-minimized deterministic errors for unavailable policy and handler failures", async () => {
    const policyUnavailable = createRemoteControlOperationRegistry({
      registrations: [readRegistration()],
      getFeatureGates() {
        throw new Error("secret policy backend details");
      },
    });
    const failedHandler = createRemoteControlOperationRegistry({
      registrations: [readRegistration({ execute() { throw new Error("local path /private/project"); } })],
      getFeatureGates: () => enabledReadGates,
      isOperationAllowed: () => true,
    });

    const policyResult = await policyUnavailable.dispatch(
      { operation: "workspace.list", payloadVersion: 1, arguments: {} },
      { advertisedCapabilities: advertised(), correlationId: "bad\ncorrelation" },
    );
    assert.deepEqual(policyResult.error, {
      schemaVersion: 1,
      code: "policy_unavailable",
      message: "Remote operation policy is unavailable.",
      retryable: true,
      correlationId: null,
    });

    const handlerResult = await failedHandler.dispatch(
      { operation: "workspace.list", payloadVersion: 1, arguments: {} },
      { advertisedCapabilities: advertised() },
    );
    assert.equal(handlerResult.error.code, "internal_error");
    assert.doesNotMatch(JSON.stringify(handlerResult), /private|project/);
  });

  it("maps controlled adapter failures without leaking raw exceptions", async () => {
    /** @type {Array<readonly ["workspace_not_found" | "session_not_found" | "internal_error", boolean]>} */
    const cases = [["workspace_not_found", false], ["session_not_found", false], ["internal_error", false]];
    for (const [code, retryable] of cases) {
      const registry = createRemoteControlOperationRegistry({
        registrations: [readRegistration({ execute() { throw new RemoteControlOperationExecutionError(code); } })],
        getFeatureGates: () => enabledReadGates,
        isOperationAllowed: () => true,
      });
      const result = await registry.dispatch(
        { operation: "workspace.list", payloadVersion: 1, arguments: {} },
        { advertisedCapabilities: advertised(), correlationId: "corr-typed" },
      );
      assert.equal(result.error.code, code);
      assert.equal(result.error.retryable, retryable);
      assert.equal(result.error.correlationId, "corr-typed");
      assert.doesNotMatch(JSON.stringify(result), /stack|private|token/);
    }
  });
});
