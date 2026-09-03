import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SESSION_PERMISSION_PROFILE_VERSION,
  matchesSessionPermissionResource,
} from "@jugglework/types/session-permission-modes";
import { automationSqliteAdapter } from "./automation/sqlite.js";
import { openRuntimeSqliteDatabase } from "./runtime-db.js";
import {
  computeEffectiveMode,
  grantProfileVersionSupported,
  sanitizeSessionPermissionResources,
  SessionPermissionModeStore,
} from "./session-permission-mode-store.js";
import { readSessionFullAccessPolicy } from "@jugglework/types/den/desktop-policies";

const NOW = Date.parse("2026-09-03T00:00:00Z");

async function withStore(run: (store: SessionPermissionModeStore) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-session-permission-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const database = automationSqliteAdapter(runtime);
  try {
    run(SessionPermissionModeStore.fromDatabase(database));
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

const ownerPrincipal = { id: "principal-owner", scope: "owner" as const };
const collaboratorPrincipal = { id: "principal-collab", scope: "collaborator" as const };

function enableFullAccess(
  store: SessionPermissionModeStore,
  workspaceId: string,
  rootSessionId: string,
  options?: { expectedRevision?: number; exclusion?: string[]; principal?: typeof ownerPrincipal; now?: number },
) {
  return store.updateMode({
    workspaceId,
    rootSessionId,
    requestedMode: "full-access",
    expectedRevision: options?.expectedRevision ?? 0,
    acknowledgementProfileVersion: SESSION_PERMISSION_PROFILE_VERSION,
    authorizingPrincipal: options?.principal ?? ownerPrincipal,
    activationExclusionRequestIds: options?.exclusion ?? [],
    now: options?.now ?? NOW,
  });
}

test("effective mode fails closed for unsupported profile/acknowledgement versions", () => {
  assert.equal(computeEffectiveMode({
    requested_mode: "request-approval",
    profile_version: SESSION_PERMISSION_PROFILE_VERSION,
    acknowledged_version: null,
    suspended: 0,
  }), "request-approval");
  assert.equal(computeEffectiveMode({
    requested_mode: "full-access",
    profile_version: SESSION_PERMISSION_PROFILE_VERSION,
    acknowledged_version: SESSION_PERMISSION_PROFILE_VERSION,
    suspended: 0,
  }), "full-access");
  // Older persisted version.
  assert.equal(computeEffectiveMode({
    requested_mode: "full-access",
    profile_version: SESSION_PERMISSION_PROFILE_VERSION - 1,
    acknowledged_version: SESSION_PERMISSION_PROFILE_VERSION - 1,
    suspended: 0,
  }), "full-access-paused");
  // Future persisted version (rollback to older binary).
  assert.equal(computeEffectiveMode({
    requested_mode: "full-access",
    profile_version: SESSION_PERMISSION_PROFILE_VERSION + 1,
    acknowledged_version: SESSION_PERMISSION_PROFILE_VERSION + 1,
    suspended: 0,
  }), "full-access-paused");
  // Malformed / mismatched pair.
  assert.equal(computeEffectiveMode({
    requested_mode: "full-access",
    profile_version: SESSION_PERMISSION_PROFILE_VERSION,
    acknowledged_version: null,
    suspended: 0,
  }), "full-access-paused");
  assert.equal(computeEffectiveMode({
    requested_mode: "full-access",
    profile_version: Number.NaN,
    acknowledged_version: SESSION_PERMISSION_PROFILE_VERSION,
    suspended: 0,
  }), "full-access-paused");
  // Suspension wins display for any full-access request.
  assert.equal(computeEffectiveMode({
    requested_mode: "full-access",
    profile_version: SESSION_PERMISSION_PROFILE_VERSION,
    acknowledged_version: SESSION_PERMISSION_PROFILE_VERSION,
    suspended: 1,
  }), "full-access-suspended");
  assert.equal(grantProfileVersionSupported(SESSION_PERMISSION_PROFILE_VERSION + 1), false);
  assert.equal(grantProfileVersionSupported(SESSION_PERMISSION_PROFILE_VERSION), true);
});

test("mode updates are compare-and-set and persist arming exclusions", async () => {
  await withStore((store) => {
    const first = enableFullAccess(store, "ws", "root-1", { exclusion: ["req-pre-1", "req-pre-2"] });
    assert.ok(first.ok);
    assert.equal(first.state.effectiveMode, "full-access");
    assert.equal(first.state.authorityRevision, 1);

    // Stale revision is rejected.
    const stale = enableFullAccess(store, "ws", "root-1", { expectedRevision: 0 });
    assert.equal(stale.ok, false);

    // Exclusion set persisted and queryable.
    const excluded = store.listExcludedRequestIds("ws", "root-1");
    assert.equal(excluded.has("req-pre-1"), true);
    assert.equal(excluded.has("req-pre-2"), true);
    assert.equal(excluded.has("req-future"), false);

    // Re-activation replaces the previous exclusion set.
    const second = enableFullAccess(store, "ws", "root-1", { expectedRevision: 1, exclusion: ["req-new"] });
    assert.ok(second.ok);
    const replaced = store.listExcludedRequestIds("ws", "root-1");
    assert.equal(replaced.has("req-pre-1"), false);
    assert.equal(replaced.has("req-new"), true);

    // Broker polling sets reflect only active full-access roots.
    assert.deepEqual(store.listActiveFullAccessRoots("ws"), ["root-1"]);
  });
});

test("downgrade unconditionally clears grants and exclusions in one revision", async () => {
  await withStore((store) => {
    enableFullAccess(store, "ws", "root-1");
    const grant = store.insertPendingGrant({
      workspaceId: "ws",
      rootSessionId: "root-1",
      protocol: "legacy",
      permissionAction: "bash",
      resources: ["git push *"],
      authorizingPrincipal: collaboratorPrincipal,
      sourceRequestId: "req-src",
      sourceTargetSessionId: "root-1",
      exclusionRequestIds: ["req-other"],
      now: NOW,
    });
    store.transitionGrant(grant.id, "active", NOW + 1);

    const downgrade = store.updateMode({
      workspaceId: "ws",
      rootSessionId: "root-1",
      requestedMode: "request-approval",
      expectedRevision: 2,
      acknowledgementProfileVersion: null,
      authorizingPrincipal: null,
      activationExclusionRequestIds: [],
      now: NOW + 2,
    });
    assert.ok(downgrade.ok);
    assert.equal(downgrade.state.requestedMode, "request-approval");
    assert.deepEqual(downgrade.clearedGrantIds, [grant.id]);
    assert.deepEqual(store.listGrants("ws", "root-1"), []);
    assert.equal(store.listExcludedRequestIds("ws", "root-1").size, 0);
    assert.equal(downgrade.state.authorityRevision, 3);
  });
});

test("principal authority loss durably suspends full access and invalidates grants", async () => {
  await withStore((store) => {
    enableFullAccess(store, "ws", "root-1", { principal: ownerPrincipal });
    const grant = store.insertPendingGrant({
      workspaceId: "ws",
      rootSessionId: "root-1",
      protocol: "legacy",
      permissionAction: "bash",
      resources: ["git push *"],
      authorizingPrincipal: collaboratorPrincipal,
      sourceRequestId: "req-src",
      sourceTargetSessionId: "root-1",
      exclusionRequestIds: [],
      now: NOW,
    });
    store.transitionGrant(grant.id, "active", NOW + 1);

    const suspended = store.suspendFullAccessForPrincipal("ws", "root-1", NOW + 2);
    assert.equal(suspended?.effectiveMode, "full-access-suspended");
    assert.equal(suspended.authorityRevision, 3);

    const invalidated = store.invalidateGrantsForPrincipal("ws", collaboratorPrincipal.id, NOW + 3);
    assert.deepEqual(invalidated, [grant.id]);
    const after = store.getGrant(grant.id);
    assert.equal(after?.state, "failed");
    // Restored membership never silently reactivates: the grant stays failed
    // and the mode stays suspended until explicit renewal.
    assert.equal(store.readModeState("ws", "root-1")?.effectiveMode, "full-access-suspended");
    assert.deepEqual(store.listActiveGrants("ws", "root-1"), []);
  });
});

test("grant lifecycle state machine reconciles interrupted work as indeterminate", async () => {
  await withStore((store) => {
    const grant = store.insertPendingGrant({
      workspaceId: "ws",
      rootSessionId: "root-1",
      protocol: "v2",
      permissionAction: "file.edit",
      resources: ["/repo/**"],
      authorizingPrincipal: collaboratorPrincipal,
      sourceRequestId: "req-src",
      sourceTargetSessionId: "root-1",
      exclusionRequestIds: ["req-old"],
      now: NOW,
    });
    assert.equal(grant.state, "pending");
    assert.equal(grant.profileVersion, SESSION_PERMISSION_PROFILE_VERSION);
    assert.deepEqual(grant.exclusionRequestIds, ["req-old"]);

    store.transitionGrant(grant.id, "dispatching", NOW + 1);
    const reconciled = store.reconcileInterruptedGrants(NOW + 2);
    assert.deepEqual(reconciled, [grant.id]);
    assert.equal(store.getGrant(grant.id)?.state, "indeterminate");

    const active = store.insertPendingGrant({
      workspaceId: "ws",
      rootSessionId: "root-2",
      protocol: "legacy",
      permissionAction: "bash",
      resources: ["git push *"],
      authorizingPrincipal: collaboratorPrincipal,
      sourceRequestId: "req-src-2",
      sourceTargetSessionId: "root-2",
      exclusionRequestIds: [],
      now: NOW,
    });
    store.transitionGrant(active.id, "active", NOW + 1);
    assert.deepEqual(store.reconcileInterruptedGrants(NOW + 3), []);
    assert.equal(store.getGrant(active.id)?.state, "active");
  });
});

test("decision ledger pairs intents with outcomes and prunes completed units only", async () => {
  await withStore((store) => {
    const intent = store.appendDecisionIntent({
      workspaceId: "ws",
      rootSessionId: "root-1",
      targetSessionId: "child-1",
      kind: "auto-approve",
      resourceSummary: ["git push origin main"],
      actor: { origin: "broker", id: "principal-owner" },
      authorityRevision: 4,
      requestId: "req-1",
      now: NOW,
    });
    assert.equal(intent.outcome, "pending");
    assert.equal(store.hasPendingDecisionForRequest("ws", "req-1"), true);
    // Resolve far in the past so age-based pruning applies to this unit.
    store.resolveDecision(intent.id, "succeeded", NOW - 100 * 24 * 60 * 60 * 1000);
    assert.equal(store.hasPendingDecisionForRequest("ws", "req-1"), false);

    // Unresolved intent survives age-based pruning.
    const oldPending = store.appendDecisionIntent({
      workspaceId: "ws",
      rootSessionId: "root-1",
      targetSessionId: null,
      kind: "grant-create",
      resourceSummary: [],
      actor: null,
      authorityRevision: null,
      requestId: "req-2",
      now: NOW - 200 * 24 * 60 * 60 * 1000,
    });
    // Indeterminate units survive too.
    const oldIndeterminate = store.appendDecisionIntent({
      workspaceId: "ws",
      rootSessionId: "root-1",
      targetSessionId: null,
      kind: "auto-approve",
      resourceSummary: [],
      actor: null,
      authorityRevision: null,
      requestId: "req-3",
      now: NOW - 200 * 24 * 60 * 60 * 1000,
    });
    store.resolveDecision(oldIndeterminate.id, "indeterminate", NOW);
    const pruned = store.pruneWorkspaceDecisions("ws", NOW);
    assert.equal(pruned, 1); // only the completed unit
    assert.equal(store.readDecision(oldPending.id)?.outcome, "pending");
    assert.equal(store.readDecision(oldIndeterminate.id)?.outcome, "indeterminate");

    // Startup reconciliation marks stuck pending decisions indeterminate
    // (both the aged pending intent and the freshly created one).
    const stuck = store.appendDecisionIntent({
      workspaceId: "ws",
      rootSessionId: "root-1",
      targetSessionId: null,
      kind: "auto-approve",
      resourceSummary: [],
      actor: null,
      authorityRevision: null,
      requestId: "req-4",
      now: NOW,
    });
    assert.equal(store.reconcileInterruptedDecisions(NOW + 5), 2);
    assert.equal(store.readDecision(stuck.id)?.outcome, "indeterminate");
  });
});

test("resource sanitization bounds count and length", () => {
  const long = "a".repeat(2_000);
  const sanitized = sanitizeSessionPermissionResources([long, "", "x", "x", long]);
  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0]!.length, 512);
  assert.equal(sanitized[1], "x");
});

test("deleting a root session removes modes, grants, and exclusions", async () => {
  await withStore((store) => {
    enableFullAccess(store, "ws", "root-1");
    store.insertPendingGrant({
      workspaceId: "ws",
      rootSessionId: "root-1",
      protocol: "legacy",
      permissionAction: "bash",
      resources: ["git push *"],
      authorizingPrincipal: collaboratorPrincipal,
      sourceRequestId: "req-src",
      sourceTargetSessionId: "root-1",
      exclusionRequestIds: ["req-old"],
      now: NOW,
    });
    store.deleteRootSessionRecords("ws", "root-1");
    assert.equal(store.readModeState("ws", "root-1"), null);
    assert.deepEqual(store.listGrants("ws", "root-1"), []);
    assert.equal(store.listExcludedRequestIds("ws", "root-1").size, 0);
    assert.deepEqual(store.listWorkspaceRoots("ws"), []);
  });
});

test("organization policy gate parses fail-closed", () => {
  assert.deepEqual(readSessionFullAccessPolicy(undefined), { allowed: true, source: "default" });
  assert.deepEqual(readSessionFullAccessPolicy(false), { allowed: false, source: "policy" });
  assert.deepEqual(readSessionFullAccessPolicy("malformed").allowed, false);
  assert.deepEqual(readSessionFullAccessPolicy(1).allowed, false);
});

test("grant matching grammar stays exact and case-sensitive", () => {
  assert.equal(matchesSessionPermissionResource("git push *", "git push origin main"), true);
  assert.equal(matchesSessionPermissionResource("git push *", "git push"), false);
  assert.equal(matchesSessionPermissionResource("Git Push *", "git push origin main"), false);
  assert.equal(matchesSessionPermissionResource("/repo/*.ts", "/repo/a/b.ts"), true);
  assert.equal(matchesSessionPermissionResource("/repo/*.ts", "/repo/a/b.js"), false);
});
