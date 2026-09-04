import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  REMOTE_CONTROL_AGENT_STATUS,
  createRemoteControlAgent,
  normalizeRemoteControlAgentContext,
} from "./remote-control-agent.mjs";
import { RemoteControlCloudError } from "./remote-control-cloud-client.mjs";
import {
  canonicalRemoteControlAAD,
  decryptRemoteControlPayload,
  deriveRemoteControlE2EEKey,
  encryptRemoteControlPayload,
  remoteControlE2EEKeyId,
} from "./remote-control-e2ee.mjs";
import { createRemoteControlMutationRegistrations } from "./remote-control-mutation-adapters.mjs";
import { createRemoteControlOperationRegistry } from "./remote-control-operations.mjs";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const NEW_DEVICE_ID = "99999999-9999-4999-8999-999999999999";
const COMMAND_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CONTROL_ID = SESSION_ID;
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const URL = "https://cloud.example.test/jwork/api";
const REPLACEMENT_INPUT = Object.freeze({
  grant: "renderer-one-time-grant",
  scope: { controlPlaneBaseUrl: URL, userId: "user-1", organizationId: "org-1" },
});

const disabledGates = Object.freeze({
  schemaVersion: 1,
  enrollment: false,
  readOnlyControl: false,
  sessionMutation: false,
  interactions: false,
  backgroundLifecycle: false,
  eventCompaction: false,
  multiInstanceRouting: false,
  payloadEncryption: false,
  busySessionSteer: false,
  busySessionEnqueue: false,
  nativeMobile: false,
});

const readGates = Object.freeze({ ...disabledGates, enrollment: true, readOnlyControl: true });
const readCapabilities = Object.freeze({
  schemaVersion: 1,
  operations: [{ operation: "workspace.list", payloadVersions: [1] }],
  features: [],
});

/** @typedef {{ schemaVersion: number, signedIn: boolean, controlPlaneBaseUrl: string | null, userId: string | null, organizationId: string | null, policyFresh: boolean, featureGates: Record<string, boolean | number>, policyVersion: string | null, validatedAt: string | null }} TestContext */
/** @typedef {{ schemaVersion: number, state: string, context: { controlPlaneBaseUrl: string, userId: string, organizationId: string }, deviceId: string }} TestCredential */

/** @param {Partial<TestContext>} [overrides] */
function signedInContext(overrides = {}) {
  return {
    schemaVersion: 1,
    signedIn: true,
    controlPlaneBaseUrl: URL,
    userId: "user-1",
    organizationId: "org-1",
    policyFresh: true,
    featureGates: readGates,
    policyVersion: "policy-1",
    validatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function signedOutContext() {
  return {
    schemaVersion: 1,
    signedIn: false,
    controlPlaneBaseUrl: null,
    userId: null,
    organizationId: null,
    policyFresh: false,
    featureGates: disabledGates,
    policyVersion: null,
    validatedAt: null,
  };
}

/** @param {Partial<TestCredential>} [overrides] */
function enrolledCredential(overrides = {}) {
  return {
    schemaVersion: 1,
    state: "enrolled",
    context: { controlPlaneBaseUrl: URL, userId: "user-1", organizationId: "org-1" },
    deviceId: DEVICE_ID,
    ...overrides,
  };
}

class FakeClock {
  constructor() {
    this.time = NOW;
    this.nextId = 1;
    /** @type {Map<number, { at: number, callback: () => void }>} */
    this.pending = new Map();
    this.timers = {
      setTimeout: (callback, delay = 0) => {
        const id = this.nextId++;
        this.pending.set(id, { at: this.time + Math.max(0, delay), callback });
        return id;
      },
      clearTimeout: (id) => { this.pending.delete(id); },
    };
  }

  now = () => new Date(this.time);

  /** @param {number} milliseconds */
  async advance(milliseconds) {
    const destination = this.time + milliseconds;
    while (true) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= destination)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      this.time = due[1].at;
      this.pending.delete(due[0]);
      due[1].callback();
      await settle();
    }
    this.time = destination;
    await settle();
  }

  nextDelay() {
    const next = [...this.pending.values()].sort((left, right) => left.at - right.at)[0];
    return next ? next.at - this.time : null;
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    /** @type {Array<Record<string, any>>} */
    this.sent = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
    this.closed = false;
  }

  send(data) {
    if (this.closed) throw new Error("closed");
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closeCalls += 1;
    this.closed = true;
  }

  terminate() {
    this.terminateCalls += 1;
    this.closed = true;
  }

  open() {
    this.emit("open");
  }

  /** @param {Record<string, any>} value */
  receive(value) {
    this.emit("message", JSON.stringify(value));
  }

  unexpectedClose(code = 1006, reason = Buffer.alloc(0)) {
    this.emit("close", code, reason);
  }
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

/** @param {string} type @param {unknown} payload @param {Partial<Record<string, unknown>>} [overrides] */
function envelope(type, payload, overrides = {}) {
  return {
    protocolVersion: 1,
    payloadVersion: 1,
    messageId: MESSAGE_ID,
    sentAt: new Date(NOW).toISOString(),
    encryption: { mode: "none", keyId: null },
    type,
    payload,
    ...overrides,
  };
}

/** @param {number} [generation] */
function welcome(generation = 41) {
  return envelope("connection.welcome", {
    deviceId: DEVICE_ID,
    connectionGeneration: generation,
    heartbeatSeconds: 10,
    staleSeconds: 20,
    offlineSeconds: 30,
  });
}

/** @param {Partial<Record<string, unknown>>} [overrides] */
function delivery(overrides = {}) {
  const base = {
    schemaVersion: 1,
    commandId: COMMAND_ID,
    controlSessionId: SESSION_ID,
    deviceId: DEVICE_ID,
    actor: { userId: "controller-1", displayName: "Controller" },
    request: { operation: "workspace.list", payloadVersion: 1, arguments: {} },
    idempotencyKey: null,
    payloadHash: "a".repeat(64),
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 30_000).toISOString(),
  };
  return envelope("command.deliver", { ...base, ...overrides });
}

function successLifecycle() {
  return {
    status: "succeeded",
    occurredAt: new Date(NOW + 1_000).toISOString(),
    result: { operation: "workspace.list", payloadVersion: 1, result: { workspaces: [] } },
    error: null,
  };
}

/** @param {{ enrolled?: boolean, enabled?: boolean, initialCredential?: any, credentialReadError?: Error | null, credentialDeleteError?: Error | null, capabilities?: typeof readCapabilities, operationRegistry?: any, e2eeKeyStore?: any, signingCredential?: any, prepare?: (command: unknown) => Promise<any>, dispatch?: (request: unknown, options: unknown) => Promise<any>, enrollDevice?: (input: unknown) => Promise<any>, issueAgentToken?: (call: number) => Promise<any>, tokenLifetime?: number, localStopAckTimeoutMs?: number, oldOperationDrainTimeoutMs?: number, revocationVerifyMaxDelayMs?: number, getActiveRuns?: () => unknown, verifySessionBinding?: (binding: unknown, options?: { signal?: AbortSignal }) => boolean | Promise<boolean>, onSessionBinding?: (binding: unknown) => boolean | void, onSessionUnbound?: (input: unknown) => void, onTransportReset?: (input: unknown) => void, onControlRevoked?: (input: unknown) => void, onPolicyExpired?: () => void, onAuthorizationChanged?: (authorized: boolean) => void, issueTokenError?: Error }} [input] */
function harness({
  enrolled = true,
  enabled = true,
  initialCredential = undefined,
  credentialReadError = null,
  credentialDeleteError = null,
  capabilities = readCapabilities,
  operationRegistry: operationRegistryOverride = null,
  e2eeKeyStore = null,
  signingCredential = {},
  prepare = async () => ({ action: "execute", commandId: COMMAND_ID }),
  dispatch = async () => ({ ok: true, value: { workspaces: [] } }),
  enrollDevice: enrollDeviceOverride = null,
  issueAgentToken: issueAgentTokenOverride = null,
  tokenLifetime = 120_000,
  localStopAckTimeoutMs = 1_500,
  oldOperationDrainTimeoutMs = 2_000,
  revocationVerifyMaxDelayMs = 5 * 60_000,
  getActiveRuns = () => [],
  verifySessionBinding = async () => true,
  onSessionBinding = () => {},
  onSessionUnbound = () => {},
  onTransportReset = () => {},
  onControlRevoked = () => {},
  onPolicyExpired = () => {},
  onAuthorizationChanged = () => {},
  issueTokenError = null,
} = {}) {
  const clock = new FakeClock();
  let settings = { schemaVersion: 1, enabled, preventSleepWhileWaiting: enabled, backgroundMode: false, launchAtLogin: false, allowBusySessionSteer: false, allowBusySessionEnqueue: false };
  let credential = initialCredential === undefined ? (enrolled ? enrolledCredential() : null) : initialCredential;
  let uuid = 10;
  let tokenCalls = 0;
  let enrollmentCalls = 0;
  let deleteCalls = 0;
  let disableSettingsCalls = 0;
  let e2eeActiveCalls = 0;
  let e2eeRevokeCalls = 0;
  const logs = [];
  /** @type {FakeSocket[]} */
  const sockets = [];
  /** @type {Array<Record<string, any>>} */
  const prepareCalls = [];
  /** @type {Array<{ commandId: any, lifecycle: any }>} */
  const completeCalls = [];
  /** @type {Array<Record<string, any>>} */
  const dispatchCalls = [];
  /** @type {Array<Record<string, any>>} */
  const webSocketInputs = [];
  const credentialStore = {
    inspect: async () => {
      if (credentialReadError) return { state: "corrupt" };
      return { state: credential?.state ?? "absent" };
    },
    read: async () => {
      if (credentialReadError) throw credentialReadError;
      return credential;
    },
    prepareEnrollment: async () => ({}),
    completeEnrollment: async () => ({}),
    getSigningCredential: async () => signingCredential,
    delete: async () => { deleteCalls += 1; if (credentialDeleteError) throw credentialDeleteError; credential = null; },
  };
  const operationRegistry = operationRegistryOverride ?? {
    advertise: async () => JSON.parse(JSON.stringify(capabilities)),
    dispatch: async (request, /** @type {Record<string, any>} */ options) => {
      dispatchCalls.push({ request, options });
      return dispatch(request, options);
    },
  };
  const commandJournal = {
    prepare: async (command) => { prepareCalls.push(command); return prepare(command); },
    complete: async (commandId, lifecycle) => {
      completeCalls.push({ commandId, lifecycle });
      return { action: "recorded", commandId, lifecycle };
    },
  };
  const createCloudClient = () => ({
    enrollDevice: async ({ context, grant, displayName, platform }) => {
      enrollmentCalls += 1;
      assert.deepEqual(context, { controlPlaneBaseUrl: URL, userId: "user-1", organizationId: "org-1" });
      assert.equal(grant, "renderer-one-time-grant");
      assert.equal(displayName, "Test Mac");
      assert.equal(platform, "darwin");
      if (enrollDeviceOverride) {
        credential = await enrollDeviceOverride({ context, grant, displayName, platform });
        return credential;
      }
      credential = enrolledCredential();
      return credential;
    },
    issueAgentToken: async () => {
      tokenCalls += 1;
      if (issueAgentTokenOverride) return issueAgentTokenOverride(tokenCalls);
      if (issueTokenError) throw issueTokenError;
      return {
        accessToken: `short-lived-token-${tokenCalls}`,
        expiresAt: new Date(clock.time + tokenLifetime).toISOString(),
        webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
      };
    },
  });
  const agent = createRemoteControlAgent({
    settingsStore: {
      read: async () => ({ ...settings }),
      disable: async () => {
        disableSettingsCalls += 1;
        settings = { schemaVersion: 1, enabled: false, preventSleepWhileWaiting: false, backgroundMode: false, launchAtLogin: false, allowBusySessionSteer: false, allowBusySessionEnqueue: false };
        return { ...settings };
      },
    },
    credentialStore,
    e2eeKeyStore: e2eeKeyStore ?? {
      active: async () => { e2eeActiveCalls += 1; return {}; },
      advertisement: async () => ({}),
      privateKey: async () => ({}),
      revokeAll: async () => { e2eeRevokeCalls += 1; },
    },
    operationRegistry,
    commandJournal,
    createCloudClient,
    createWebSocket: (input) => {
      webSocketInputs.push(input);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    appVersion: "1.2.3-beta.1",
    platform: "darwin",
    getDisplayName: () => "Test Mac",
    now: clock.now,
    randomUUID: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(uuid++).padStart(12, "0")}`,
    timers: clock.timers,
    logger: {
      debug: (message, metadata) => logs.push({ level: "debug", message, metadata }),
      info: (message, metadata) => logs.push({ level: "info", message, metadata }),
      warn: (message, metadata) => logs.push({ level: "warn", message, metadata }),
      error: (message, metadata) => logs.push({ level: "error", message, metadata }),
    },
    localStopAckTimeoutMs,
    oldOperationDrainTimeoutMs,
    revocationVerifyMaxDelayMs,
    getActiveRuns,
    verifySessionBinding,
    onSessionBinding,
    onSessionUnbound,
    onTransportReset,
    onControlRevoked,
    onPolicyExpired,
    onAuthorizationChanged,
  });
  return {
    agent,
    clock,
    sockets,
    prepareCalls,
    completeCalls,
    dispatchCalls,
    webSocketInputs,
    logs,
    get tokenCalls() { return tokenCalls; },
    get enrollmentCalls() { return enrollmentCalls; },
    get deleteCalls() { return deleteCalls; },
    get disableSettingsCalls() { return disableSettingsCalls; },
    get credential() { return credential; },
    get e2eeActiveCalls() { return e2eeActiveCalls; },
    get e2eeRevokeCalls() { return e2eeRevokeCalls; },
    setSettings(next) { settings = { ...next }; },
  };
}

/** @param {ReturnType<typeof harness>} fixture */
async function connect(fixture) {
  await fixture.agent.start();
  await fixture.agent.syncContext(signedInContext());
  assert.equal(fixture.sockets.length, 1);
  fixture.sockets[0].open();
  await settle();
  return fixture.sockets[0];
}

/** @param {FakeSocket} socket @param {string} type */
function frames(socket, type) {
  return socket.sent.filter((frame) => frame.type === type);
}

describe("remote-control agent context and lifecycle", () => {
  it("strictly normalizes context and fails closed on expanded or partial gates", () => {
    assert.equal(normalizeRemoteControlAgentContext(signedInContext()).controlPlaneBaseUrl, URL);
    assert.throws(() => normalizeRemoteControlAgentContext({ ...signedInContext(), unknown: true }), /strict/);
    assert.throws(() => normalizeRemoteControlAgentContext({
      ...signedInContext(),
      featureGates: { schemaVersion: 1, enrollment: true },
    }), /complete/);
    assert.throws(() => normalizeRemoteControlAgentContext({
      ...signedOutContext(),
      userId: "still-signed-in",
    }), /clear identity/);
  });

  it("does not connect without started, fresh signed-in policy, both base gates, and local enablement", async () => {
    const fixture = harness({
      enabled: false,
      enrollDevice: async () => enrolledCredential({ deviceId: NEW_DEVICE_ID }),
    });
    await fixture.agent.syncContext(signedInContext());
    assert.equal(fixture.sockets.length, 0);
    await fixture.agent.start();
    assert.equal(fixture.sockets.length, 0);

    fixture.setSettings({ schemaVersion: 1, enabled: true, backgroundMode: false, launchAtLogin: false });
    await fixture.agent.refreshLocalSettings();
    assert.equal(fixture.sockets.length, 1);
    await fixture.agent.syncContext(signedInContext({ policyFresh: false, validatedAt: null }));
    assert.equal(fixture.sockets[0].closeCalls, 1);

    await fixture.agent.syncContext(signedInContext({ featureGates: { ...readGates, readOnlyControl: false } }));
    assert.equal(fixture.sockets.length, 1);
    await fixture.agent.syncContext(signedOutContext());
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.WAITING_FOR_CONTEXT);
  });

  it("repairs enabled-without-credential to disabled before fresh replacement", async () => {
    const fixture = harness({ enrolled: false });
    await fixture.agent.start();
    assert.equal(fixture.agent.status().locallyDisabled, true);
    assert.equal(fixture.disableSettingsCalls, 1);
    assert.equal(fixture.sockets.length, 0);
    await fixture.agent.syncContext(signedInContext());
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.DISABLED);
    assert.equal(fixture.disableSettingsCalls, 1);
    assert.equal(fixture.e2eeRevokeCalls, 1);
    assert.equal(fixture.sockets.length, 0);
  });

  it("removes pending credentials and E2EE material during enabled startup repair", async () => {
    const fixture = harness({
      initialCredential: {
        schemaVersion: 1,
        state: "pending",
        context: { controlPlaneBaseUrl: URL, userId: "user-1", organizationId: "org-1" },
      },
    });
    await fixture.agent.start();
    assert.equal(fixture.agent.status().locallyDisabled, true);
    assert.equal(fixture.disableSettingsCalls, 1);
    await fixture.agent.syncContext(signedInContext());
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.DISABLED);
    assert.equal(fixture.disableSettingsCalls, 1);
    assert.equal(fixture.deleteCalls, 1);
    assert.equal(fixture.e2eeRevokeCalls, 1);
  });

  it("removes corrupt credentials and fails closed during enabled startup repair", async () => {
    const fixture = harness({ credentialReadError: Object.assign(new Error("corrupt private material"), { code: "credentials_corrupt" }) });
    await fixture.agent.start();
    assert.equal(fixture.agent.status().locallyDisabled, true);
    assert.equal(fixture.disableSettingsCalls, 1);
    await fixture.agent.syncContext(signedInContext());
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.DISABLED);
    assert.equal(fixture.disableSettingsCalls, 1);
    assert.equal(fixture.deleteCalls, 1);
    assert.equal(fixture.e2eeRevokeCalls, 1);
    assert.doesNotMatch(JSON.stringify(fixture.agent.status()), /private material/);
  });

  it("retains an enrolled credential when startup settings are locally disabled", async () => {
    const fixture = harness({ enabled: false });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.DISABLED);
    assert.equal(fixture.agent.status().locallyDisabled, true);
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.e2eeRevokeCalls, 0);
    assert.equal(fixture.credential.deviceId, DEVICE_ID);
    assert.equal(fixture.sockets.length, 0);
  });

  it("keeps an enabled complete credential awaiting renderer context without disabling it", async () => {
    const fixture = harness();
    const started = await fixture.agent.start();
    assert.equal(started.state, REMOTE_CONTROL_AGENT_STATUS.WAITING_FOR_CONTEXT);
    assert.equal(started.locallyDisabled, false);
    assert.equal(fixture.disableSettingsCalls, 0);
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.sockets.length, 0);
  });

  it("projects interrupted replacement credentials as disabled and not enrolled after restart", async () => {
    const fixture = harness({
      enabled: false,
      initialCredential: {
        schemaVersion: 1,
        state: "pending",
        context: { controlPlaneBaseUrl: URL, userId: "user-1", organizationId: "org-1" },
      },
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.DISABLED);
    assert.equal(fixture.agent.status().enrolled, false);
    assert.equal(fixture.agent.status().locallyDisabled, true);
    assert.equal(fixture.sockets.length, 0);
  });

  it("replaces identity only while locally disabled and remains disconnected until enabled", async () => {
    const fixture = harness({
      enabled: false,
      enrollDevice: async () => enrolledCredential({ deviceId: NEW_DEVICE_ID }),
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    const beforeGeneration = fixture.agent.status().lifecycleGeneration;
    const replaced = await fixture.agent.replaceIdentity(REPLACEMENT_INPUT);
    assert.equal(fixture.deleteCalls, 1);
    assert.equal(fixture.e2eeRevokeCalls, 1);
    assert.equal(fixture.e2eeActiveCalls, 1);
    assert.equal(fixture.enrollmentCalls, 1);
    assert.equal(replaced.enrolled, true);
    assert.equal(fixture.credential.deviceId, NEW_DEVICE_ID);
    assert.equal(replaced.connected, false);
    assert.equal(replaced.state, REMOTE_CONTROL_AGENT_STATUS.DISABLED);
    assert.ok(replaced.lifecycleGeneration > beforeGeneration);
    assert.equal(fixture.sockets.length, 0);
  });

  it("rejects a grant captured for another exact scope before destructive replacement", async () => {
    const fixture = harness({ enabled: false });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    for (const scope of [
      { ...REPLACEMENT_INPUT.scope, controlPlaneBaseUrl: "https://other.example.test" },
      { ...REPLACEMENT_INPUT.scope, userId: "user-2" },
      { ...REPLACEMENT_INPUT.scope, organizationId: "org-2" },
    ]) {
      await assert.rejects(fixture.agent.replaceIdentity({ ...REPLACEMENT_INPUT, scope }), /scope changed/);
    }
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.enrollmentCalls, 0);
  });

  it("cleans replacement credentials when authorization context changes during enrollment", async () => {
    /** @type {() => void} */
    let releaseEnrollment = () => {};
    // A context switch advances lifecycle generation while the enrollment
    // promise is awaiting Cloud, so the late result must be deleted.
    const gate = new Promise((resolve) => { releaseEnrollment = () => resolve(); });
    const fixture = harness({
      enabled: false,
      enrollDevice: async () => {
        await gate;
        return enrolledCredential({ deviceId: NEW_DEVICE_ID });
      },
    });
    const realAgent = fixture.agent;
    await realAgent.start();
    await realAgent.syncContext(signedInContext());
    const replacement = realAgent.replaceIdentity(REPLACEMENT_INPUT);
    await Promise.resolve();
    await Promise.resolve();
    await realAgent.syncContext(signedInContext({ userId: "user-2" }));
    releaseEnrollment();
    await assert.rejects(replacement);
    assert.equal(realAgent.status().enrolled, false);
    assert.ok(fixture.deleteCalls >= 2);
  });

  it("cleans a newly enrolled identity when replacement is aborted during deferred enrollment", async () => {
    let releaseEnrollment = () => {};
    let enrollmentStarted = () => {};
    const started = new Promise((resolve) => { enrollmentStarted = () => resolve(); });
    const gate = new Promise((resolve) => { releaseEnrollment = () => resolve(); });
    const fixture = harness({
      enabled: false,
      enrollDevice: async () => {
        enrollmentStarted();
        await gate;
        return enrolledCredential({ deviceId: NEW_DEVICE_ID });
      },
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    const controller = new AbortController();
    const replacement = fixture.agent.replaceIdentity(REPLACEMENT_INPUT, { signal: controller.signal });
    await started;
    controller.abort();
    releaseEnrollment();
    await assert.rejects(replacement);
    assert.equal(fixture.agent.status().enrolled, false);
    assert.equal(fixture.deleteCalls, 2);
    assert.equal(fixture.e2eeRevokeCalls, 2);
  });

  it("independently attempts credential and E2EE cleanup and returns only a stable diagnostic", async () => {
    for (const [credentialFails, e2eeFails] of [[true, false], [false, true], [true, true]]) {
      let revokeCalls = 0;
      const fixture = harness({
        enabled: false,
        credentialDeleteError: credentialFails ? new Error("credential secret path") : null,
        e2eeKeyStore: {
          active: async () => ({}),
          advertisement: async () => ({}),
          privateKey: async () => ({}),
          revokeAll: async () => { revokeCalls += 1; if (e2eeFails) throw new Error("e2ee secret path"); },
        },
      });
      await fixture.agent.start();
      await assert.rejects(fixture.agent.deleteCredential(), (error) => {
        assert.equal(/** @type {any} */ (error).code, "credentials_delete_failed");
        assert.equal(/** @type {any} */ (error).message, "Device credential cleanup failed.");
        assert.doesNotMatch(JSON.stringify(error), /secret path/i);
        return true;
      });
      assert.equal(fixture.deleteCalls, 1);
      assert.equal(revokeCalls, 1);
      assert.equal(fixture.agent.status().lastErrorCode, "credentials_delete_failed");
    }
  });

  it("sends a strict hello and advertises only registry-provided registered operations", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    const hello = frames(socket, "device.hello")[0];
    assert.deepEqual(Object.keys(hello).sort(), [
      "encryption", "messageId", "payload", "payloadVersion", "protocolVersion", "sentAt", "type",
    ]);
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.payloadVersion, 1);
    assert.match(hello.messageId, /^[0-9a-f-]{36}$/);
    assert.equal(hello.encryption.mode, "none");
    assert.equal(hello.encryption.keyId, null);
    assert.deepEqual(hello.payload, {
      deviceId: DEVICE_ID,
      connectionGeneration: 1,
      appVersion: "1.2.3-beta.1",
      capabilities: readCapabilities,
      activeRuns: [],
      policyVersion: "policy-1",
      localControlEnabled: true,
    });
    assert.equal(JSON.stringify(socket.sent).includes("short-lived-token"), false);
  });

  it("adopts the welcome generation for heartbeats and answers strict cloud ping with pong", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    assert.equal(fixture.agent.status().connectionGeneration, 77);

    socket.receive(envelope("cloud.ping", { nonce: "ping-1" }));
    assert.deepEqual(frames(socket, "device.pong")[0].payload, { nonce: "ping-1" });
    await fixture.clock.advance(10_000);
    const heartbeat = frames(socket, "device.heartbeat")[0];
    assert.equal(heartbeat.payload.connectionGeneration, 77);
    assert.deepEqual(heartbeat.payload.capabilities, readCapabilities);
    assert.deepEqual(heartbeat.payload.activeRuns, []);
    assert.equal(heartbeat.payload.policyVersion, "policy-1");
    assert.equal(heartbeat.payload.localControlEnabled, true);
  });

  it("terminates a silent welcomed socket and reuses its still-valid token", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    await fixture.clock.advance(21_000);
    assert.equal(socket.terminateCalls, 1);
    assert.equal(fixture.agent.status().lastErrorCode, "transport_stale");
    const delay = fixture.clock.nextDelay();
    assert.ok(delay >= 250 && delay <= 30_000);
    await fixture.clock.advance(delay);
    assert.equal(fixture.sockets.length, 2);
    assert.equal(fixture.tokenCalls, 1);
    assert.equal(fixture.webSocketInputs.at(-1).accessToken, "short-lived-token-1");
  });

  it("refreshes the liveness deadline on every inbound cloud frame", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await fixture.clock.advance(19_000);
    socket.receive(envelope("cloud.ping", { nonce: "still-alive" }));
    await fixture.clock.advance(19_000);
    assert.equal(socket.terminateCalls, 0);
  });

  it("normalizes and caps active runs in hello and heartbeat", async () => {
    const runs = Array.from({ length: 105 }, (_, index) => ({
      workspaceId: `ws_${index}`,
      sessionId: `ses_${index}`,
      runId: `run_${index}`,
      status: "running",
    }));
    runs.splice(1, 0, { workspaceId: "ws_0", sessionId: "ses_0", runId: "duplicate", status: "running" });
    runs.splice(2, 0, { workspaceId: "bad", sessionId: "bad", runId: "bad", status: "unknown" });
    const fixture = harness({ getActiveRuns: () => runs });
    const socket = await connect(fixture);
    assert.equal(frames(socket, "device.hello")[0].payload.activeRuns.length, 100);
    assert.equal(frames(socket, "device.hello")[0].payload.activeRuns[1].workspaceId, "ws_1");
    socket.receive(welcome());
    await fixture.clock.advance(10_000);
    assert.equal(frames(socket, "device.heartbeat")[0].payload.activeRuns.length, 100);
  });

  it("proactively refreshes the short-lived token without persisting it", async () => {
    const fixture = harness({ tokenLifetime: 120_000 });
    const first = await connect(fixture);
    assert.equal(fixture.tokenCalls, 1);
    await fixture.clock.advance(59_999);
    assert.equal(fixture.tokenCalls, 1);
    await fixture.clock.advance(1);
    assert.equal(fixture.tokenCalls, 2);
    assert.equal(fixture.sockets.length, 2);
    assert.equal(first.closeCalls, 1);
    assert.equal(fixture.webSocketInputs[1].accessToken, "short-lived-token-2");
    assert.equal(JSON.stringify(fixture.agent.status()).includes("token"), false);
  });

  it("fails closed when independently tracked policy freshness expires", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    assert.equal(socket.closeCalls, 0);
    await fixture.clock.advance(6 * 60_000);
    assert.equal(socket.closeCalls + socket.terminateCalls, 1);
    assert.equal(fixture.agent.status().localControlEnabled, false);
    assert.equal(fixture.agent.status().lastErrorCode, "policy_unavailable");
  });

  it("re-arms retained policy expiry after replacement and closes before reconnect or publish", async () => {
    const expired = [];
    const fixture = harness({
      enabled: false,
      enrollDevice: async () => enrolledCredential({ deviceId: NEW_DEVICE_ID }),
      onPolicyExpired: () => { expired.push(true); },
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    await fixture.agent.replaceIdentity(REPLACEMENT_INPUT);
    await fixture.clock.advance(6 * 60_000);
    fixture.setSettings({ schemaVersion: 1, enabled: true, backgroundMode: false, launchAtLogin: false });
    await fixture.agent.refreshLocalSettings();
    assert.equal(fixture.sockets.length, 0);
    assert.equal(fixture.agent.status().lastErrorCode, "policy_unavailable");
    assert.equal(expired.length, 1);
    assert.equal(fixture.agent.publishSessionEvent({}, { connectionGeneration: 1 }), false);
  });

  it("suspend reports offline, fences transport and timers, and resume waits for fresh policy and token", async () => {
    const authorizations = [];
    let policyExpired = 0;
    const fixture = harness({
      capabilities: { ...readCapabilities, operations: [{ operation: "session.create", payloadVersions: [1] }] },
      onAuthorizationChanged: (authorized) => authorizations.push(authorized),
      onPolicyExpired: () => { policyExpired += 1; },
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext({ featureGates: { ...readGates, sessionMutation: true } }));
    const socket = fixture.sockets[0];
    socket.open();
    await settle();
    socket.receive(welcome(77));
    await settle();
    assert.deepEqual(authorizations, [true]);

    const suspending = fixture.agent.suspend();
    assert.equal(socket.closeCalls + socket.terminateCalls, 1);
    assert.equal(fixture.agent.status().lastErrorCode, "device_offline");
    assert.equal(fixture.agent.status().localControlEnabled, false);
    assert.equal(fixture.clock.nextDelay(), null);
    await suspending;
    assert.deepEqual(authorizations, [true, false]);
    assert.equal(policyExpired, 1);

    await fixture.agent.resume();
    await fixture.agent.resume();
    assert.equal(fixture.sockets.length, 1);
    assert.equal(fixture.clock.nextDelay(), null);
    fixture.clock.time += 1;
    await fixture.agent.syncContext(signedInContext({
      validatedAt: new Date(fixture.clock.time).toISOString(),
      policyVersion: "policy-2",
      featureGates: { ...readGates, sessionMutation: true },
    }));
    assert.equal(fixture.sockets.length, 2);
    assert.equal(fixture.tokenCalls, 2);
  });

  it("authorizes remote waiting sleep prevention while the base remote policy is fresh", async () => {
    const authorizations = [];
    const fixture = harness({ onAuthorizationChanged: (authorized) => authorizations.push(authorized) });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    assert.deepEqual(authorizations, [true]);
    await fixture.agent.syncContext(signedInContext({ policyFresh: false, validatedAt: null }));
    assert.deepEqual(authorizations, [true, false]);
  });

  it("reconnects with bounded jitter and ignores stale socket events", async () => {
    const fixture = harness();
    const first = await connect(fixture);
    first.receive(welcome(77));
    await settle();
    first.unexpectedClose();
    const delay = fixture.clock.nextDelay();
    assert.ok(delay >= 250 && delay <= 30_000);
    await fixture.clock.advance(delay);
    assert.equal(fixture.sockets.length, 2);
    assert.equal(fixture.tokenCalls, 1, "ordinary reconnect reuses the valid in-memory token");
    assert.equal(fixture.webSocketInputs[1].accessToken, "short-lived-token-1");
    const second = fixture.sockets[1];
    second.open();
    await settle();

    const staleSent = first.sent.length;
    first.receive(envelope("cloud.ping", { nonce: "stale" }));
    first.unexpectedClose();
    await settle();
    assert.equal(first.sent.length, staleSent);
    assert.equal(fixture.sockets.length, 2);
  });

  it("clears a reused token after pre-welcome rejection and mints a fresh one", async () => {
    const fixture = harness({ tokenLifetime: 120_000 });
    const first = await connect(fixture);
    first.receive(welcome(77));
    await settle();

    first.unexpectedClose();
    await fixture.clock.advance(fixture.clock.nextDelay());
    assert.equal(fixture.tokenCalls, 1);
    const reused = fixture.sockets[1];
    reused.open();
    await settle();
    reused.unexpectedClose(1008, Buffer.from("bearer rejected"));
    await fixture.clock.advance(fixture.clock.nextDelay());

    assert.equal(fixture.tokenCalls, 2, "pre-welcome rejection invalidates the cache");
    assert.equal(fixture.webSocketInputs.at(-1).accessToken, "short-lived-token-2");
  });

  it("clears a reused token after a retryable pre-welcome protocol rejection", async () => {
    const fixture = harness();
    const first = await connect(fixture);
    first.receive(welcome(77));
    await settle();
    first.unexpectedClose();
    await fixture.clock.advance(fixture.clock.nextDelay());
    const reused = fixture.sockets[1];
    reused.open();
    await settle();

    reused.receive(envelope("protocol.error", {
      schemaVersion: 1, code: "unauthorized", message: "Retry authentication.", retryable: true, correlationId: null,
    }));
    await settle();
    await fixture.clock.advance(fixture.clock.nextDelay());

    assert.equal(fixture.tokenCalls, 2);
    assert.equal(fixture.webSocketInputs.at(-1).accessToken, "short-lived-token-2");
  });

  it("mints a fresh token when the cached token is inside the handshake margin", async () => {
    const fixture = harness({ tokenLifetime: 30_000 });
    const first = await connect(fixture);
    first.receive(welcome(77));
    await settle();
    first.unexpectedClose();
    await fixture.clock.advance(fixture.clock.nextDelay());

    assert.equal(fixture.tokenCalls, 2);
    assert.equal(fixture.webSocketInputs.at(-1).accessToken, "short-lived-token-2");
  });

  it("clears the token when same-identity policy authorization is lost", async () => {
    const fixture = harness();
    const first = await connect(fixture);
    first.receive(welcome(77));
    await settle();

    await fixture.agent.syncContext(signedInContext({ policyFresh: false, validatedAt: null }));
    fixture.clock.time += 1;
    await fixture.agent.syncContext(signedInContext({
      policyVersion: "policy-2",
      validatedAt: new Date(fixture.clock.time).toISOString(),
    }));

    assert.equal(fixture.tokenCalls, 2);
    assert.equal(fixture.webSocketInputs.at(-1).accessToken, "short-lived-token-2");
  });

  it("retains the server close code and sanitized reason for diagnostics", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    socket.unexpectedClose(1008, Buffer.from("invalid device identity"));
    assert.equal(fixture.agent.status().lastErrorCode, "transport_closed_1008_invalid_device_identity");
  });

  it("synchronously resets transport state on failure and socket replacement", async () => {
    let resets = 0;
    const fixture = harness({ onTransportReset: () => { resets += 1; } });
    const first = await connect(fixture);
    const beforeFailure = resets;
    first.unexpectedClose();
    assert.equal(resets, beforeFailure + 1);
    await fixture.clock.advance(fixture.clock.nextDelay());
    fixture.sockets[1].open();
    await settle();
    await fixture.clock.advance(60_000);
    assert.ok(resets >= 2);
  });

  it("reports disconnect transitions only when transport reset had active control", async () => {
    const resets = [];
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.snapshot", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({ capabilities, onTransportReset: (input) => resets.push(input) });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    const beforeIdleFailure = resets.length;
    socket.unexpectedClose();
    assert.deepEqual(resets.at(-1), { hadActiveControl: false, transition: null });
    await fixture.clock.advance(fixture.clock.nextDelay());
    const controlled = fixture.sockets.at(-1);
    controlled.open();
    await settle();
    controlled.receive(welcome(78));
    controlled.receive(delivery({
      request: { operation: "session.snapshot", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_1" } },
    }));
    await settle();
    controlled.unexpectedClose();
    assert.deepEqual(resets.at(-1), { hadActiveControl: true, transition: 1 });
    assert.ok(resets.length > beforeIdleFailure);
  });

  it("does not classify an ordinary disconnect as a local stop", async () => {
    const revocations = [];
    const fixture = harness({ onControlRevoked: (input) => revocations.push(input) });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    socket.unexpectedClose();
    assert.deepEqual(revocations, []);
    assert.equal(frames(socket, "device.local_stop").length, 0);
  });

  it("local disable, stop-all, signout, account switch, and stop synchronously fence reconnect", async () => {
    const fixture = harness();
    const first = await connect(fixture);
    first.unexpectedClose();
    fixture.agent.stopAll();
    assert.equal(fixture.clock.nextDelay(), null);
    assert.equal(fixture.agent.status().localControlEnabled, false);

    fixture.setSettings({ schemaVersion: 1, enabled: false, backgroundMode: false, launchAtLogin: false });
    await fixture.agent.refreshLocalSettings();
    fixture.setSettings({ schemaVersion: 1, enabled: true, backgroundMode: false, launchAtLogin: false });
    await fixture.agent.refreshLocalSettings();
    const current = fixture.sockets.at(-1);
    assert.equal(fixture.tokenCalls, 2, "local disable clears the cached token before re-enable");
    const signout = fixture.agent.syncContext(signedOutContext());
    assert.equal(current.closeCalls, 1);
    await signout;

    await fixture.agent.syncContext(signedInContext());
    assert.equal(fixture.tokenCalls, 3, "identity context changes cannot reuse the prior token");
    const accountSocket = fixture.sockets.at(-1);
    const switched = fixture.agent.syncContext(signedInContext({ userId: "user-2" }));
    assert.equal(accountSocket.closeCalls, 1);
    await switched;

    const stopping = fixture.agent.stop();
    assert.equal(fixture.clock.nextDelay(), null);
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.STOPPED);
    await stopping;
  });

  it("an authenticated device.revoked envelope is terminal without another probe", async () => {
    const revocations = [];
    const fixture = harness({ onControlRevoked: (input) => revocations.push(input) });
    const socket = await connect(fixture);
    socket.receive(envelope("device.revoked", { deviceId: DEVICE_ID, reason: "Revoked by owner" }));
    await settle();
    assert.equal(socket.closeCalls, 1);
    assert.equal(fixture.deleteCalls, 1);
    assert.equal(fixture.disableSettingsCalls, 1);
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.REVOKED);
    assert.equal(fixture.agent.status().revoked, true);
    assert.equal(fixture.agent.status().revocationPending, false);
    assert.equal(fixture.agent.status().enrolled, false);
    assert.equal(fixture.clock.nextDelay(), null);
    assert.equal(fixture.tokenCalls, 1, "authenticated WS revocation does not require a probe");
    assert.deepEqual(revocations, [{ source: "cloud", transition: 1 }]);
  });

  it("converges protocol device_revoked through the same healthy verification path", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    socket.receive(envelope("protocol.error", {
      schemaVersion: 1,
      code: "device_revoked",
      message: "The remote device was revoked.",
      retryable: false,
      correlationId: null,
    }));
    await settle();
    assert.equal(fixture.agent.status().revoked, false);
    assert.equal(fixture.agent.status().revocationPending, false);
    assert.equal(fixture.sockets.length, 2);
    assert.ok(fixture.logs.some((entry) => entry.metadata?.code === "spurious_revocation_signal" &&
      entry.metadata?.source === "protocol.error.device_revoked" && entry.metadata?.count === 1));
  });

  it("a cloud-disabled device keeps credentials and reconnects until access is restored", async () => {
    const revocations = [];
    const fixture = harness({ onControlRevoked: (input) => revocations.push(input) });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    socket.receive(envelope("device.disabled", { deviceId: DEVICE_ID, reason: "Remote control was disabled" }));
    socket.unexpectedClose(1008, Buffer.from("device disabled"));
    await settle();
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.BACKOFF);
    assert.equal(fixture.agent.status().lastErrorCode, "device_disabled");
    assert.equal(fixture.agent.status().enrolled, true);
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.disableSettingsCalls, 0);
    assert.deepEqual(revocations, [], "suspension is not revocation");
    const delay = fixture.clock.nextDelay();
    assert.ok(delay >= 250 && delay <= 30_000, "a reconnect backoff is scheduled");

    await fixture.clock.advance(delay);
    assert.equal(fixture.sockets.length, 2, "a fresh authenticated socket is created");
    assert.equal(fixture.tokenCalls, 2, "the retry performs a new challenge/token handshake");
    fixture.sockets[1].open();
    await settle();
    fixture.sockets[1].receive(welcome(77));
    await settle();
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.CONNECTED);
    assert.equal(fixture.webSocketInputs.at(-1).accessToken, "short-lived-token-2");
  });

  it("cloud disable fences an in-flight proactive refresh before it can install a transport", async () => {
    let refreshStarted = () => {};
    let releaseRefresh = () => {};
    const started = new Promise((resolve) => { refreshStarted = () => resolve(); });
    const gate = new Promise((resolve) => { releaseRefresh = () => resolve(); });
    const fixture = harness({
      issueAgentToken: async (call) => {
        if (call === 2) {
          refreshStarted();
          await gate;
        }
        return {
          accessToken: `token-${call}`,
          expiresAt: new Date(NOW + 120_000).toISOString(),
          webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
        };
      },
    });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();

    for (const nonce of ["keepalive-1", "keepalive-2", "keepalive-3"]) {
      await fixture.clock.advance(19_000);
      socket.receive(envelope("cloud.ping", { nonce }));
      await settle();
    }
    await fixture.clock.advance(3_000);
    await started;
    socket.receive(envelope("device.disabled", { deviceId: DEVICE_ID, reason: "Remote control was disabled" }));
    await settle();
    releaseRefresh();
    await settle();

    assert.equal(fixture.sockets.length, 1, "stale refresh cannot install a replacement socket");
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.BACKOFF);
  });

  it("an explicit cloud-disable refresh rejection clears the token and current transport", async () => {
    const fixture = harness({
      issueAgentToken: async (call) => {
        if (call === 2) throw new RemoteControlCloudError("device_disabled", "Device disabled.", { status: 403 });
        return {
          accessToken: `token-${call}`,
          expiresAt: new Date(NOW + 120_000).toISOString(),
          webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
        };
      },
    });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();

    for (const nonce of ["keepalive-1", "keepalive-2", "keepalive-3"]) {
      await fixture.clock.advance(19_000);
      socket.receive(envelope("cloud.ping", { nonce }));
      await settle();
    }
    await fixture.clock.advance(3_000);

    assert.equal(socket.closeCalls + socket.terminateCalls, 1);
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.BACKOFF);
    assert.equal(fixture.agent.status().lastErrorCode, "device_disabled");
    await fixture.clock.advance(fixture.clock.nextDelay());
    assert.equal(fixture.tokenCalls, 3, "retry mints fresh auth instead of reusing the disabled token");
    assert.equal(fixture.webSocketInputs.at(-1).accessToken, "token-3");
  });

  it("a malformed disabled notice fails the transport without deleting credentials", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    socket.receive(envelope("device.disabled", { deviceId: "11111111-2222-4333-8444-555555555555", reason: "Not this device" }));
    await settle();
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.BACKOFF);
    assert.equal(fixture.agent.status().lastErrorCode, "invalid_disabled_notice");
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.disableSettingsCalls, 0);
    assert.notEqual(fixture.clock.nextDelay(), null, "the normal retry path stays armed");
  });

  it("durably revokes after an explicit matching-credential challenge/token result", async () => {
    const revocations = [];
    const fixture = harness({
      onControlRevoked: (input) => revocations.push(input),
      issueAgentToken: async (call) => {
        if (call === 1) return {
          accessToken: "initial-token",
          expiresAt: new Date(NOW + 120_000).toISOString(),
          webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
        };
        throw new RemoteControlCloudError("device_revoked", "Explicit device_revoked.", { status: 403 });
      },
    });
    const socket = await connect(fixture);
    socket.receive(envelope("protocol.error", {
      schemaVersion: 1,
      code: "device_revoked",
      message: "The remote device was revoked.",
      retryable: false,
      correlationId: null,
    }));
    await settle();
    assert.equal(fixture.deleteCalls, 1);
    assert.equal(fixture.e2eeRevokeCalls, 1);
    assert.equal(fixture.disableSettingsCalls, 1);
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.REVOKED);
    assert.equal(fixture.agent.status().revoked, true);
    assert.equal(fixture.agent.status().revocationPending, false);
    assert.equal(fixture.agent.status().enrolled, false);
    assert.equal(fixture.agent.status().lastErrorCode, "device_revoked");
    assert.equal(fixture.clock.nextDelay(), null, "confirmed revocation is terminal");
    assert.deepEqual(revocations, [{ source: "cloud", transition: 1 }]);
    await fixture.clock.advance(10 * 60_000);
    assert.equal(fixture.tokenCalls, 2, "confirmed revocation never probes or reconnects again");
  });

  it("never treats ambiguous 401 or 404 probe responses as confirmed revocation", async () => {
    for (const status of [401, 404]) {
      const fixture = harness({
        issueAgentToken: async (call) => {
          if (call === 1) return {
            accessToken: "initial-token",
            expiresAt: new Date(NOW + 120_000).toISOString(),
            webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
          };
          throw new RemoteControlCloudError("unexpected_status", `HTTP ${status}.`, { status });
        },
      });
      const socket = await connect(fixture);
      socket.receive(envelope("protocol.error", {
        schemaVersion: 1, code: "device_revoked", message: "Unconfirmed", retryable: false, correlationId: null,
      }));
      await settle();
      assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.VERIFYING_REVOCATION);
      assert.equal(fixture.agent.status().revocationPending, true);
      assert.equal(fixture.agent.status().revoked, false);
      assert.equal(fixture.agent.status().lastErrorCode, "revocation_unconfirmed");
      assert.equal(fixture.deleteCalls, 0);
      assert.equal(fixture.disableSettingsCalls, 0);
      assert.equal(fixture.credential.deviceId, DEVICE_ID);
      assert.notEqual(fixture.clock.nextDelay(), null);
    }
  });

  it("routes a direct token 404 through verification without treating either 404 as deletion", async () => {
    const fixture = harness({
      issueTokenError: new RemoteControlCloudError("unexpected_status", "The control plane returned HTTP 404.", { status: 404 }),
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    await settle();
    assert.equal(fixture.tokenCalls, 2, "the first 404 signal is followed by one verification probe");
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.VERIFYING_REVOCATION);
    assert.equal(fixture.agent.status().revocationPending, true);
    assert.equal(fixture.agent.status().revoked, false);
    assert.equal(fixture.agent.status().enrolled, true);
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.disableSettingsCalls, 0);
    assert.notEqual(fixture.clock.nextDelay(), null);
  });

  it("bounds repeated generic 404 verification and asks for re-registration without deleting credentials", async () => {
    const fixture = harness({
      issueAgentToken: async () => {
        throw new RemoteControlCloudError("unexpected_status", "The control plane returned HTTP 404.", { status: 404 });
      },
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    await settle();
    for (let attempt = 1; attempt < 3; attempt += 1) {
      const delay = fixture.clock.nextDelay();
      assert.notEqual(delay, null);
      await fixture.clock.advance(delay);
    }
    assert.equal(fixture.tokenCalls, 4, "one initial failure plus three bounded verification probes");
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.DISABLED);
    assert.equal(fixture.agent.status().lastErrorCode, "device_reregistration_required");
    assert.equal(fixture.agent.status().revocationPending, false);
    assert.equal(fixture.agent.status().revoked, false);
    assert.equal(fixture.agent.status().enrolled, true);
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.disableSettingsCalls, 1);
    assert.equal(fixture.credential.deviceId, DEVICE_ID);
    assert.equal(fixture.clock.nextDelay(), null, "generic not-found probing terminates");
  });

  it("rate-limits unavailable verification with capped backoff while preserving credentials and settings", async () => {
    const fixture = harness({
      revocationVerifyMaxDelayMs: 5_000,
      issueAgentToken: async (call) => {
        if (call === 1) return {
          accessToken: "initial-token",
          expiresAt: new Date(NOW + 120_000).toISOString(),
          webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
        };
        throw new RemoteControlCloudError("network_unavailable", "Offline.");
      },
    });
    const socket = await connect(fixture);
    socket.receive(envelope("protocol.error", {
      schemaVersion: 1, code: "device_revoked", message: "Unconfirmed", retryable: false, correlationId: null,
    }));
    await settle();
    const delays = [];
    for (let index = 0; index < 6; index += 1) {
      const delay = fixture.clock.nextDelay();
      assert.notEqual(delay, null);
      delays.push(delay);
      await fixture.clock.advance(delay);
    }
    assert.ok(delays.every((delay) => delay >= 250 && delay <= 5_000));
    assert.ok(delays.at(-1) >= 4_000 && delays.at(-1) <= 5_000, "the jittered delay remains within the configured cap");
    assert.equal(fixture.agent.status().revocationPending, true);
    assert.equal(fixture.agent.status().revoked, false);
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.disableSettingsCalls, 0);
    assert.equal(fixture.credential.deviceId, DEVICE_ID);
  });

  it("keeps the independent policy expiry armed while revocation verification is unavailable", async () => {
    const fixture = harness({
      issueAgentToken: async (call) => {
        if (call === 1) return {
          accessToken: "initial-token",
          expiresAt: new Date(NOW + 120_000).toISOString(),
          webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
        };
        throw new RemoteControlCloudError("network_unavailable", "Offline.");
      },
    });
    const socket = await connect(fixture);
    socket.receive(envelope("protocol.error", {
      schemaVersion: 1, code: "device_revoked", message: "Unconfirmed", retryable: false, correlationId: null,
    }));
    await settle();
    await fixture.clock.advance(6 * 60_000);
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.DISABLED);
    assert.equal(fixture.agent.status().lastErrorCode, "policy_unavailable");
    assert.equal(fixture.agent.status().revocationPending, true);
    assert.equal(fixture.agent.status().localControlEnabled, false);
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.clock.nextDelay(), null);
  });

  it("maps an explicit disabled verification result to the reversible suspension path", async () => {
    const fixture = harness({
      issueAgentToken: async (call) => {
        if (call === 2) throw new RemoteControlCloudError("device_disabled", "Device disabled.", { status: 403 });
        return {
          accessToken: `token-${call}`,
          expiresAt: new Date(NOW + 120_000).toISOString(),
          webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
        };
      },
    });
    const socket = await connect(fixture);
    socket.receive(envelope("protocol.error", {
      schemaVersion: 1, code: "device_revoked", message: "Unconfirmed", retryable: false, correlationId: null,
    }));
    await settle();
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.BACKOFF);
    assert.equal(fixture.agent.status().lastErrorCode, "device_disabled");
    assert.equal(fixture.agent.status().revocationPending, false);
    assert.equal(fixture.agent.status().revoked, false);
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.disableSettingsCalls, 0);
    const delay = fixture.clock.nextDelay();
    await fixture.clock.advance(delay);
    assert.equal(fixture.sockets.length, 2);
    assert.equal(fixture.tokenCalls, 3);
  });

  it("a retryable token failure keeps reconnecting without disabling", async () => {
    const fixture = harness({
      issueTokenError: new RemoteControlCloudError("unexpected_status", "The control plane returned HTTP 401.", { status: 401 }),
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    await settle();
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.BACKOFF);
    assert.equal(fixture.agent.status().lastErrorCode, "token_unavailable");
    assert.equal(fixture.deleteCalls, 0);
    assert.equal(fixture.disableSettingsCalls, 0);
    assert.notEqual(fixture.clock.nextDelay(), null, "a reconnect backoff is scheduled");
  });

  it("reports explicit local stop once without misclassifying it as disconnect", async () => {
    const resets = [];
    const revocations = [];
    const fixture = harness({
      onTransportReset: (input) => resets.push(input),
      onControlRevoked: (input) => revocations.push(input),
    });
    await connect(fixture);
    fixture.agent.stopAll();
    fixture.agent.stopAll();
    assert.deepEqual(revocations, [{ source: "local", transition: 1 }]);
    assert.equal(resets.some((input) => input.hadActiveControl === true), false);
  });

  it("sends one correlation-only generation-fenced local-stop frame and closes on matching ack", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();

    const stopping = fixture.agent.stopAll();
    const frame = frames(socket, "device.local_stop")[0];
    assert.deepEqual(Object.keys(frame.payload).sort(), ["connectionGeneration", "correlationId", "deviceId"]);
    assert.deepEqual(frame.payload, {
      deviceId: DEVICE_ID,
      connectionGeneration: 77,
      correlationId: frame.payload.correlationId,
    });
    assert.match(frame.payload.correlationId, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(frame), /prompt|transcript|tool|path|credential|token|secret/i);
    assert.equal(socket.closeCalls, 0);
    assert.equal(fixture.agent.status().localControlEnabled, false);

    socket.receive(envelope("device.local_stop_ack", {
      deviceId: DEVICE_ID,
      connectionGeneration: 77,
      correlationId: frame.payload.correlationId,
      closedControlSessions: 2,
    }));
    await stopping;
    assert.equal(socket.closeCalls, 1);
    assert.equal(fixture.clock.nextDelay(), null);
  });

  it("closes after the bounded local-stop ack timeout and never reconnects", async () => {
    const fixture = harness({ localStopAckTimeoutMs: 250 });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();

    const stopping = fixture.agent.stopAll();
    assert.equal(socket.closeCalls, 0);
    await fixture.clock.advance(249);
    assert.equal(socket.closeCalls, 0);
    await fixture.clock.advance(1);
    await stopping;
    assert.equal(socket.closeCalls, 1);
    assert.equal(fixture.sockets.length, 1);
    assert.equal(fixture.clock.nextDelay(), null);
  });

  it("coalesces repeated local stop and fences stale close and ack events", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();

    const first = fixture.agent.stopAll();
    const second = fixture.agent.stopAll();
    assert.equal(first, second);
    assert.equal(frames(socket, "device.local_stop").length, 1);
    socket.unexpectedClose();
    await Promise.all([first, second]);
    assert.equal(socket.closeCalls + socket.terminateCalls, 2);
    assert.equal(fixture.sockets.length, 1);
    assert.equal(fixture.clock.nextDelay(), null);

    const stopFrame = frames(socket, "device.local_stop")[0];
    socket.receive(envelope("device.local_stop_ack", {
      deviceId: DEVICE_ID,
      connectionGeneration: 77,
      correlationId: stopFrame.payload.correlationId,
      closedControlSessions: 0,
    }));
    await settle();
    assert.equal(fixture.sockets.length, 1);
  });

  it("stop is idempotent and always leaves timers and transport closed", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    const first = fixture.agent.stop();
    assert.equal(socket.closeCalls + socket.terminateCalls, 1);
    assert.equal(fixture.clock.nextDelay(), null);
    await first;
    await fixture.agent.stop();
    assert.equal(socket.closeCalls, 1);
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.STOPPED);
  });
});

describe("remote-control agent command handling", () => {
  it("dispatches encrypted session.create through the production registry after reconnect and key rotation", async () => {
    const rawPublic = (key) => {
      const jwk = key.export({ format: "jwk" });
      return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
    };
    const oldDesktop = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const currentDesktop = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const controller = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const signing = generateKeyPairSync("ed25519");
    const signingPublicKey = signing.publicKey.export({ format: "jwk" }).x;
    const signingCredential = {
      deviceId: DEVICE_ID,
      keyId: "55555555-5555-4555-8555-555555555555",
      publicKey: signingPublicKey,
      publicKeyFingerprint: createHash("sha256").update(Buffer.from(signingPublicKey, "base64url")).digest("hex"),
      privateKey: signing.privateKey,
    };
    const oldDesktopPublic = rawPublic(oldDesktop.publicKey);
    const currentDesktopPublic = rawPublic(currentDesktop.publicKey);
    const controllerPublic = rawPublic(controller.publicKey);
    const oldDesktopKeyId = remoteControlE2EEKeyId(oldDesktopPublic);
    const currentDesktopKeyId = remoteControlE2EEKeyId(currentDesktopPublic);
    const controllerKeyId = remoteControlE2EEKeyId(controllerPublic);
    const oldAdvertisement = { keyId: oldDesktopKeyId, publicKey: oldDesktopPublic, algorithm: "P-256/HKDF-SHA-256/AES-256-GCM", createdAt: new Date(NOW - 1_000).toISOString() };
    const currentAdvertisement = { keyId: currentDesktopKeyId, publicKey: currentDesktopPublic, algorithm: "P-256/HKDF-SHA-256/AES-256-GCM", createdAt: new Date(NOW).toISOString() };
    const encryptedGates = { ...readGates, sessionMutation: true, payloadEncryption: true };
    const calls = [];
    const registrations = createRemoteControlMutationRegistrations({
      workspaceStore: { readWorkspaceState: async () => ({ workspaces: [{ id: "ws_1", path: "/tmp/ws_1" }] }) },
      managedRuntimeClient: {
        getJson: async () => ({ items: [{ id: "ws_1", path: "/tmp/ws_1", workspaceType: "local" }] }),
        postJson: async (pathname, body) => {
          calls.push({ pathname, body });
          return { item: { id: "ses_created", directory: "/tmp/ws_1" }, started: false };
        },
      },
      coordinator: { recordServerRun: () => true, activeRuns: () => [] },
    });
    const registry = createRemoteControlOperationRegistry({
      registrations,
      getFeatureGates: (context) => /** @type {any} */ (context).featureGates,
      isOperationAllowed: ({ context }) => /** @type {any} */ (context).policyFresh === true,
      isPayloadEncryptionReady: () => true,
    });
    let activeCalls = 0;
    const e2eeKeyStore = {
      active: async () => (++activeCalls === 1 ? oldAdvertisement : currentAdvertisement),
      advertisement: async (keyId) => {
        if (keyId !== oldDesktopKeyId) throw new Error("unexpected retained key");
        return oldAdvertisement;
      },
      privateKey: async (keyId) => {
        if (keyId !== oldDesktopKeyId) throw new Error("unexpected retained key");
        return oldDesktop.privateKey;
      },
      revokeAll: async () => {},
    };
    const fixture = harness({ operationRegistry: registry, e2eeKeyStore, signingCredential });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext({ featureGates: encryptedGates }));
    const first = fixture.sockets[0];
    first.open();
    await settle();
    const firstHello = frames(first, "device.hello")[0];
    assert.ok(firstHello, `encrypted hello was not sent: ${JSON.stringify(fixture.agent.status())}`);
    assert.equal(firstHello.payload.payloadEncryption.keyId, oldDesktopKeyId);
    first.unexpectedClose();
    await fixture.clock.advance(fixture.clock.nextDelay());
    const socket = fixture.sockets[1];
    socket.open();
    await settle();
    socket.receive(welcome(78));
    await settle();
    assert.equal(frames(socket, "device.hello")[0].payload.payloadEncryption.keyId, currentDesktopKeyId);

    const oldSignedAdvertisement = frames(first, "device.hello")[0].payload.payloadEncryption;
    const inboundKey = deriveRemoteControlE2EEKey({
      privateKey: controller.privateKey, peerPublicKey: oldDesktopPublic, controlSessionId: CONTROL_ID,
      deviceId: DEVICE_ID, desktopKeyId: oldDesktopKeyId, desktopStatementHash: oldSignedAdvertisement.statementHash,
      controllerKeyId, direction: "controller-to-desktop",
    });
    const request = { operation: "session.create", payloadVersion: 1, arguments: { workspaceId: "ws_1", title: "Encrypted session" } };
    const routing = {
      kind: "command", commandId: COMMAND_ID, controlSessionId: CONTROL_ID, deviceId: DEVICE_ID,
      actor: { userId: "controller-1", displayName: "Controller" }, operation: "session.create",
      workspaceId: "ws_1", sessionId: null, idempotencyKey: "create-encrypted-1", payloadHash: "",
      createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 30_000).toISOString(),
      desktopKeyId: oldDesktopKeyId, desktopStatementHash: oldSignedAdvertisement.statementHash,
      controllerKeyId, controllerPublicKey: controllerPublic,
    };
    const payload = encryptRemoteControlPayload({
      key: inboundKey,
      aad: canonicalRemoteControlAAD({
        kind: "command", protocolVersion: 1, payloadVersion: 1, controlSessionId: CONTROL_ID, deviceId: DEVICE_ID,
        operation: "session.create", workspaceId: "ws_1", sessionId: null, idempotencyKey: routing.idempotencyKey,
        desktopKeyId: oldDesktopKeyId, desktopStatementHash: oldSignedAdvertisement.statementHash, controllerKeyId,
      }),
      value: request,
    });
    routing.payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    socket.receive({
      protocolVersion: 1, payloadVersion: 1, messageId: MESSAGE_ID, sentAt: new Date(NOW).toISOString(),
      encryption: { mode: "e2ee-v1", keyId: oldDesktopKeyId }, type: "encrypted.payload", routing, payload,
    });
    for (let index = 0; index < 4 && calls.length === 0; index += 1) await settle();
    assert.deepEqual(calls, [{ pathname: "/workspace/ws_1/sessions", body: { title: "Encrypted session" } }]);
    assert.deepEqual(frames(socket, "command.lifecycle").map((frame) => frame.payload.status), ["accepted", "running"]);
    const terminal = frames(socket, "encrypted.payload").at(-1);
    assert.equal(terminal.routing.status, "succeeded");
    assert.equal(terminal.routing.desktopStatementHash, oldSignedAdvertisement.statementHash);
    const outboundKey = deriveRemoteControlE2EEKey({
      privateKey: controller.privateKey, peerPublicKey: oldDesktopPublic, controlSessionId: CONTROL_ID,
      deviceId: DEVICE_ID, desktopKeyId: oldDesktopKeyId, desktopStatementHash: oldSignedAdvertisement.statementHash,
      controllerKeyId, direction: "desktop-to-controller",
    });
    assert.deepEqual(decryptRemoteControlPayload({
      key: outboundKey,
      aad: canonicalRemoteControlAAD({ protocolVersion: 1, payloadVersion: 1, ...terminal.routing }),
      payload: terminal.payload,
    }).result.result, { sessionId: "ses_created" });
  });

  it("exposes only a bounded actor identity from a validated accepted session binding", async () => {
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.snapshot", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({ capabilities });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    socket.receive(delivery({
      actor: { userId: "controller-secret-id", displayName: "A".repeat(100) },
      request: { operation: "session.snapshot", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_1" } },
    }));
    await settle();

    const status = fixture.agent.status();
    assert.equal(status.activeControlSessionCount, 1);
    assert.deepEqual(status.controllerDisplayNames, ["A".repeat(80)]);
    assert.doesNotMatch(JSON.stringify(status), /controller-secret-id|workspace\.list|session\.snapshot|ws_1|ses_1|prompt|payloadHash/i);
  });

  it("never records an actor from a malformed or unadvertised command", async () => {
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.snapshot", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({ capabilities });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    socket.receive(delivery({
      actor: { userId: "controller-1", displayName: "Malformed Actor", unexpected: "field" },
      request: { operation: "session.snapshot", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_1" } },
    }));
    socket.receive(delivery({
      actor: { userId: "controller-2", displayName: "Unadvertised Actor" },
      request: { operation: "session.list", payloadVersion: 1, arguments: { workspaceId: "ws_1" } },
    }));
    await settle();

    assert.deepEqual(fixture.agent.status().controllerDisplayNames, []);
    assert.equal(fixture.agent.status().activeControlSessionCount, 0);
  });

  it("counts sessions while bounding, deduplicating, and updating controller names", async () => {
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.snapshot", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({ capabilities });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    const actors = ["Alice", "Alice", "Bob", "Carol", "Dave", "Erin", "Frank"];
    for (let index = 0; index < actors.length; index += 1) {
      socket.receive(delivery({
        commandId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
        controlSessionId: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
        actor: { userId: `controller-${index}`, displayName: actors[index] },
        request: { operation: "session.snapshot", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: `ses_${index}` } },
      }));
    }
    await settle();
    assert.equal(fixture.agent.status().activeControlSessionCount, 7);
    assert.deepEqual(fixture.agent.status().controllerDisplayNames, ["Alice", "Bob", "Carol", "Dave", "Erin"]);

    socket.receive(delivery({
      commandId: "22222222-2222-4222-8222-000000000008",
      controlSessionId: "33333333-3333-4333-8333-000000000001",
      actor: { userId: "controller-updated", displayName: "Updated" },
      request: { operation: "session.snapshot", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_0" } },
    }));
    await settle();
    assert.equal(fixture.agent.status().activeControlSessionCount, 7);
    assert.deepEqual(fixture.agent.status().controllerDisplayNames, ["Updated", "Alice", "Bob", "Carol", "Dave"]);
  });

  it("clears active controller identity on unbind and every control-fencing lifecycle", async () => {
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.snapshot", payloadVersions: [1] }],
      features: [],
    });
    const bind = async (fixture, socket) => {
      socket.receive(welcome(77));
      await settle();
      socket.receive(delivery({
        actor: { userId: "controller-1", displayName: "Controller" },
        request: { operation: "session.snapshot", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_1" } },
      }));
      await settle();
      assert.equal(fixture.agent.status().activeControlSessionCount, 1);
    };

    const unbound = harness({ capabilities });
    const unboundSocket = await connect(unbound);
    await bind(unbound, unboundSocket);
    unboundSocket.receive(envelope("session.unbound", { controlSessionId: CONTROL_ID, reason: "closed" }));
    await settle();
    assert.deepEqual(unbound.agent.status().controllerDisplayNames, []);

    const disconnected = harness({ capabilities });
    const disconnectedSocket = await connect(disconnected);
    await bind(disconnected, disconnectedSocket);
    disconnectedSocket.unexpectedClose();
    assert.equal(disconnected.agent.status().activeControlSessionCount, 0);

    const stoppedAll = harness({ capabilities });
    const stoppedAllSocket = await connect(stoppedAll);
    await bind(stoppedAll, stoppedAllSocket);
    void stoppedAll.agent.stopAll();
    assert.equal(stoppedAll.agent.status().activeControlSessionCount, 0);

    const revoked = harness({ capabilities });
    const revokedSocket = await connect(revoked);
    await bind(revoked, revokedSocket);
    revokedSocket.receive(envelope("device.revoked", { deviceId: DEVICE_ID, reason: "Revoked" }));
    await settle();
    assert.equal(revoked.agent.status().activeControlSessionCount, 0);

    const switched = harness({ capabilities });
    const switchedSocket = await connect(switched);
    await bind(switched, switchedSocket);
    await switched.agent.syncContext(signedInContext({ userId: "user-2" }));
    assert.equal(switched.agent.status().activeControlSessionCount, 0);

    const stopped = harness({ capabilities });
    const stoppedSocket = await connect(stopped);
    await bind(stopped, stoppedSocket);
    await stopped.agent.stop();
    assert.equal(stopped.agent.status().activeControlSessionCount, 0);
  });

  it("derives a session binding only from a validated advertised delivery", async () => {
    const bindings = [];
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.snapshot", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({ capabilities, onSessionBinding: (binding) => { bindings.push(binding); } });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    socket.receive(delivery({
      controlSessionId: CONTROL_ID,
      request: { operation: "session.snapshot", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_1" } },
    }));
    await settle();
    assert.deepEqual(bindings, [{
      controlSessionId: CONTROL_ID,
      deviceId: DEVICE_ID,
      workspaceId: "ws_1",
      sessionId: "ses_1",
      rootSessionId: "ses_1",
      rootVerified: true,
      payloadVersion: 1,
      connectionGeneration: 77,
    }]);
    socket.receive(delivery({ request: { operation: "workspace.list", payloadVersion: 1, arguments: {} } }));
    assert.equal(bindings.length, 1);
  });

  it("does not dispatch or read another root when immutable session binding fails", async () => {
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.snapshot", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({ capabilities, onSessionBinding: () => false });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    socket.receive(delivery({
      request: { operation: "session.snapshot", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_1" } },
    }));
    await settle();

    assert.deepEqual(fixture.dispatchCalls, []);
    const terminal = frames(socket, "command.lifecycle").at(-1).payload;
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.error.code, "snapshot_required");
    assert.equal(terminal.error.retryable, true);
    assert.equal(fixture.completeCalls.length, 1);
    assert.equal(fixture.completeCalls[0].commandId, COMMAND_ID);
    assert.equal(fixture.completeCalls[0].lifecycle.error.code, "snapshot_required");
    assert.equal(fixture.agent.status().activeControlSessionCount, 0);
  });

  it("fences deferred session verification before old-generation dispatch during replacement", async () => {
    let releaseVerification = () => {};
    let verificationStarted = () => {};
    const started = new Promise((resolve) => { verificationStarted = () => resolve(); });
    const gate = new Promise((resolve) => { releaseVerification = () => resolve(); });
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.snapshot", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({
      enabled: false,
      capabilities,
      verifySessionBinding: async (_binding, { signal } = {}) => {
        verificationStarted();
        await gate;
        return signal?.aborted !== true;
      },
      enrollDevice: async () => enrolledCredential({ deviceId: NEW_DEVICE_ID }),
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    fixture.setSettings({ schemaVersion: 1, enabled: true, backgroundMode: false, launchAtLogin: false });
    await fixture.agent.refreshLocalSettings();
    const socket = fixture.sockets[0];
    socket.open();
    await settle();
    socket.receive(welcome());
    await settle();
    socket.receive(delivery({
      request: { operation: "session.snapshot", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_1" } },
    }));
    await started;
    fixture.setSettings({ schemaVersion: 1, enabled: false, backgroundMode: false, launchAtLogin: false });
    const stopping = fixture.agent.stopAll();
    const stopFrame = frames(socket, "device.local_stop")[0];
    socket.receive(envelope("device.local_stop_ack", {
      deviceId: DEVICE_ID,
      connectionGeneration: 41,
      correlationId: stopFrame.payload.correlationId,
      closedControlSessions: 1,
    }));
    await stopping;
    await fixture.agent.refreshLocalSettings();
    const replacement = fixture.agent.replaceIdentity(REPLACEMENT_INPUT);
    releaseVerification();
    await replacement;
    assert.equal(fixture.dispatchCalls.length, 0);
  });

  it("awaits a production mutation POST outcome after lifecycle abort before replacement deletes credentials", async () => {
    let postStarted = () => {};
    const started = new Promise((resolve) => { postStarted = () => resolve(); });
    let releasePost = () => {};
    const gate = new Promise((resolve) => { releasePost = () => resolve(); });
    const postCalls = [];
    const mutationGates = { ...readGates, sessionMutation: true };
    const registrations = createRemoteControlMutationRegistrations({
      workspaceStore: { readWorkspaceState: async () => ({ workspaces: [{ id: "ws_1", path: "/tmp/ws_1" }] }) },
      managedRuntimeClient: {
        getJson: async () => ({ items: [{ id: "ws_1", path: "/tmp/ws_1", workspaceType: "local" }] }),
        postJson: async (pathname, body, options) => {
          postCalls.push({ pathname, body, options });
          postStarted();
          await gate;
          return { item: { id: "ses_created", directory: "/tmp/ws_1" }, started: false };
        },
      },
      coordinator: { recordServerRun: () => true, activeRuns: () => [] },
    });
    const registry = createRemoteControlOperationRegistry({
      registrations,
      getFeatureGates: (context) => /** @type {any} */ (context).featureGates,
      isOperationAllowed: ({ context }) => /** @type {any} */ (context).policyFresh === true,
    });
    const fixture = harness({
      enabled: false,
      oldOperationDrainTimeoutMs: 100,
      operationRegistry: registry,
      enrollDevice: async () => enrolledCredential({ deviceId: NEW_DEVICE_ID }),
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext({ featureGates: mutationGates }));
    fixture.setSettings({ schemaVersion: 1, enabled: true, backgroundMode: false, launchAtLogin: false });
    await fixture.agent.refreshLocalSettings();
    const socket = fixture.sockets[0];
    socket.open();
    await settle();
    socket.receive(welcome());
    await settle();
    socket.receive(delivery({
      idempotencyKey: "create-before-replacement",
      request: { operation: "session.create", payloadVersion: 1, arguments: { workspaceId: "ws_1", title: "Old generation" } },
    }));
    await started;
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].options, undefined);
    fixture.setSettings({ schemaVersion: 1, enabled: false, backgroundMode: false, launchAtLogin: false });
    const stopping = fixture.agent.stopAll();
    const stopFrame = frames(socket, "device.local_stop")[0];
    socket.receive(envelope("device.local_stop_ack", {
      deviceId: DEVICE_ID,
      connectionGeneration: 41,
      correlationId: stopFrame.payload.correlationId,
      closedControlSessions: 1,
    }));
    await stopping;
    await fixture.agent.refreshLocalSettings();
    const replacement = fixture.agent.replaceIdentity(REPLACEMENT_INPUT);
    await settle();
    assert.equal(fixture.deleteCalls, 0);
    releasePost();
    await replacement;
    assert.equal(fixture.deleteCalls, 1);
    assert.equal(fixture.completeCalls.length, 0);
  });

  it("fails before credential deletion when an old operation cannot drain within the bound", async () => {
    let dispatchStarted = () => {};
    const started = new Promise((resolve) => { dispatchStarted = () => resolve(); });
    const fixture = harness({
      enabled: false,
      oldOperationDrainTimeoutMs: 10,
      dispatch: async () => { dispatchStarted(); return new Promise(() => {}); },
    });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    fixture.setSettings({ schemaVersion: 1, enabled: true, backgroundMode: false, launchAtLogin: false });
    await fixture.agent.refreshLocalSettings();
    const socket = fixture.sockets[0];
    socket.open();
    await settle();
    socket.receive(welcome());
    await settle();
    socket.receive(delivery());
    await started;
    fixture.setSettings({ schemaVersion: 1, enabled: false, backgroundMode: false, launchAtLogin: false });
    const stopping = fixture.agent.stopAll();
    const stopFrame = frames(socket, "device.local_stop")[0];
    socket.receive(envelope("device.local_stop_ack", {
      deviceId: DEVICE_ID,
      connectionGeneration: 41,
      correlationId: stopFrame.payload.correlationId,
      closedControlSessions: 1,
    }));
    await stopping;
    await fixture.agent.refreshLocalSettings();
    await assert.rejects(fixture.agent.replaceIdentity(REPLACEMENT_INPUT), (error) => {
      assert.equal(/** @type {any} */ (error).code, "operation_drain_failed");
      return true;
    });
    assert.equal(fixture.deleteCalls, 0);
  });

  it("publishes a validated session event only on the welcomed current generation", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    const event = {
      schemaVersion: 1,
      payloadVersion: 1,
      eventId: "55555555-5555-4555-8555-555555555555",
      controlSessionId: CONTROL_ID,
      deviceId: DEVICE_ID,
      workspaceId: "ws_1",
      sessionId: "ses_1",
      sequence: 1,
      occurredAt: new Date(NOW).toISOString(),
      data: { type: "todos.replace", todos: [] },
    };
    assert.equal(fixture.agent.publishSessionEvent(event, { connectionGeneration: 76 }), false);
    assert.equal(fixture.agent.publishSessionEvent({ ...event, deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { connectionGeneration: 77 }), false);
    assert.equal(fixture.agent.publishSessionEvent(event, { connectionGeneration: 77 }), true);
    assert.deepEqual(frames(socket, "session.event")[0].payload, event);
    fixture.agent.stopAll();
    assert.equal(fixture.agent.publishSessionEvent(event, { connectionGeneration: 77 }), false);
  });

  it("handles strict session rejection without closing or reconnecting the device transport", async () => {
    const unbound = [];
    const fixture = harness({ onSessionUnbound: (input) => unbound.push(input) });
    const socket = await connect(fixture);
    socket.receive(welcome(77));
    await settle();
    socket.receive(envelope("session.unbound", { controlSessionId: CONTROL_ID, reason: "snapshot_required" }));
    await settle();
    assert.deepEqual(unbound, [{ controlSessionId: CONTROL_ID, reason: "snapshot_required" }]);
    assert.equal(socket.closeCalls, 0);
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.CONNECTED);
    socket.receive(envelope("session.unbound", { controlSessionId: CONTROL_ID, reason: "future_reason" }));
    await settle();
    assert.equal(socket.closeCalls + socket.terminateCalls, 1);
  });

  it("prepares flattened metadata before dispatch, sends accepted/running, journals terminal before send, and wraps result bodies", async () => {
    /** @type {string[]} */
    const order = [];
    const fixture = harness({
      prepare: async () => { order.push("prepare"); return { action: "execute", commandId: COMMAND_ID }; },
      dispatch: async () => { order.push("dispatch"); return { ok: true, value: { workspaces: [] } }; },
    });
    const originalComplete = fixture.completeCalls;
    const socket = await connect(fixture);
    socket.receive(welcome());
    await settle();
    socket.receive(delivery());
    await settle();

    assert.deepEqual(fixture.prepareCalls[0], {
      commandId: COMMAND_ID,
      deviceId: DEVICE_ID,
      idempotencyKey: null,
      payloadHash: "a".repeat(64),
      operation: "workspace.list",
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 30_000).toISOString(),
    });
    assert.deepEqual(order, ["prepare", "dispatch"]);
    assert.deepEqual(frames(socket, "command.lifecycle").map((frame) => frame.payload.status), [
      "accepted", "running", "succeeded",
    ]);
    const terminal = frames(socket, "command.lifecycle").at(-1).payload;
    assert.deepEqual(terminal.result, {
      operation: "workspace.list",
      payloadVersion: 1,
      result: { workspaces: [] },
    });
    assert.equal(originalComplete.length, 1);
    assert.deepEqual(originalComplete[0].lifecycle, {
      status: terminal.status,
      occurredAt: terminal.occurredAt,
      result: terminal.result,
      error: terminal.error,
    });
  });

  it("replays the exact original terminal lifecycle without dispatch", async () => {
    const original = successLifecycle();
    const fixture = harness({
      prepare: async () => ({ action: "replay", commandId: COMMAND_ID, lifecycle: original }),
    });
    const socket = await connect(fixture);
    socket.receive(welcome());
    await settle();
    socket.receive(delivery());
    await settle();
    assert.equal(fixture.dispatchCalls.length, 0);
    assert.deepEqual(frames(socket, "command.lifecycle")[0].payload, { commandId: COMMAND_ID, ...original });
    assert.equal(fixture.completeCalls.length, 0);
  });

  it("accepts and replays session.create without deriving a session binding", async () => {
    const lifecycle = {
      status: "succeeded",
      occurredAt: new Date(NOW + 1_000).toISOString(),
      result: { operation: "session.create", payloadVersion: 1, result: { sessionId: "ses_created" } },
      error: null,
    };
    const bindings = [];
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.create", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({
      capabilities,
      prepare: async () => ({ action: "replay", commandId: COMMAND_ID, lifecycle }),
      onSessionBinding: (binding) => { bindings.push(binding); },
    });
    const socket = await connect(fixture);
    socket.receive(welcome());
    await settle();
    socket.receive(delivery({
      request: { operation: "session.create", payloadVersion: 1, arguments: { workspaceId: "ws_1", title: "😀".repeat(120) } },
      idempotencyKey: "create-1",
    }));
    await settle();
    assert.equal(fixture.dispatchCalls.length, 0);
    assert.deepEqual(bindings, []);
    assert.equal(fixture.agent.status().activeControlSessionCount, 0);
    assert.deepEqual(frames(socket, "command.lifecycle")[0].payload, { commandId: COMMAND_ID, ...lifecycle });
  });

  it("rejects invalid session.create title Unicode before journaling", async () => {
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.create", payloadVersions: [1] }],
      features: [],
    });
    for (const title of [
      " New ",
      "embedded\u0000nul",
      "next\u0085line",
      "high\ud800surrogate",
      "low\udc00surrogate",
      "😀".repeat(121),
    ]) {
      const fixture = harness({ capabilities });
      const socket = await connect(fixture);
      socket.receive(welcome());
      await settle();
      socket.receive(delivery({
        request: { operation: "session.create", payloadVersion: 1, arguments: { workspaceId: "ws_1", title } },
        idempotencyKey: "create-1",
      }));
      await settle();
      assert.equal(fixture.prepareCalls.length, 0);
      assert.equal(fixture.dispatchCalls.length, 0);
      assert.equal(frames(socket, "command.lifecycle")[0].payload.error.code, "invalid_request");
    }
  });

  it("does not reject non-control Unicode format characters in session.create titles", async () => {
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.create", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({ capabilities });
    const socket = await connect(fixture);
    socket.receive(welcome());
    await settle();
    socket.receive(delivery({
      request: { operation: "session.create", payloadVersion: 1, arguments: { workspaceId: "ws_1", title: "join\u200dthis" } },
      idempotencyKey: "create-1",
    }));
    await settle();
    assert.equal(fixture.prepareCalls.length, 1);
    assert.equal(fixture.dispatchCalls.length, 1);
  });

  it("rejects session.create without idempotency before journaling", async () => {
    const capabilities = /** @type {typeof readCapabilities} */ ({
      schemaVersion: 1,
      operations: [{ operation: "session.create", payloadVersions: [1] }],
      features: [],
    });
    const fixture = harness({ capabilities });
    const socket = await connect(fixture);
    socket.receive(welcome());
    await settle();
    socket.receive(delivery({
      request: { operation: "session.create", payloadVersion: 1, arguments: { workspaceId: "ws_1", title: "New" } },
      idempotencyKey: null,
    }));
    await settle();
    assert.equal(fixture.prepareCalls.length, 0);
    assert.equal(fixture.dispatchCalls.length, 0);
  });

  it("coalesces a live duplicate until the original terminal result can be replayed", async () => {
    /** @type {() => void} */
    let finishDispatch = () => {};
    const dispatchDone = new Promise((resolve) => { finishDispatch = () => resolve(undefined); });
    let prepareCount = 0;
    const replayTerminal = successLifecycle();
    const fixture = harness({
      prepare: async () => {
        prepareCount += 1;
        return prepareCount === 1
          ? { action: "execute", commandId: COMMAND_ID }
          : { action: "replay", commandId: COMMAND_ID, lifecycle: replayTerminal };
      },
      dispatch: async () => {
        await dispatchDone;
        return { ok: true, value: { workspaces: [] } };
      },
    });
    const originalComplete = fixture.completeCalls;
    const socket = await connect(fixture);
    socket.receive(welcome());
    await settle();
    socket.receive(delivery());
    socket.receive(delivery());
    await settle();
    assert.equal(fixture.dispatchCalls.length, 1);
    assert.deepEqual(frames(socket, "command.lifecycle").map((frame) => frame.payload.status), ["accepted", "running"]);
    finishDispatch();
    await settle();
    await settle();
    assert.equal(fixture.dispatchCalls.length, 1);
    assert.equal(frames(socket, "command.lifecycle").filter((frame) => frame.payload.status === "succeeded").length, 2);
  });

  it("rejects expired, conflict, indeterminate, and unavailable-journal commands without dispatch", async () => {
    const cases = [
      [{ action: "reject", commandId: COMMAND_ID, error: { code: "command_expired", message: "raw", retryable: false } }, "expired", "command_expired"],
      [{ action: "reject", commandId: COMMAND_ID, error: { code: "idempotency_conflict", message: "raw", retryable: false } }, "rejected", "idempotency_conflict"],
      [{ action: "reject", commandId: COMMAND_ID, error: { code: "delivery_failed", message: "raw", retryable: false } }, "failed", "delivery_failed"],
    ];
    for (const [prepared, expectedStatus, expectedCode] of cases) {
      const fixture = harness({ prepare: async () => prepared });
      const socket = await connect(fixture);
      socket.receive(welcome());
      await settle();
      socket.receive(delivery());
      await settle();
      assert.equal(fixture.dispatchCalls.length, 0);
      const lifecycle = frames(socket, "command.lifecycle")[0].payload;
      assert.equal(lifecycle.status, expectedStatus);
      assert.equal(lifecycle.error.code, expectedCode);
      assert.equal(lifecycle.error.message, {
        command_expired: "The remote command has expired.",
        idempotency_conflict: "The command key conflicts with a prior command.",
        delivery_failed: "The remote command outcome is unavailable.",
      }[expectedCode]);
    }

    const unavailable = harness({ prepare: async () => { throw new Error("journal path and raw data"); } });
    const socket = await connect(unavailable);
    socket.receive(welcome());
    await settle();
    socket.receive(delivery());
    await settle();
    assert.equal(unavailable.dispatchCalls.length, 0);
    assert.deepEqual(frames(socket, "command.lifecycle")[0].payload.error, {
      schemaVersion: 1,
      code: "delivery_failed",
      message: "The remote command outcome is unavailable.",
      retryable: false,
      correlationId: COMMAND_ID,
    });
    assert.equal(frames(socket, "command.lifecycle")[0].payload.status, "rejected");
  });

  it("never executes unknown or unadvertised operations", async () => {
    const unknown = harness();
    const unknownSocket = await connect(unknown);
    unknownSocket.receive(welcome());
    await settle();
    unknownSocket.receive(delivery({
      request: { operation: "desktop.http.proxy", payloadVersion: 1, arguments: { url: "http://localhost/token" } },
    }));
    await settle();
    assert.equal(unknown.prepareCalls.length, 0);
    assert.equal(unknown.dispatchCalls.length, 0);
    assert.equal(frames(unknownSocket, "command.lifecycle")[0].payload.status, "rejected");
    assert.equal(frames(unknownSocket, "command.lifecycle")[0].payload.error.code, "operation_unsupported");

    const unadvertised = harness({
      capabilities: { schemaVersion: 1, operations: [], features: [] },
    });
    const unadvertisedSocket = await connect(unadvertised);
    unadvertisedSocket.receive(welcome());
    await settle();
    unadvertisedSocket.receive(delivery());
    await settle();
    const terminal = frames(unadvertisedSocket, "command.lifecycle").at(-1).payload;
    assert.equal(terminal.status, "rejected");
    assert.equal(unadvertised.prepareCalls.length, 0);
    assert.equal(unadvertised.dispatchCalls.length, 0);
    assert.deepEqual(terminal.error, {
      schemaVersion: 1,
      code: "capability_not_advertised",
      message: "The remote operation was not advertised.",
      retryable: false,
      correlationId: COMMAND_ID,
    });
  });

  it("emits exact content-minimized failures and never exposes raw exceptions, URLs, or credentials", async () => {
    const fixture = harness({ dispatch: async () => { throw new Error("https://secret/path token=raw-password"); } });
    const socket = await connect(fixture);
    socket.receive(welcome());
    await settle();
    socket.receive(delivery());
    await settle();
    const terminal = frames(socket, "command.lifecycle").at(-1);
    assert.deepEqual(terminal.payload.error, {
      schemaVersion: 1,
      code: "internal_error",
      message: "The remote operation failed.",
      retryable: false,
      correlationId: COMMAND_ID,
    });
    const serialized = JSON.stringify(socket.sent);
    assert.equal(serialized.includes("https://secret"), false);
    assert.equal(serialized.includes("raw-password"), false);
    assert.equal(serialized.includes("accessToken"), false);
    assert.equal(serialized.includes("authorization"), false);
  });
});
