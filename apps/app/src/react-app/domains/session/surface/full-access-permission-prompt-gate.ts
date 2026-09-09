/** @jsxImportSource react */
import { useEffect, useState } from "react";

import type { PendingPermission } from "@/app/types";
import {
  SESSION_PERMISSION_PROFILE_VERSION,
  sessionPermissionGrantCoversResources,
  type SessionPermissionEffectiveMode,
  type SessionPermissionGrantRecord,
  type SessionPermissionGrantProtocol,
} from "@jugglework/types/session-permission-modes";

/**
 * How long the approval panel may stay hidden for a permission that first
 * arrives while plain `full-access` or an active session grant covers it. The
 * server-side session-permission broker approves eligible requests on its polling
 * cadence (default 1.2s) plus snapshot/dispatch latency; the live
 * permission event reaches this renderer first. The grace window covers
 * that latency so an auto-approved request never flashes a prompt
 * (spec: session-permission-modes — eligible requests resolve "without
 * showing an approval prompt"). If the broker cannot resolve the request
 * (policy-blocked, activation-excluded, server unavailable), the panel
 * reveals after the grace as the explicit-decision fallback.
 */
export const FULL_ACCESS_PROMPT_GRACE_MS = 2_500;

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function grantRequest(permission: PendingPermission): {
  protocol: SessionPermissionGrantProtocol;
  permissionAction: string;
  resources: string[];
} | null {
  const direct = permission as unknown as {
    action?: unknown;
    resources?: unknown;
    save?: unknown;
  };
  const v2Action = typeof direct.action === "string"
    ? direct.action
    : typeof permission.v2?.action === "string"
      ? permission.v2.action
      : "";
  if (v2Action) {
    const reusable = stringList(direct.save).length > 0
      ? stringList(direct.save)
      : stringList(permission.v2?.save);
    const requested = stringList(direct.resources).length > 0
      ? stringList(direct.resources)
      : stringList(permission.v2?.resources);
    return {
      protocol: "v2",
      permissionAction: v2Action,
      resources: reusable.length > 0 ? reusable : requested,
    };
  }

  const permissionAction = typeof permission.permission === "string" ? permission.permission : "";
  if (!permissionAction) return null;
  const reusable = stringList(permission.always);
  const requested = stringList(permission.patterns);
  return {
    protocol: "legacy",
    permissionAction,
    resources: reusable.length > 0 ? reusable : requested,
  };
}

/**
 * Mirror the broker's reusable-grant eligibility closely enough to decide
 * whether a prompt should enter the short auto-approval grace window. This is
 * presentation-only: the server still revalidates authority, policy, ancestry,
 * revision, and the exact pending request before it approves anything.
 */
export function isPermissionCoveredByActiveSessionGrant(
  permission: PendingPermission,
  grants: SessionPermissionGrantRecord[],
): boolean {
  const request = grantRequest(permission);
  if (!request || !permission.rootSessionId) return false;
  return grants.some((grant) =>
    grant.state === "active" &&
    grant.profileVersion === SESSION_PERMISSION_PROFILE_VERSION &&
    grant.rootSessionId === permission.rootSessionId &&
    !grant.exclusionRequestIds.includes(permission.id) &&
    sessionPermissionGrantCoversResources(grant, request),
  );
}

/**
 * Gate the first reveal of the permission approval panel while the request is
 * eligible for server-side automatic approval.
 *
 * - Plain `full-access` or an active matching session grant suppresses.
 *   Paused/suspended modes do not contribute authority; unknown/loading state
 *   without a known active grant fails open to prompting immediately.
 * - Suppression applies only until first reveal: once a permission has
 *   been shown (or was already visible when the mode changed), it is
 *   never hidden again.
 * - A new permission id starts a fresh grace window.
 */
export function useFullAccessPermissionPromptGate(
  permission: PendingPermission | null,
  effectiveMode: SessionPermissionEffectiveMode | null,
  grants: SessionPermissionGrantRecord[] = [],
  graceMs: number = FULL_ACCESS_PROMPT_GRACE_MS,
): PendingPermission | null {
  const key = permission ? `${permission.targetSessionId}\u0000${permission.id}` : null;
  const suppress = Boolean(permission) && (
    effectiveMode === "full-access" ||
    isPermissionCoveredByActiveSessionGrant(permission!, grants)
  );
  const [slot, setSlot] = useState<{ key: string | null; revealed: boolean }>({ key: null, revealed: true });

  // Derived-state adjustment during render (React-supported pattern):
  // a new permission starts revealed unless suppressed; a permission that
  // was suppressed reveals immediately once suppression no longer applies.
  if (key !== slot.key) {
    setSlot({ key, revealed: !suppress });
  } else if (!slot.revealed && !suppress) {
    setSlot({ key, revealed: true });
  }

  useEffect(() => {
    if (key === null || slot.key !== key || slot.revealed) return;
    const timer = setTimeout(() => {
      setSlot((current) => (current.key === key && !current.revealed ? { key, revealed: true } : current));
    }, graceMs);
    return () => clearTimeout(timer);
  }, [key, slot.key, slot.revealed, graceMs]);

  if (key === null || slot.key !== key) return null;
  if (slot.revealed || !suppress) return permission;
  return null;
}
