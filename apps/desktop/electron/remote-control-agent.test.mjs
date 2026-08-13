import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  REMOTE_CONTROL_AGENT_STATUS,
  createRemoteControlAgent,
  normalizeRemoteControlAgentContext,
} from "./remote-control-agent.mjs";
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
const COMMAND_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CONTROL_ID = SESSION_ID;
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const URL = "https://cloud.example.test/jwork/api";

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

/** @param {{ enrolled?: boolean, enabled?: boolean, capabilities?: typeof readCapabilities, operationRegistry?: any, e2eeKeyStore?: any, signingCredential?: any, prepare?: (command: unknown) => Promise<any>, dispatch?: (request: unknown, options: unknown) => Promise<any>, tokenLifetime?: number, localStopAckTimeoutMs?: number, getActiveRuns?: () => unknown, onSessionBinding?: (binding: unknown) => boolean | void, onSessionUnbound?: (input: unknown) => void, onTransportReset?: (input: unknown) => void, onControlRevoked?: (input: unknown) => void, onPolicyExpired?: () => void, onAuthorizationChanged?: (authorized: boolean) => void }} [input] */
function harness({
  enrolled = true,
  enabled = true,
  capabilities = readCapabilities,
  operationRegistry: operationRegistryOverride = null,
  e2eeKeyStore = null,
  signingCredential = {},
  prepare = async () => ({ action: "execute", commandId: COMMAND_ID }),
  dispatch = async () => ({ ok: true, value: { workspaces: [] } }),
  tokenLifetime = 120_000,
  localStopAckTimeoutMs = 1_500,
  getActiveRuns = () => [],
  onSessionBinding = () => {},
  onSessionUnbound = () => {},
  onTransportReset = () => {},
  onControlRevoked = () => {},
  onPolicyExpired = () => {},
  onAuthorizationChanged = () => {},
} = {}) {
  const clock = new FakeClock();
  let settings = { schemaVersion: 1, enabled, backgroundMode: false, launchAtLogin: false, allowBusySessionSteer: false, allowBusySessionEnqueue: false };
  let credential = enrolled ? enrolledCredential() : null;
  let uuid = 10;
  let tokenCalls = 0;
  let enrollmentCalls = 0;
  let deleteCalls = 0;
  /** @type {FakeSocket[]} */
  const sockets = [];
  /** @type {Array<Record<string, any>>} */
  const prepareCalls = [];
  /** @type {Array<{ commandId: any, lifecycle: any }>} */
  const completeCalls = [];
  /** @type {Array<Record<string, any>>} */
  const dispatchCalls = [];
  /** @type {unknown[]} */
  const webSocketInputs = [];
  const credentialStore = {
    read: async () => credential,
    prepareEnrollment: async () => ({}),
    completeEnrollment: async () => ({}),
    getSigningCredential: async () => signingCredential,
    delete: async () => { deleteCalls += 1; credential = null; },
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
      credential = enrolledCredential();
      return credential;
    },
    issueAgentToken: async () => {
      tokenCalls += 1;
      return {
        accessToken: `short-lived-token-${tokenCalls}`,
        expiresAt: new Date(clock.time + tokenLifetime).toISOString(),
        webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
      };
    },
  });
  const agent = createRemoteControlAgent({
    settingsStore: { read: async () => ({ ...settings }) },
    credentialStore,
    e2eeKeyStore,
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
    logger: {},
    localStopAckTimeoutMs,
    getActiveRuns,
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
    get tokenCalls() { return tokenCalls; },
    get enrollmentCalls() { return enrollmentCalls; },
    get deleteCalls() { return deleteCalls; },
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
    const fixture = harness({ enabled: false });
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

  it("waits for explicit enrollment, consumes the renderer grant, then connects", async () => {
    const fixture = harness({ enrolled: false });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.UNENROLLED);
    assert.equal(fixture.sockets.length, 0);

    await fixture.agent.enroll({ grant: "renderer-one-time-grant" });
    assert.equal(fixture.enrollmentCalls, 1);
    assert.equal(fixture.sockets.length, 1);
    assert.deepEqual(fixture.webSocketInputs[0], {
      url: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
      accessToken: "short-lived-token-1",
    });
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
    assert.equal(JSON.stringify(fixture.agent.status()).includes("token"), false);
  });

  it("fails closed when independently tracked policy freshness expires", async () => {
    const fixture = harness();
    const socket = await connect(fixture);
    assert.equal(socket.closeCalls, 0);
    await fixture.clock.advance(6 * 60_000);
    assert.equal(socket.closeCalls, 1);
    assert.equal(fixture.agent.status().localControlEnabled, false);
    assert.equal(fixture.agent.status().lastErrorCode, "policy_unavailable");
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
    assert.equal(socket.closeCalls, 1);
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

  it("authorizes execution sleep only while session mutation policy is fresh and enabled", async () => {
    const authorizations = [];
    const fixture = harness({ onAuthorizationChanged: (authorized) => authorizations.push(authorized) });
    await fixture.agent.start();
    await fixture.agent.syncContext(signedInContext());
    assert.deepEqual(authorizations, []);
    await fixture.agent.syncContext(signedInContext({ featureGates: { ...readGates, sessionMutation: true } }));
    assert.deepEqual(authorizations, [true]);
    await fixture.agent.syncContext(signedInContext());
    assert.deepEqual(authorizations, [true, false]);
  });

  it("reconnects with bounded jitter and ignores stale socket events", async () => {
    const fixture = harness();
    const first = await connect(fixture);
    first.unexpectedClose();
    const delay = fixture.clock.nextDelay();
    assert.ok(delay >= 250 && delay <= 30_000);
    await fixture.clock.advance(delay);
    assert.equal(fixture.sockets.length, 2);
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
    const signout = fixture.agent.syncContext(signedOutContext());
    assert.equal(current.closeCalls, 1);
    await signout;

    await fixture.agent.syncContext(signedInContext());
    const accountSocket = fixture.sockets.at(-1);
    const switched = fixture.agent.syncContext(signedInContext({ userId: "user-2" }));
    assert.equal(accountSocket.closeCalls, 1);
    await switched;

    const stopping = fixture.agent.stop();
    assert.equal(fixture.clock.nextDelay(), null);
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.STOPPED);
    await stopping;
  });

  it("revocation closes transport, deletes the key, and permanently disables reconnect", async () => {
    const revocations = [];
    const fixture = harness({ onControlRevoked: (input) => revocations.push(input) });
    const socket = await connect(fixture);
    socket.receive(envelope("device.revoked", { deviceId: DEVICE_ID, reason: "Revoked by owner" }));
    await settle();
    assert.equal(socket.closeCalls, 1);
    assert.equal(fixture.deleteCalls, 1);
    assert.equal(fixture.agent.status().state, REMOTE_CONTROL_AGENT_STATUS.REVOKED);
    assert.equal(fixture.agent.status().enrolled, false);
    assert.equal(fixture.clock.nextDelay(), null);
    assert.deepEqual(revocations, [{ source: "cloud", transition: 1 }]);
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
    assert.equal(socket.closeCalls, 2);
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
    assert.equal(socket.closeCalls, 1);
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
          return { session: { id: "ses_created", workspaceId: "ws_1", runtimeId: "jugglework", canonicalCwd: "/tmp/ws_1" } };
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
    const request = { operation: "session.create", payloadVersion: 1, arguments: { workspaceId: "ws_1", title: "Encrypted session", runtimeId: "claude-agent" } };
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
    assert.deepEqual(calls, [{ pathname: "/workspace/ws_1/agent/v1/sessions", body: { title: "Encrypted session", runtimeId: "claude-agent" } }]);
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
      connectionGeneration: 77,
    }]);
    socket.receive(delivery({ request: { operation: "workspace.list", payloadVersion: 1, arguments: {} } }));
    assert.equal(bindings.length, 1);
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
    assert.equal(socket.closeCalls, 1);
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
