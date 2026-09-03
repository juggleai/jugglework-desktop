/**
 * Session permission mode shared contracts.
 *
 * These types are the wire contract between the JuggleWork server that owns a
 * workspace and any authorized client (desktop renderer or future tooling).
 * They define the versioned permission-mode profile, reusable session-scoped
 * grants, the sanitized security-decision ledger, and API payload shapes.
 *
 * Security invariants encoded here (see
 * openspec/changes/add-session-permission-modes/specs/session-permission-modes):
 *
 * - Full access is explicit, versioned, and acknowledged; unsupported or
 *   malformed persisted versions resolve to a paused effective mode.
 * - Reusable grants are JuggleWork-owned and never rely on protocol-native
 *   OpenCode `always` persistence.
 * - Automatic authority is delegated by a recorded human principal; losing or
 *   being unable to verify that principal's scope durably suspends it.
 * - Every authority-widening decision must persist a durable audit intent
 *   before taking effect and a terminal outcome afterward.
 */

/** Persistance schema discriminator for root-session permission-mode records. */
export const SESSION_PERMISSION_MODE_SCHEMA = "session-permission-mode/v1" as const;

/** Persistance schema discriminator for reusable session grant records. */
export const SESSION_PERMISSION_GRANT_SCHEMA = "session-permission-grant/v1" as const;

/** Persistance schema discriminator for security-decision ledger units. */
export const SESSION_PERMISSION_DECISION_SCHEMA = "session-permission-decision/v1" as const;

/**
 * Governing semantics version for Full access and grant matching.
 *
 * Bump when the meaning of Full access, grant matching, eligibility classes,
 * or acknowledgement copy materially changes. Persisted records with a
 * different version must fail closed (paused mode / inactive grant) until
 * explicitly renewed under the running server's version.
 */
export const SESSION_PERMISSION_PROFILE_VERSION = 1 as const;

/** User-selectable permission mode for a root session. */
export type SessionPermissionModeChoice = "request-approval" | "full-access";

/**
 * Effective permission mode after fail-closed evaluation.
 *
 * - `full-access-paused`: persisted profile/acknowledgement version is not
 *   exactly supported by the running server (older, future, unknown,
 *   malformed, or mismatched).
 * - `full-access-suspended`: the authorizing principal lost authority or it
 *   cannot be authoritatively verified. Requires explicit owner renewal.
 */
export type SessionPermissionEffectiveMode =
  | "request-approval"
  | "full-access"
  | "full-access-paused"
  | "full-access-suspended";

/** Scope the authorizing principal held when widening authority. */
export type SessionPermissionPrincipalScope = "owner" | "collaborator";

export type SessionPermissionAuthorizingPrincipal = {
  id: string;
  scope: SessionPermissionPrincipalScope;
};

/** Authoritative per-root-session permission-mode state (server-owned). */
export type SessionPermissionModeState = {
  schema: typeof SESSION_PERMISSION_MODE_SCHEMA;
  workspaceId: string;
  rootSessionId: string;
  requestedMode: SessionPermissionModeChoice;
  effectiveMode: SessionPermissionEffectiveMode;
  /** Profile version the record was last written under. */
  profileVersion: number;
  /** Profile version the user explicitly acknowledged for Full access. */
  acknowledgedProfileVersion: number | null;
  /** Principal who enabled Full access; null in request-approval mode. */
  authorizingPrincipal: SessionPermissionAuthorizingPrincipal | null;
  /**
   * Shared authority revision. Every mode or grant mutation advances it so
   * stale automatic decisions lose revalidation races.
   */
  authorityRevision: number;
  /** Timestamp of the most recent Full-access activation boundary. */
  activatedAt: number | null;
  updatedAt: number;
};

/** Durable state machine for a reusable session grant. */
export type SessionPermissionGrantState =
  | "pending"
  | "dispatching"
  | "active"
  | "failed"
  | "indeterminate";

/** Upstream permission protocol the grant was created from. */
export type SessionPermissionGrantProtocol = "legacy" | "v2";

/** JuggleWork-owned reusable grant scoped to one root session tree. */
export type SessionPermissionGrantRecord = {
  schema: typeof SESSION_PERMISSION_GRANT_SCHEMA;
  id: string;
  workspaceId: string;
  rootSessionId: string;
  protocol: SessionPermissionGrantProtocol;
  /** Normalized permission/action string from the source request. */
  permissionAction: string;
  /** Reusable resource patterns (legacy `always` or v2 `save` scope). */
  resources: string[];
  profileVersion: number;
  state: SessionPermissionGrantState;
  authorizingPrincipal: SessionPermissionAuthorizingPrincipal;
  /** The exact request the user approved while creating this grant. */
  sourceRequestId: string;
  sourceTargetSessionId: string;
  /**
   * Matching request identities present at the activation boundary that must
   * stay manual. The source request itself is exempt by design.
   */
  exclusionRequestIds: string[];
  createdAt: number;
  updatedAt: number;
};

/** Kind of security decision recorded in the ledger. */
export type SessionPermissionDecisionKind =
  | "mode-change"
  | "grant-create"
  | "grant-remove"
  | "auto-approve"
  | "policy-blocked";

/** Terminal-or-pending outcome of a security decision unit. */
export type SessionPermissionDecisionOutcome = "pending" | "succeeded" | "failed" | "indeterminate";

export type SessionPermissionDecisionActor = {
  origin: "renderer" | "broker" | "system";
  id: string | null;
};

/**
 * One linked decision unit: a durable intent row plus (eventually) a terminal
 * outcome. Bounded, sanitized fields only — never raw metadata, credentials,
 * environment values, unbounded commands, or tool output.
 */
export type SessionPermissionDecisionRecord = {
  schema: typeof SESSION_PERMISSION_DECISION_SCHEMA;
  id: string;
  workspaceId: string;
  rootSessionId: string | null;
  targetSessionId: string | null;
  kind: SessionPermissionDecisionKind;
  outcome: SessionPermissionDecisionOutcome;
  /** Bounded, redacted resource summary (already capped/truncated). */
  resourceSummary: string[];
  actor: SessionPermissionDecisionActor | null;
  profileVersion: number;
  authorityRevision: number | null;
  requestId: string | null;
  createdAt: number;
  resolvedAt: number | null;
};

// ---------------------------------------------------------------------------
// Sanitization bounds (shared by server writer and any projection surfaces).
// ---------------------------------------------------------------------------

/** Maximum number of resource patterns retained per grant or decision. */
export const SESSION_PERMISSION_RESOURCE_MAX_COUNT = 32;

/** Maximum retained length of a single resource string. */
export const SESSION_PERMISSION_RESOURCE_MAX_LENGTH = 512;

/** Maximum retained decision-unit resource-summary entries. */
export const SESSION_PERMISSION_DECISION_RESOURCE_SUMMARY_MAX = 8;

/** Retention cap for completed decision units per workspace. */
export const SESSION_PERMISSION_DECISION_RETENTION_COUNT = 10_000;

/** Retention age for completed decision units. */
export const SESSION_PERMISSION_DECISION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Approval ceiling contract (task 1.3).
// ---------------------------------------------------------------------------

/** Non-overridable server-side approval ceiling verdict. */
export type SessionApprovalCeilingVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "server-read-only"
        | "insufficient-scope"
        | "organization-policy"
        | "disabled-mcp"
        | "unverified-ancestry"
        | "malformed-request";
    };

/** Eligibility classification for a well-formed pending permission request. */
export type SessionPermissionRequestEligibility =
  | { kind: "eligible" }
  | { kind: "policy-blocked"; verdict: Extract<SessionApprovalCeilingVerdict, { allowed: false }> };

// ---------------------------------------------------------------------------
// Grant matching grammar.
// ---------------------------------------------------------------------------

/**
 * Full-string glob match used for grant resources: `*` matches zero or more
 * characters; every other character is literal. Case-sensitive, no
 * canonicalization — compares the exact upstream resource strings.
 */
export function matchesSessionPermissionResource(pattern: string, resource: string): boolean {
  if (pattern.length === 0 || resource.length === 0) return false;
  // Regex-escape everything except '*', which becomes '.*'.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(resource);
}

/**
 * True when every requested resource is covered by at least one grant pattern
 * (complete coverage rule). Fails closed on empty or malformed input.
 */
export function sessionPermissionGrantCoversResources(grant: {
  protocol: SessionPermissionGrantProtocol;
  permissionAction: string;
  resources: string[];
}, request: {
  protocol: SessionPermissionGrantProtocol;
  permissionAction: string;
  resources: string[];
}): boolean {
  if (grant.protocol !== request.protocol) return false;
  if (grant.permissionAction !== request.permissionAction) return false;
  const patterns = [...new Set(grant.resources)].filter((pattern) => pattern.length > 0);
  const resources = [...new Set(request.resources)].filter((resource) => resource.length > 0);
  if (patterns.length === 0 || resources.length === 0) return false;
  return resources.every((resource) =>
    patterns.some((pattern) => matchesSessionPermissionResource(pattern, resource)),
  );
}

// ---------------------------------------------------------------------------
// API payload shapes.
// ---------------------------------------------------------------------------

/** GET session permission mode response. `state` is null until first write. */
export type SessionPermissionModeReadResponse = {
  state: SessionPermissionModeState | null;
  grants: SessionPermissionGrantRecord[];
  /** Whether the owning server implements this capability. */
  supported: boolean;
  profileVersion: number;
};

/** Acknowledgement payload required to enable Full access. */
export type SessionPermissionAcknowledgementPayload = {
  profileVersion: number;
  acknowledgedAt: number;
};

/** Compare-and-set mode update. Stale revisions are rejected with 409. */
export type SessionPermissionModeUpdateRequest = {
  requestedMode: SessionPermissionModeChoice;
  expectedRevision: number;
  acknowledgement: SessionPermissionAcknowledgementPayload | null;
};

export type SessionPermissionModeUpdateResponse = {
  state: SessionPermissionModeState;
  /** Grants cleared by this update (downgrade clears all unconditionally). */
  clearedGrantIds: string[];
};

/** Reusable scope offered by a pending permission request, for the panel UI. */
export type SessionPermissionReusableScope = {
  protocol: SessionPermissionGrantProtocol;
  permissionAction: string;
  resources: string[];
} | null;
