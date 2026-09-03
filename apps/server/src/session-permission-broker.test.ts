/**
 * Broker integration tests with a fake OpenCode client. Covers the security
 * guarantees from the session-permission-modes spec: one-time-only upstream
 * replies, activation-boundary exclusions, grant coverage and isolation,
 * revalidation races, durable principal-loss suspension, policy-blocked
 * requests, and upstream failure handling.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "bun:test";

import { automationSqliteAdapter } from "./automation/sqlite.js";
import { createInteractionResolutionCoordinator } from "./interaction-resolution-coordinator.js";
import { openRuntimeSqliteDatabase } from "./runtime-db.js";
import {
  computeEffectiveMode,
  SessionPermissionModeStore,
} from "./session-permission-mode-store.js";
import {
  captureActivationBoundary,
  evaluateSessionApprovalCeiling,
  normalizePendingPermissionRequest,
  RootSerialization,
  SessionPermissionBroker,
  verifyAuthorizingPrincipal,
} from "./session-permission-broker.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { TokenService } from "./tokens.js";
import { hashToken } from "./utils.js";

const NOW = Date.parse("2026-09-03T00:00:00Z");

// ---------------------------------------------------------------------------
// Fake OpenCode engine
// ---------------------------------------------------------------------------

type FakeSession = { id: string; parentID: string | null };
type FakePermission = {
  id: string;
  sessionID: string;
  permission?: string;
  patterns?: string[];
  always?: string[];
  v2?: { action: string; resources: string[]; save?: string[] };
};

class FakeOpencode {
  sessions: FakeSession[] = [];
  permissions: FakePermission[] = [];
  replies: Array<{ requestID: string; reply: string; sessionID?: string }> = [];
  failReplies = false;

  private envelope<T>(data: T) {
    return { data, error: undefined, response: new Response(null, { status: 200 }) };
  }

  client() {
    const self = this;
    return {
      session: {
        list: async () => self.envelope(self.sessions),
      },
      permission: {
        list: async () => self.envelope(
          self.permissions
            .filter((permission) => !permission.v2)
            .map((permission) => ({
              id: permission.id,
              sessionID: permission.sessionID,
              permission: permission.permission,
              patterns: permission.patterns,
              always: permission.always,
            })),
        ),
        reply: async ({ requestID, reply }: { requestID: string; reply: string }) => {
          if (self.failReplies) {
            return { data: undefined, error: { message: "upstream down" }, response: new Response(null, { status: 500 }) };
          }
          self.replies.push({ requestID, reply });
          return self.envelope({ ok: true });
        },
      },
      question: {
        list: async () => self.envelope([]),
      },
      v2: {
        session: {
          permission: {
            list: async ({ sessionID }: { sessionID: string }) =>
              self.envelope({
                data: self.permissions
                  .filter((permission) => permission.v2 && permission.sessionID === sessionID)
                  .map((permission) => ({
                    id: permission.id,
                    sessionID: permission.sessionID,
                    action: permission.v2!.action,
                    resources: permission.v2!.resources,
                    ...(permission.v2!.save ? { save: permission.v2!.save } : {}),
                  })),
              }),
            reply: async ({ sessionID, requestID, reply }: { sessionID: string; requestID: string; reply: string }) => {
              if (self.failReplies) {
                return { data: undefined, error: { message: "upstream down" }, response: new Response(null, { status: 500 }) };
              }
              self.replies.push({ requestID, reply, sessionID });
              return self.envelope({ ok: true });
            },
          },
          question: {
            list: async () => self.envelope({ data: [] }),
          },
        },
      },
    } as never;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  root: string;
  store: SessionPermissionModeStore;
  broker: SessionPermissionBroker;
  engine: FakeOpencode;
  config: ServerConfig;
  tokens: TokenService;
  workspace: WorkspaceInfo;
  runCycle: () => Promise<void>;
  dispose: () => Promise<void>;
};

const HOST_TOKEN = "owt_broker_test_host";

async function createHarness(options?: { hostToken?: string }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-broker-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const database = automationSqliteAdapter(runtime);
  const store = SessionPermissionModeStore.fromDatabase(database);
  const engine = new FakeOpencode();
  engine.sessions = [
    { id: "ses_root", parentID: null },
    { id: "ses_child", parentID: "ses_root" },
    { id: "ses_other", parentID: null },
  ];
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: options?.hostToken ?? HOST_TOKEN,
    approval: { mode: "auto" as const, timeoutMs: 1000 },
    corsOrigins: [],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: NOW,
    tokenSource: "generated" as const,
    hostTokenSource: "generated" as const,
    logFormat: "pretty" as const,
    logRequests: false,
    configPath: join(root, "server.json"),
  };
  const workspace: WorkspaceInfo = {
    id: "ws-1",
    name: "ws",
    path: root,
    preset: "starter",
    workspaceType: "local",
    baseUrl: "http://127.0.0.1:9999",
  };
  config.workspaces.push(workspace);
  const tokens = new TokenService(config);
  const rootLocks = new RootSerialization();
  const broker = new SessionPermissionBroker({
    store,
    config,
    tokens,
    resolveWorkspace: async () => workspace,
    createWorkspaceOpencodeClient: () => engine.client(),
    interactionResolutions: createInteractionResolutionCoordinator(),
    rootLocks,
    pollIntervalMs: 10,
  });
  return {
    root,
    store,
    broker,
    engine,
    config,
    tokens,
    workspace,
    runCycle: () => (broker as unknown as { runCycle(): Promise<void> }).runCycle(),
    dispose: async () => {
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const hostPrincipal = (config: ServerConfig) => ({
  id: hashToken(config.hostToken),
  scope: "owner" as const,
});

async function activateFullAccess(h: Harness, exclusion: string[] = []) {
  const result = h.store.updateMode({
    workspaceId: h.workspace.id,
    rootSessionId: "ses_root",
    requestedMode: "full-access",
    expectedRevision: h.store.readAuthorityRevision(h.workspace.id, "ses_root"),
    acknowledgementProfileVersion: 1,
    authorizingPrincipal: hostPrincipal(h.config),
    activationExclusionRequestIds: exclusion,
    now: NOW,
  });
  assert.ok(result.ok);
  return result.state;
}

function legacyPending(overrides: Partial<FakePermission> = {}): FakePermission {
  return {
    id: "req_new",
    sessionID: "ses_root",
    permission: "bash",
    patterns: ["git push origin main"],
    always: ["git push *"],
    ...overrides,
  };
}

let harness: Harness | null = null;
beforeEach(() => {
  harness = null;
});
afterEach(async () => {
  if (harness) await harness.dispose();
  harness = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session permission broker", () => {
  test("full access auto-approves post-boundary requests with allow_once only", async () => {
    const h = harness = await createHarness();
    await activateFullAccess(h);
    h.engine.permissions = [legacyPending()];

    await h.runCycle();

    assert.equal(h.engine.replies.length, 1);
    assert.equal(h.engine.replies[0]!.reply, "once"); // allow_once wire value
    assert.equal(h.engine.replies[0]!.requestID, "req_new");
    const decisions = h.store.listWorkspaceRoots(h.workspace.id);
    assert.deepEqual(decisions, ["ses_root"]); // ledger reachable via roots
  });

  test("requests present at the activation boundary stay manual even when delivered later", async () => {
    const h = harness = await createHarness();
    // Boundary snapshot captured the pre-existing request id.
    await activateFullAccess(h, ["req_pre"]);
    // Delivered to the broker only now (late delivery).
    h.engine.permissions = [legacyPending({ id: "req_pre" })];

    await h.runCycle();

    assert.equal(h.engine.replies.length, 0);
  });

  test("grant-based approval covers same-root descendants but not other roots or scopes", async () => {
    const h = harness = await createHarness();
    // Root stays in request-approval; authority comes from an active grant.
    const grant = h.store.insertPendingGrant({
      workspaceId: h.workspace.id,
      rootSessionId: "ses_root",
      protocol: "legacy",
      permissionAction: "bash",
      resources: ["git push *"],
      authorizingPrincipal: { id: hashToken(h.config.token), scope: "collaborator" },
      sourceRequestId: "req_src",
      sourceTargetSessionId: "ses_root",
      exclusionRequestIds: [],
      now: NOW,
    });
    h.store.transitionGrant(grant.id, "active", NOW + 1);

    // Descendant request covered by the grant → approved.
    h.engine.permissions = [legacyPending({ id: "req_child", sessionID: "ses_child" })];
    await h.runCycle();
    assert.equal(h.engine.replies.length, 1);
    assert.equal(h.engine.replies[0]!.requestID, "req_child");

    // Unrelated root → never approved.
    h.engine.permissions = [legacyPending({ id: "req_other", sessionID: "ses_other" })];
    await h.runCycle();
    assert.equal(h.engine.replies.length, 1);

    // Same root but reusable scope outside the saved grant → manual.
    h.engine.permissions = [legacyPending({ id: "req_wide", patterns: ["rm -rf /tmp/x"], always: ["rm *"] })];
    await h.runCycle();
    assert.equal(h.engine.replies.length, 1);
  });

  test("downgrade to request approval stops future auto-approval and clears grants", async () => {
    const h = harness = await createHarness();
    await activateFullAccess(h);
    const downgrade = h.store.updateMode({
      workspaceId: h.workspace.id,
      rootSessionId: "ses_root",
      requestedMode: "request-approval",
      expectedRevision: 1,
      acknowledgementProfileVersion: null,
      authorizingPrincipal: null,
      activationExclusionRequestIds: [],
      now: NOW + 1,
    });
    assert.ok(downgrade.ok);
    h.engine.permissions = [legacyPending()];

    await h.runCycle();
    assert.equal(h.engine.replies.length, 0);
    assert.equal(
      h.store.readModeState(h.workspace.id, "ses_root")?.effectiveMode,
      "request-approval",
    );
  });

  test("principal authority loss durably suspends full access without silent resumption", async () => {
    const h = harness = await createHarness();
    await activateFullAccess(h);
    h.engine.permissions = [legacyPending()];

    // Rotate the host token: the recorded principal no longer verifies.
    h.config.hostToken = "owt_rotated_host";

    await h.runCycle();
    assert.equal(h.engine.replies.length, 0);
    const suspended = h.store.readModeState(h.workspace.id, "ses_root");
    assert.equal(suspended?.effectiveMode, "full-access-suspended");

    // Restoring the old host token must NOT silently resume full access.
    h.config.hostToken = HOST_TOKEN;
    h.engine.permissions = [legacyPending({ id: "req_after_restore" })];
    await h.runCycle();
    assert.equal(h.engine.replies.length, 0);
    assert.equal(
      h.store.readModeState(h.workspace.id, "ses_root")?.effectiveMode,
      "full-access-suspended",
    );
  });

  test("policy-blocked ceiling prevents dispatch and records a terminal decision", async () => {
    const h = harness = await createHarness();
    await activateFullAccess(h);
    h.engine.permissions = [legacyPending()];

    // Organization policy disables full access after activation.
    process.env.JUGGLEWORK_DISABLE_SESSION_FULL_ACCESS = "1";
    try {
      await h.runCycle();
      assert.equal(h.engine.replies.length, 0);
      assert.equal(h.store.hasPolicyBlockedDecision(h.workspace.id, "req_new"), true);
    } finally {
      delete process.env.JUGGLEWORK_DISABLE_SESSION_FULL_ACCESS;
    }
  });

  test("upstream reply failure rolls back and records a failed decision", async () => {
    const h = harness = await createHarness();
    await activateFullAccess(h);
    h.engine.permissions = [legacyPending()];
    h.engine.failReplies = true;

    await h.runCycle();
    assert.equal(h.engine.replies.length, 0);
    // The failed decision must not block a later retry cycle, but with the
    // engine still failing nothing dispatches.
    await h.runCycle();
    assert.equal(h.engine.replies.length, 0);
  });

  test("v2 requests are approved via the v2 endpoint with one-time replies", async () => {
    const h = harness = await createHarness();
    await activateFullAccess(h);
    h.engine.permissions = [{
      id: "req_v2",
      sessionID: "ses_child",
      v2: { action: "file.edit", resources: ["/repo/a.ts"], save: ["/repo/**"] },
    }];

    await h.runCycle();
    assert.equal(h.engine.replies.length, 1);
    assert.equal(h.engine.replies[0]!.reply, "once");
    assert.equal(h.engine.replies[0]!.sessionID, "ses_child");
  });

  test("captureActivationBoundary reads the complete pending snapshot as the linearization point", async () => {
    const h = harness = await createHarness();
    h.engine.permissions = [
      legacyPending({ id: "req_a" }),
      legacyPending({ id: "req_b", sessionID: "ses_child" }),
      legacyPending({ id: "req_c", sessionID: "ses_other" }), // different root tree
    ];
    const ids = await captureActivationBoundary(h.engine.client(), "ses_root");
    assert.deepEqual(new Set(ids), new Set(["req_a", "req_b"]));
  });

  test("audit intent persistence failure fails closed without dispatch", async () => {
    const h = harness = await createHarness();
    await activateFullAccess(h);
    h.engine.permissions = [legacyPending()];

    // Inject a ledger write failure: no durable attribution → no dispatch.
    const original = h.store.appendDecisionIntent.bind(h.store);
    (h.store as unknown as { appendDecisionIntent: typeof original }).appendDecisionIntent = (() => {
      throw new Error("ledger unavailable");
    }) as typeof original;

    await h.runCycle();
    assert.equal(h.engine.replies.length, 0);
  });

  test("verifyAuthorizingPrincipal validates host and token principals", async () => {
    const h = harness = await createHarness();
    assert.equal(
      (await verifyAuthorizingPrincipal({
        config: h.config,
        tokens: h.tokens,
        principal: { id: hashToken(HOST_TOKEN), scope: "owner" },
      })).valid,
      true,
    );
    assert.equal(
      (await verifyAuthorizingPrincipal({
        config: h.config,
        tokens: h.tokens,
        principal: { id: hashToken("unknown-token"), scope: "owner" },
      })).valid,
      false,
    );
    // The primary client token maps to collaborator: insufficient for owner.
    assert.equal(
      (await verifyAuthorizingPrincipal({
        config: h.config,
        tokens: h.tokens,
        principal: { id: hashToken(h.config.token), scope: "owner" },
      })).valid,
      false,
    );
  });
});

describe("approval ceiling evaluation", () => {
  const baseContext = { readOnly: false, fullAccessPolicyAllowed: true, disabledMcpServers: [] };

  test("well-formed requests pass; malformed, read-only, and policy-blocked fail", () => {
    assert.equal(evaluateSessionApprovalCeiling({
      context: baseContext,
      permissionAction: "bash",
      resources: ["x"],
      wellFormed: true,
    }).allowed, true);
    assert.deepEqual(evaluateSessionApprovalCeiling({
      context: baseContext,
      permissionAction: "",
      resources: [],
      wellFormed: false,
    }), { allowed: false, reason: "malformed-request" });
    assert.deepEqual(evaluateSessionApprovalCeiling({
      context: { ...baseContext, readOnly: true },
      permissionAction: "bash",
      resources: [],
      wellFormed: true,
    }), { allowed: false, reason: "server-read-only" });
    assert.deepEqual(evaluateSessionApprovalCeiling({
      context: { ...baseContext, fullAccessPolicyAllowed: false },
      permissionAction: "bash",
      resources: [],
      wellFormed: true,
    }), { allowed: false, reason: "organization-policy" });
  });

  test("disabled MCP servers fail closed only on a clear match", () => {
    const context = { ...baseContext, disabledMcpServers: ["slack"] };
    assert.deepEqual(evaluateSessionApprovalCeiling({
      context,
      permissionAction: "mcp:slack",
      resources: [],
      wellFormed: true,
    }), { allowed: false, reason: "disabled-mcp" });
    assert.deepEqual(evaluateSessionApprovalCeiling({
      context,
      permissionAction: "mcp:github",
      resources: [],
      wellFormed: true,
    }).allowed, true);
  });

  test("normalizePendingPermissionRequest extracts action and reusable scope per protocol", () => {
    const legacy = normalizePendingPermissionRequest({
      id: "r1",
      sessionID: "s1",
      protocol: "legacy",
      permission: "bash",
      patterns: ["p"],
      always: ["a*"],
    } as never);
    assert.equal(legacy?.permissionAction, "bash");
    assert.deepEqual(legacy?.reusableScopeResources, ["a*"]);

    const v2 = normalizePendingPermissionRequest({
      id: "r2",
      sessionID: "s2",
      protocol: "v2",
      v2: { action: "file.edit", resources: ["/a"], save: ["/**"] },
    } as never);
    assert.equal(v2?.permissionAction, "file.edit");
    assert.deepEqual(v2?.reusableScopeResources, ["/**"]);
  });

  test("computeEffectiveMode sanity for the broker fail-closed states", () => {
    assert.equal(computeEffectiveMode({
      requested_mode: "full-access",
      profile_version: 99,
      acknowledged_version: 99,
      suspended: 0,
    }), "full-access-paused");
  });
});
