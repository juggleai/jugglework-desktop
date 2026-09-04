/** @jsxImportSource react */
import { useEffect, useState } from "react";

import type { PendingPermission } from "@/app/types";
import type { SessionPermissionEffectiveMode } from "@jugglework/types/session-permission-modes";

/**
 * How long the approval panel may stay hidden for a permission that first
 * arrives while plain `full-access` is effective. The server-side
 * session-permission broker approves eligible requests on its polling
 * cadence (default 1.2s) plus snapshot/dispatch latency; the live
 * permission event reaches this renderer first. The grace window covers
 * that latency so an auto-approved request never flashes a prompt
 * (spec: session-permission-modes — eligible requests resolve "without
 * showing an approval prompt"). If the broker cannot resolve the request
 * (policy-blocked, activation-excluded, server unavailable), the panel
 * reveals after the grace as the explicit-decision fallback.
 */
export const FULL_ACCESS_PROMPT_GRACE_MS = 2_500;

/**
 * Gate the first reveal of the permission approval panel while plain
 * `full-access` is effective for this root session.
 *
 * - Only plain `full-access` suppresses. `full-access-paused` and
 *   `full-access-suspended` never auto-approve, and an unknown/loading
 *   mode fails open to prompting immediately.
 * - Suppression applies only until first reveal: once a permission has
 *   been shown (or was already visible when the mode changed), it is
 *   never hidden again.
 * - A new permission id starts a fresh grace window.
 */
export function useFullAccessPermissionPromptGate(
  permission: PendingPermission | null,
  effectiveMode: SessionPermissionEffectiveMode | null,
  graceMs: number = FULL_ACCESS_PROMPT_GRACE_MS,
): PendingPermission | null {
  const key = permission ? `${permission.targetSessionId}\u0000${permission.id}` : null;
  const suppress = Boolean(permission) && effectiveMode === "full-access";
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
