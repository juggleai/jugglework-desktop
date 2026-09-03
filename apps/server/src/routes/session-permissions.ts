/**
 * Session permission mode routes.
 *
 * - GET    /workspace/:id/sessions/:rootSessionId/permission-mode
 * - PUT    /workspace/:id/sessions/:rootSessionId/permission-mode
 * - POST   /workspace/:id/sessions/:rootSessionId/permission-mode/grants/clear
 * - POST   /workspace/:id/sessions/:sessionId/interactions/:interactionId/permission/grant-reply
 *
 * Authority is derived exclusively from authenticated transport context
 * (bearer scope or validated host token). Body-supplied origin fields are
 * never trusted for authorization (task 1.4).
 */

import {
  SESSION_PERMISSION_PROFILE_VERSION,
  type SessionPermissionAuthorizingPrincipal,
  type SessionPermissionModeUpdateRequest,
} from "@jugglework/types/session-permission-modes";
import { z } from "zod";

import { ApiError } from "../errors.js";
import type { InteractionResolutionCoordinator } from "../interaction-resolution-coordinator.js";
import {
  captureActivationBoundary,
  evaluateSessionApprovalCeiling,
  normalizePendingPermissionRequest,
  resolveServerFullAccessPolicy,
  type RootSerialization,
} from "../session-permission-broker.js";
import type { SessionPermissionModeStore } from "../session-permission-mode-store.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { hashToken } from "../utils.js";
import {
  dispatchPermissionReply,
  readInteractionSnapshot,
  readPendingPermissions,
  type InteractionWorkspaceOpencodeClient,
} from "./interactions.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type WorkspaceOpencodeClientFactory = (config: ServerConfig, workspace: WorkspaceInfo) => InteractionWorkspaceOpencodeClient;

interface RegisterSessionPermissionRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  store: SessionPermissionModeStore;
  rootLocks: RootSerialization;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: WorkspaceOpencodeClientFactory;
  interactionResolutions: InteractionResolutionCoordinator;
}

const modeUpdateSchema = z.object({
  requestedMode: z.enum(["request-approval", "full-access"]),
  expectedRevision: z.number().int().min(0),
  acknowledgement: z.object({
    profileVersion: z.number().int().min(1),
    acknowledgedAt: z.number().int().min(0),
  }).nullable(),
}).strict();

/**
 * Owner-or-host authority: an owner-scoped bearer token, or the validated
 * host token header (host-equivalent local authority). Both are
 * server-verified; nothing caller-asserted participates.
 */
function requireOwnerOrHost(ctx: RequestContext, config: ServerConfig): SessionPermissionAuthorizingPrincipal | null {
  const hostHeader = ctx.request.headers.get("x-jugglework-host-token");
  if (hostHeader && hostHeader === config.hostToken) {
    return { id: hashToken(hostHeader), scope: "owner" };
  }
  if (ctx.actor?.scope === "owner" && ctx.actor.tokenHash) {
    return { id: ctx.actor.tokenHash, scope: "owner" };
  }
  return null;
}

function principalFromActor(ctx: RequestContext): SessionPermissionAuthorizingPrincipal | null {
  const tokenHash = ctx.actor?.tokenHash;
  const scope = ctx.actor?.scope;
  if (!tokenHash || (scope !== "owner" && scope !== "collaborator")) return null;
  return { id: tokenHash, scope };
}

export function registerSessionPermissionRoutes(options: RegisterSessionPermissionRoutesOptions): void {
  const {
    routes,
    config,
    store,
    rootLocks,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    createWorkspaceOpencodeClient,
    interactionResolutions,
  } = options;

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/permission-mode", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = ctx.params.sessionId;
    const state = store.readModeState(workspace.id, sessionId);
    const grants = store.listGrants(workspace.id, sessionId);
    return jsonResponse({
      state,
      grants,
      supported: true,
      profileVersion: SESSION_PERMISSION_PROFILE_VERSION,
    });
  });

  addRoute(routes, "PUT", "/workspace/:id/sessions/:sessionId/permission-mode", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const rootSessionId = ctx.params.sessionId;

    const parsed = modeUpdateSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_payload", "Permission mode payload is invalid");
    const body: SessionPermissionModeUpdateRequest = parsed.data;

    const client = createWorkspaceOpencodeClient(config, workspace);
    // The pane session must be an authoritative root for mode configuration.
    const ancestrySnapshot = await readInteractionSnapshot(client, rootSessionId, false);
    if (ancestrySnapshot.rootSessionId !== rootSessionId) {
      throw new ApiError(400, "session_not_root", "Permission mode requires a root session");
    }

    const now = Date.now();
    if (body.requestedMode === "full-access") {
      const principal = requireOwnerOrHost(ctx, config);
      if (!principal) {
        throw new ApiError(403, "forbidden", "Enabling Full access requires owner or host authority");
      }
      if (!resolveServerFullAccessPolicy(config)) {
        throw new ApiError(403, "organization_policy", "Session Full access is disabled by policy");
      }
      const acknowledgement = body.acknowledgement;
      if (
        !acknowledgement ||
        acknowledgement.profileVersion !== SESSION_PERMISSION_PROFILE_VERSION ||
        !Number.isSafeInteger(acknowledgement.acknowledgedAt) ||
        acknowledgement.acknowledgedAt > now + 5 * 60_000
      ) {
        throw new ApiError(400, "acknowledgement_required", "Full access requires a current-profile acknowledgement");
      }

      const result = await rootLocks.with(`${workspace.id}\0${rootSessionId}`, async () => {
        // Arming: the complete pending snapshot read is the linearization
        // point. Upstream failure fails the activation closed (task 4.3).
        let activationExclusionRequestIds: string[];
        try {
          activationExclusionRequestIds = await captureActivationBoundary(client, rootSessionId);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(502, "activation_snapshot_unavailable", "Activation snapshot could not be read");
        }
        // Durable audit intent before the mode change takes effect (task 5.4).
        const decision = store.appendDecisionIntent({
          workspaceId: workspace.id,
          rootSessionId,
          targetSessionId: null,
          kind: "mode-change",
          resourceSummary: ["full-access"],
          actor: { origin: "renderer", id: principal.id },
          authorityRevision: body.expectedRevision,
          requestId: null,
          now,
        });
        const update = store.updateMode({
          workspaceId: workspace.id,
          rootSessionId,
          requestedMode: "full-access",
          expectedRevision: body.expectedRevision,
          acknowledgementProfileVersion: acknowledgement.profileVersion,
          authorizingPrincipal: principal,
          activationExclusionRequestIds,
          now,
        });
        if (!update.ok) {
          store.resolveDecision(decision.id, "failed", now);
          throw new ApiError(409, "permission_mode_changed", "Permission mode was modified concurrently");
        }
        store.resolveDecision(decision.id, "succeeded", now);
        return update;
      });
      return jsonResponse({ state: result.state, clearedGrantIds: result.clearedGrantIds });
    }

    // Downgrade to request approval: collaborator+ may narrow authority.
    const decision = store.appendDecisionIntent({
      workspaceId: workspace.id,
      rootSessionId,
      targetSessionId: null,
      kind: "mode-change",
      resourceSummary: ["request-approval"],
      actor: { origin: "renderer", id: principalFromActor(ctx)?.id ?? null },
      authorityRevision: body.expectedRevision,
      requestId: null,
      now,
    });
    const update = store.updateMode({
      workspaceId: workspace.id,
      rootSessionId,
      requestedMode: "request-approval",
      expectedRevision: body.expectedRevision,
      acknowledgementProfileVersion: null,
      authorizingPrincipal: null,
      activationExclusionRequestIds: [],
      now,
    });
    if (!update.ok) {
      store.resolveDecision(decision.id, "failed", now);
      throw new ApiError(409, "permission_mode_changed", "Permission mode was modified concurrently");
    }
    store.resolveDecision(decision.id, "succeeded", now);
    return jsonResponse({ state: update.state, clearedGrantIds: update.clearedGrantIds });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/permission-mode/grants/clear", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const rootSessionId = ctx.params.sessionId;
    const now = Date.now();
    const clearedGrantIds = await rootLocks.with(`${workspace.id}\0${rootSessionId}`, () =>
      Promise.resolve(store.clearGrants(workspace.id, rootSessionId, now)),
    );
    for (const grantId of clearedGrantIds) {
      const decision = store.appendDecisionIntent({
        workspaceId: workspace.id,
        rootSessionId,
        targetSessionId: null,
        kind: "grant-remove",
        resourceSummary: ["cleared-by-user"],
        actor: { origin: "renderer", id: principalFromActor(ctx)?.id ?? null },
        authorityRevision: null,
        requestId: grantId,
        now,
      });
      store.resolveDecision(decision.id, "succeeded", now);
    }
    return jsonResponse({
      state: store.readModeState(workspace.id, rootSessionId),
      clearedGrantIds,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/interactions/:interactionId/permission/grant-reply", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const principal = principalFromActor(ctx);
    if (!principal) throw new ApiError(403, "forbidden", "Grant creation requires collaborator authority");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const targetSessionId = ctx.params.sessionId;
    const interactionId = ctx.params.interactionId;
    const client = createWorkspaceOpencodeClient(config, workspace);
    const now = Date.now();

    // Exact pending re-read — the request must exist right now.
    const pendingList = await readPendingPermissions(client, targetSessionId);
    const pending = pendingList.find((item) => item.id === interactionId);
    if (!pending) throw new ApiError(404, "interaction_not_found", "The interaction was not found");

    const request = normalizePendingPermissionRequest(pending);
    if (!request || !request.wellFormed) {
      throw new ApiError(400, "malformed_request", "The permission request cannot be normalized");
    }
    if (request.reusableScopeResources.length === 0) {
      throw new ApiError(400, "no_reusable_scope", "The request offers no reusable session scope");
    }

    // Shared approval ceiling applies to grant creation like every dispatch.
    const verdict = evaluateSessionApprovalCeiling({
      context: {
        readOnly: config.readOnly,
        fullAccessPolicyAllowed: resolveServerFullAccessPolicy(config),
        disabledMcpServers: [], // workspace MCP policy is enforced at execution time
      },
      permissionAction: request.permissionAction,
      resources: request.requestedResources,
      wellFormed: request.wellFormed,
    });
    if (!verdict.allowed) {
      throw new ApiError(403, "permission_policy_blocked", `Blocked by server permission policy (${verdict.reason})`);
    }

    // Resolve the authoritative root for this target.
    const targetSnapshot = await readInteractionSnapshot(client, targetSessionId, false);
    const rootSessionId = targetSnapshot.rootSessionId;

    const scope = {
      workspaceId: workspace.id,
      sessionId: targetSessionId,
      interactionId,
      kind: "permission" as const,
    };

    const result = await rootLocks.with(`${workspace.id}\0${rootSessionId}`, async () => {
      // Arming: exclude every other matching request present at the boundary;
      // the explicitly approved source request is exempt by design.
      let exclusionRequestIds: string[];
      try {
        exclusionRequestIds = (await captureActivationBoundary(client, rootSessionId, {
          matchingOnly: (candidate) =>
            candidate.protocol === request.protocol &&
            candidate.permissionAction === request.permissionAction &&
            candidate.requestId !== request.requestId,
        }));
      } catch {
        throw new ApiError(502, "activation_snapshot_unavailable", "Grant activation snapshot could not be read");
      }

      // Durable intent + inactive pending grant BEFORE dispatch (tasks 3.4/3.5).
      const decision = store.appendDecisionIntent({
        workspaceId: workspace.id,
        rootSessionId,
        targetSessionId,
        kind: "grant-create",
        resourceSummary: request.reusableScopeResources,
        actor: { origin: "renderer", id: principal.id },
        authorityRevision: null,
        requestId: request.requestId,
        now,
      });
      const grant = store.insertPendingGrant({
        workspaceId: workspace.id,
        rootSessionId,
        protocol: request.protocol,
        permissionAction: request.permissionAction,
        resources: request.reusableScopeResources,
        authorizingPrincipal: principal,
        sourceRequestId: request.requestId,
        sourceTargetSessionId: targetSessionId,
        exclusionRequestIds,
        now,
      });
      store.transitionGrant(grant.id, "dispatching", now);

      interactionResolutions.observePending(scope);
      const reservation = interactionResolutions.reserve({
        ...scope,
        origin: "local-renderer",
        commandCorrelationId: null,
      });
      try {
        await dispatchPermissionReply(client, pending, "allow_once");
        interactionResolutions.accept(reservation);
        const activated = store.transitionGrant(grant.id, "active", now);
        store.resolveDecision(decision.id, "succeeded", now);
        return activated;
      } catch (error) {
        interactionResolutions.rollback(reservation);
        store.transitionGrant(grant.id, "failed", now);
        store.resolveDecision(decision.id, "failed", now);
        throw error;
      }
    });

    return jsonResponse({ grant: result, state: store.readModeState(workspace.id, rootSessionId) });
  });
}
