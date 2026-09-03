/**
 * Server-side session permission broker.
 *
 * Owns automatic approval of runtime permission requests for root sessions
 * with active Full access or reusable grants. See
 * openspec/changes/add-session-permission-modes (design.md):
 *
 * - Polls authoritative pending permissions per root tree (the renderer
 *   consumes OpenCode SSE directly, so the server observes by polling).
 * - The activation boundary is the complete pending-snapshot read — requests
 *   present at that linearization point stay manual even when delivered later.
 * - Immediately before dispatch, revalidates pending state, ancestry, shared
 *   authority revision, profile/grant versions, the authorizing human
 *   principal's current scope, and the shared approval ceiling.
 * - Never sends protocol-native `always`; only exact-request `allow_once`.
 * - Every automatic decision writes a durable audit intent first (fail-closed)
 *   and a terminal outcome after dispatch.
 */

import {
  sessionPermissionGrantCoversResources,
  type SessionApprovalCeilingVerdict,
  type SessionPermissionAuthorizingPrincipal,
  type SessionPermissionGrantRecord,
} from "@jugglework/types/session-permission-modes";
import { ApiError } from "./errors.js";
import type { InteractionResolutionCoordinator } from "./interaction-resolution-coordinator.js";
import { readMcpWorkspaceToolPolicy } from "./mcp-workspace-tool-policy.js";
import { SessionPermissionModeStore } from "./session-permission-mode-store.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "./types.js";
import type { TokenService } from "./tokens.js";
import { hashToken } from "./utils.js";
import {
  dispatchPermissionReply,
  readInteractionSnapshot,
  readPendingPermissions,
  type InteractionWorkspaceOpencodeClient,
  type PendingPermission,
} from "./routes/interactions.js";

// ---------------------------------------------------------------------------
// Shared approval ceiling (tasks 1.3 / 4.5)
// ---------------------------------------------------------------------------

export type SessionApprovalCeilingContext = {
  readOnly: boolean;
  /** Server-side organization policy hook (v1: explicit disable flag). */
  fullAccessPolicyAllowed: boolean;
  disabledMcpServers: string[];
};

export function evaluateSessionApprovalCeiling(input: {
  context: SessionApprovalCeilingContext;
  permissionAction: string;
  resources: string[];
  wellFormed: boolean;
}): SessionApprovalCeilingVerdict {
  if (!input.wellFormed) return { allowed: false, reason: "malformed-request" };
  if (input.context.readOnly) return { allowed: false, reason: "server-read-only" };
  if (!input.context.fullAccessPolicyAllowed) {
    return { allowed: false, reason: "organization-policy" };
  }
  // Best-effort disabled-MCP check: only fail closed on a clear match between
  // the permission action/resources and a disabled server name.
  const disabled = input.context.disabledMcpServers;
  if (disabled.length > 0) {
    const haystack = [input.permissionAction, ...input.resources].join("\n").toLowerCase();
    const matched = disabled.some((name) => {
      const needle = name.trim().toLowerCase();
      return needle.length > 0 &&
        (haystack.includes(`mcp:${needle}`) || haystack.includes(`mcp__${needle}`) ||
          haystack.includes(`mcp/${needle}`));
    });
    if (matched) return { allowed: false, reason: "disabled-mcp" };
  }
  return { allowed: true };
}

/** v1 server-side organization policy hook for session Full access. */
export function resolveServerFullAccessPolicy(config: ServerConfig): boolean {
  if (config.readOnly) return false;
  const raw = (process.env.JUGGLEWORK_DISABLE_SESSION_FULL_ACCESS ?? "").trim().toLowerCase();
  return raw !== "1" && raw !== "true" && raw !== "yes" && raw !== "on";
}

// ---------------------------------------------------------------------------
// Authorizing principal verification (task 2.5)
// ---------------------------------------------------------------------------

export type PrincipalVerification = { valid: true } | { valid: false };

export async function verifyAuthorizingPrincipal(options: {
  config: ServerConfig;
  tokens: TokenService;
  principal: SessionPermissionAuthorizingPrincipal;
}): Promise<PrincipalVerification> {
  const { config, tokens, principal } = options;
  // Host-equivalent principal: compare against the current host token hash.
  if (principal.id === hashToken(config.hostToken)) return { valid: true };
  // Token principal: the recorded hash must still resolve to a live token
  // holding at least the recorded scope. Unknown → invalid (fail-closed).
  const scope = await tokens.scopeForTokenHash(principal.id);
  if (scope !== "owner" && scope !== "collaborator") return { valid: false };
  if (principal.scope === "owner" && scope !== "owner") return { valid: false };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Per-root async serialization (arming boundary + poll processing)
// ---------------------------------------------------------------------------

/** Ceiling factory for manual one-time approval routes (task 4.5). */
export function createInteractionPermissionCeiling(config: ServerConfig) {
  return async (
    workspaceId: string,
    pending: PendingPermission,
  ): Promise<{ allowed: boolean; reason?: string }> => {
    const request = normalizePendingPermissionRequest(pending);
    if (!request) return { allowed: false, reason: "malformed-request" };
    const policy = await readMcpWorkspaceToolPolicy(config, workspaceId);
    const verdict = evaluateSessionApprovalCeiling({
      context: {
        readOnly: config.readOnly,
        fullAccessPolicyAllowed: resolveServerFullAccessPolicy(config),
        disabledMcpServers: policy.disabledServerNames,
      },
      permissionAction: request.permissionAction,
      resources: request.requestedResources,
      wellFormed: request.wellFormed,
    });
    return verdict.allowed ? { allowed: true } : { allowed: false, reason: verdict.reason };
  };
}

export class RootSerialization {
  private tails = new Map<string, Promise<unknown>>();

  async with<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    try {
      await previous;
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        void tail.then(() => {
          if (this.tails.get(key) === tail) this.tails.delete(key);
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pending permission request normalization (reusable scope extraction)
// ---------------------------------------------------------------------------

export type NormalizedPermissionRequest = {
  requestId: string;
  targetSessionId: string;
  rootSessionId: string;
  protocol: "legacy" | "v2";
  permissionAction: string;
  requestedResources: string[];
  reusableScopeResources: string[];
  wellFormed: boolean;
};

/** Extract the normalized action and reusable scope from a pending permission. */
export function normalizePendingPermissionRequest(
  permission: PendingPermission & { rootSessionId?: string },
): NormalizedPermissionRequest | null {
  const requestId = typeof permission.id === "string" ? permission.id : "";
  const targetSessionId = typeof permission.sessionID === "string" ? permission.sessionID : "";
  if (!requestId || !targetSessionId) return null;

  const v2 = permission.v2 as { action?: unknown; resources?: unknown; save?: unknown } | undefined;
  const flatAction = (permission as { action?: unknown }).action;
  const flatResources = (permission as { resources?: unknown }).resources;
  const flatSave = (permission as { save?: unknown }).save;
  // Branch on field shape (flat v2 fields or the app's nested `v2` summary),
  // not transport protocol: a v2 endpoint may still surface legacy-shaped
  // items, which must normalize through the legacy path.
  const v2Action = typeof flatAction === "string" ? flatAction : typeof v2?.action === "string" ? v2.action : "";
  if (v2Action.length > 0) {
    const action = v2Action;
    const rawResources = Array.isArray(flatResources)
      ? flatResources
      : Array.isArray(v2?.resources)
        ? v2.resources
        : [];
    const rawSave = Array.isArray(flatSave) ? flatSave : Array.isArray(v2?.save) ? v2.save : [];
    const save = rawSave.filter((item): item is string => typeof item === "string");
    const resources = rawResources.filter((item): item is string => typeof item === "string");
    return {
      requestId,
      targetSessionId,
      rootSessionId: typeof permission.rootSessionId === "string" ? permission.rootSessionId : "",
      protocol: "v2",
      permissionAction: action,
      requestedResources: resources,
      reusableScopeResources: save,
      wellFormed: action.length > 0,
    };
  }

  const legacyAction = typeof permission.permission === "string" ? permission.permission : "";
  const patterns = Array.isArray(permission.patterns)
    ? permission.patterns.filter((item): item is string => typeof item === "string")
    : [];
  const always = Array.isArray(permission.always)
    ? permission.always.filter((item): item is string => typeof item === "string")
    : [];
  return {
    requestId,
    targetSessionId,
    rootSessionId: typeof permission.rootSessionId === "string" ? permission.rootSessionId : "",
    protocol: "legacy",
    permissionAction: legacyAction,
    requestedResources: patterns,
    reusableScopeResources: always,
    wellFormed: legacyAction.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Activation boundary capture (tasks 3.3 / 4.3)
// ---------------------------------------------------------------------------

/**
 * Read the complete pending snapshot for a root tree. The read of the full
 * pending list is the adapter's linearization point: requests present here
 * existed at the activation boundary. Adapters that cannot provide a complete
 * snapshot (upstream failure) make activation unsupported — callers must fail
 * closed rather than proceed with partial data.
 */
export async function captureActivationBoundary(
  client: InteractionWorkspaceOpencodeClient,
  rootSessionId: string,
  options?: { matchingOnly?: (request: NormalizedPermissionRequest) => boolean },
): Promise<string[]> {
  const snapshot = await readInteractionSnapshot(client, rootSessionId, true);
  const ids: string[] = [];
  for (const permission of snapshot.permissions) {
    const normalized = normalizePendingPermissionRequest(permission);
    if (!normalized) continue;
    if (options?.matchingOnly && !options.matchingOnly(normalized)) continue;
    ids.push(normalized.requestId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

export type SessionPermissionBrokerOptions = {
  store: SessionPermissionModeStore;
  config: ServerConfig;
  tokens: TokenService;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => InteractionWorkspaceOpencodeClient;
  interactionResolutions: InteractionResolutionCoordinator;
  rootLocks: RootSerialization;
  pollIntervalMs?: number;
  now?: () => number;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

const DEFAULT_POLL_INTERVAL_MS = 1_200;
const DECISION_PRUNE_INTERVAL_MS = 5 * 60_000;

export class SessionPermissionBroker {
  private readonly store: SessionPermissionModeStore;
  private readonly options: SessionPermissionBrokerOptions;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cyclePromise: Promise<void> = Promise.resolve();
  private lastPruneAt = 0;
  /** In-flight dispatch dedupe across cycles. */
  private inFlight = new Set<string>();

  constructor(options: SessionPermissionBrokerOptions) {
    this.options = options;
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Startup reconciliation + begin polling. */
  start(): void {
    if (this.timer) return;
    const now = this.now();
    const interruptedGrants = this.store.reconcileInterruptedGrants(now);
    const interruptedDecisions = this.store.reconcileInterruptedDecisions(now);
    if (interruptedGrants.length > 0 || interruptedDecisions > 0) {
      this.options.log?.("session-permission:reconciled-interrupted", {
        grants: interruptedGrants.length,
        decisions: interruptedDecisions,
      });
    }
    this.timer = setInterval(() => {
      void this.scheduleCycle();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private scheduleCycle(): void {
    if (this.running) return;
    this.running = true;
    this.cyclePromise = this.runCycle().catch(() => {
      // Upstream errors per workspace are logged inside; never crash the loop.
    }).finally(() => {
      this.running = false;
    });
  }

  private async runCycle(): Promise<void> {
    const now = this.now();
    if (now - this.lastPruneAt > DECISION_PRUNE_INTERVAL_MS) {
      this.lastPruneAt = now;
      for (const workspace of this.options.config.workspaces) {
        try {
          this.store.pruneWorkspaceDecisions(workspace.id, now);
        } catch {
          // Retention pruning is best-effort inside the cycle.
        }
      }
    }
    for (const workspace of this.options.config.workspaces) {
      if (!workspace.baseUrl?.trim()) continue;
      const rootIds = new Set([
        ...this.store.listActiveFullAccessRoots(workspace.id),
        ...this.store.listGrantRoots(workspace.id),
      ]);
      for (const rootSessionId of rootIds) {
        await this.options.rootLocks.with(`${workspace.id}\0${rootSessionId}`, async () => {
          await this.processRoot(workspace, rootSessionId).catch((error) => {
            this.options.log?.("session-permission:root-error", {
              workspaceId: workspace.id,
              rootSessionId,
              error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
            });
          });
        });
      }
    }
  }

  private async ceilingContext(workspaceId: string): Promise<SessionApprovalCeilingContext> {
    const policy = await readMcpWorkspaceToolPolicy(this.options.config, workspaceId);
    return {
      readOnly: this.options.config.readOnly,
      fullAccessPolicyAllowed: resolveServerFullAccessPolicy(this.options.config),
      disabledMcpServers: policy.disabledServerNames,
    };
  }

  private async processRoot(workspace: WorkspaceInfo, rootSessionId: string): Promise<void> {
    const workspaceId = workspace.id;
    const state = this.store.readModeState(workspaceId, rootSessionId);
    // Grant-only roots (request-approval mode or no mode row) still process
    // active grants; mode-derived authority requires a mode row.
    const fullAccessActive = state?.effectiveMode === "full-access";
    const grants = this.store.listActiveGrants(workspaceId, rootSessionId);
    if ((!state || !fullAccessActive) && grants.length === 0) return;
    if (fullAccessActive && state?.authorizingPrincipal == null) return;

    const client = this.options.createWorkspaceOpencodeClient(this.options.config, workspace);
    const snapshot = await readInteractionSnapshot(client, rootSessionId, true);
    if (snapshot.rootSessionId !== rootSessionId) return; // ancestry changed under us

    const ceiling = await this.ceilingContext(workspaceId);
    const excluded = this.store.listExcludedRequestIds(workspaceId, rootSessionId);
    const authorityRevisionAtRead = this.store.readAuthorityRevision(workspaceId, rootSessionId);

    for (const permission of snapshot.permissions) {
      const request = normalizePendingPermissionRequest(permission);
      if (!request || !request.wellFormed) continue;
      if (excluded.has(request.requestId)) continue;
      if (this.inFlight.has(request.requestId)) continue;
      if (this.store.hasPendingDecisionForRequest(workspaceId, request.requestId)) continue;

      // Eligibility: Full access, or a covering active grant.
      const coveredByGrant = grants.find((grant) =>
        sessionPermissionGrantCoversResources(grant, {
          protocol: request.protocol,
          permissionAction: request.permissionAction,
          resources: request.reusableScopeResources.length > 0
            ? request.reusableScopeResources
            : request.requestedResources,
        }) && !grant.exclusionRequestIds.includes(request.requestId),
      );
      if (!fullAccessActive && !coveredByGrant) continue;

      const verdict = evaluateSessionApprovalCeiling({
        context: ceiling,
        permissionAction: request.permissionAction,
        resources: request.requestedResources,
        wellFormed: request.wellFormed,
      });
      if (!verdict.allowed) {
        this.recordPolicyBlocked(workspaceId, rootSessionId, request, verdict);
        continue;
      }

      await this.dispatchAutomaticApproval(workspace, rootSessionId, request, {
        fullAccess: fullAccessActive,
        grant: coveredByGrant ?? null,
        authorityRevisionAtRead,
        authorizingPrincipal: fullAccessActive
          ? state.authorizingPrincipal
          : coveredByGrant?.authorizingPrincipal ?? null,
      });
    }
  }

  private recordPolicyBlocked(
    workspaceId: string,
    rootSessionId: string,
    request: NormalizedPermissionRequest,
    verdict: Extract<SessionApprovalCeilingVerdict, { allowed: false }>,
  ): void {
    try {
      if (this.store.hasPolicyBlockedDecision(workspaceId, request.requestId)) return;
      const decision = this.store.appendDecisionIntent({
        workspaceId,
        rootSessionId,
        targetSessionId: request.targetSessionId,
        kind: "policy-blocked",
        resourceSummary: [...request.requestedResources, verdict.reason],
        actor: { origin: "broker", id: null },
        authorityRevision: null,
        requestId: request.requestId,
        now: this.now(),
      });
      // A blocked decision is terminal immediately — no dispatch outcome.
      this.store.resolveDecision(decision.id, "succeeded", this.now());
    } catch {
      // Audit write failures for policy-blocked records do not widen authority.
    }
  }

  private async dispatchAutomaticApproval(
    workspace: WorkspaceInfo,
    rootSessionId: string,
    request: NormalizedPermissionRequest,
    input: {
      fullAccess: boolean;
      grant: SessionPermissionGrantRecord | null;
      authorityRevisionAtRead: number;
      authorizingPrincipal: SessionPermissionAuthorizingPrincipal | null;
    },
  ): Promise<void> {
    const workspaceId = workspace.id;
    if (!input.authorizingPrincipal) return;

    // Revalidation gate 1: authority revision must not have moved since read.
    const currentRevision = this.store.readAuthorityRevision(workspaceId, rootSessionId);
    if (currentRevision !== input.authorityRevisionAtRead) return;

    // Revalidation gate 2: the authorizing human principal must currently hold
    // authority; loss or unverifiable status durably suspends/invalidates.
    const verification = await verifyAuthorizingPrincipal({
      config: this.options.config,
      tokens: this.options.tokens,
      principal: input.authorizingPrincipal,
    });
    if (!verification.valid) {
      const now = this.now();
      if (input.fullAccess) {
        const suspended = this.store.suspendFullAccessForPrincipal(workspaceId, rootSessionId, now);
        if (suspended) {
          const decision = this.store.appendDecisionIntent({
            workspaceId,
            rootSessionId,
            targetSessionId: null,
            kind: "mode-change",
            resourceSummary: ["suspended: authorizing principal no longer holds authority"],
            actor: { origin: "system", id: input.authorizingPrincipal.id },
            authorityRevision: suspended.authorityRevision,
            requestId: null,
            now,
          });
          this.store.resolveDecision(decision.id, "succeeded", now);
        }
      }
      const invalidated = this.store.invalidateGrantsForPrincipal(workspaceId, input.authorizingPrincipal.id, now);
      for (const grantId of invalidated) {
        const decision = this.store.appendDecisionIntent({
          workspaceId,
          rootSessionId,
          targetSessionId: null,
          kind: "grant-remove",
          resourceSummary: ["invalidated: author no longer holds authority"],
          actor: { origin: "system", id: input.authorizingPrincipal.id },
          authorityRevision: null,
          requestId: grantId,
          now,
        });
        this.store.resolveDecision(decision.id, "succeeded", now);
      }
      this.options.log?.("session-permission:authority-suspended", {
        workspaceId,
        rootSessionId,
        principal: input.authorizingPrincipal.id.slice(0, 16),
        invalidatedGrants: invalidated.length,
      });
      return;
    }

    // Revalidation gate 3: the exact pending request must still exist.
    const client = this.options.createWorkspaceOpencodeClient(this.options.config, workspace);
    const pendingNow = await readPendingPermissions(client, request.targetSessionId);
    const pending = pendingNow.find((item) => item.id === request.requestId);
    if (!pending) return;

    // Durable audit intent first — fail closed when it cannot be persisted.
    let decisionId: string;
    try {
      const decision = this.store.appendDecisionIntent({
        workspaceId,
        rootSessionId,
        targetSessionId: request.targetSessionId,
        kind: "auto-approve",
        resourceSummary: request.requestedResources,
        actor: { origin: "broker", id: input.authorizingPrincipal.id },
        authorityRevision: currentRevision,
        requestId: request.requestId,
        now: this.now(),
      });
      decisionId = decision.id;
    } catch (error) {
      this.options.log?.("session-permission:intent-write-failed", {
        workspaceId,
        rootSessionId,
        requestId: request.requestId,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      return; // fail closed: no durable attribution, no dispatch
    }

    this.inFlight.add(request.requestId);
    const scope = {
      workspaceId,
      sessionId: request.targetSessionId,
      interactionId: request.requestId,
      kind: "permission" as const,
    };
    try {
      this.options.interactionResolutions.observePending(scope);
      const reservation = this.options.interactionResolutions.reserve({
        ...scope,
        origin: "local-renderer",
        commandCorrelationId: null,
      });
      try {
        await dispatchPermissionReply(client, pending, "allow_once");
        this.options.interactionResolutions.accept(reservation);
        this.store.resolveDecision(decisionId, "succeeded", this.now());
        this.options.log?.("session-permission:auto-approved", {
          workspaceId,
          rootSessionId,
          targetSessionId: request.targetSessionId,
          requestId: request.requestId,
          source: input.fullAccess ? "full-access" : "grant",
        });
      } catch (error) {
        this.options.interactionResolutions.rollback(reservation);
        this.store.resolveDecision(decisionId, "failed", this.now());
        this.options.log?.("session-permission:auto-approve-failed", {
          workspaceId,
          rootSessionId,
          requestId: request.requestId,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      }
    } catch (error) {
      // Reservation conflict: another controller is resolving this request.
      if (error instanceof Error && error.name === "InteractionResolutionError") {
        this.store.resolveDecision(decisionId, "indeterminate", this.now());
        return;
      }
      this.store.resolveDecision(decisionId, "failed", this.now());
    } finally {
      this.inFlight.delete(request.requestId);
    }
  }
}
