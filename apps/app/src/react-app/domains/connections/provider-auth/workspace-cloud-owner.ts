/**
 * Which account's cloud state each workspace currently holds.
 *
 * Purging on sign-out or account switch can only reach the *active* workspace:
 * a workspace's cloud config lives behind its own JuggleWork server, and
 * booting every configured workspace to clean it would be a heavy, failure-
 * prone thing to do mid sign-out. Instead every workspace carries the id of
 * the account whose state was written into it, and a mismatch is settled the
 * moment that workspace is next synced — before the new account can use
 * anything the previous one left behind.
 */

const OWNER_KEY_PREFIX = "jugglework.den.cloudStateOwner:";

export type WorkspaceCloudStateOwnerAction =
  /** Same account, or nothing to decide yet — sync normally. */
  | "keep"
  /** No owner on record: adopt the workspace for the current account. */
  | "stamp"
  /** A different account's state is in this workspace: purge, then stamp. */
  | "purge";

export function workspaceCloudStateOwnerAction(input: {
  storedOwnerId: string | null | undefined;
  currentUserId: string | null | undefined;
}): WorkspaceCloudStateOwnerAction {
  const current = input.currentUserId?.trim() ?? "";
  // No identity for the current session — never purge on a guess.
  if (!current) return "keep";
  const stored = input.storedOwnerId?.trim() ?? "";
  if (!stored) return "stamp";
  return stored === current ? "keep" : "purge";
}

function ownerKey(workspaceKey: string): string | null {
  const resolved = workspaceKey.trim();
  return resolved ? `${OWNER_KEY_PREFIX}${resolved}` : null;
}

export function readWorkspaceCloudStateOwner(workspaceKey: string): string | null {
  if (typeof window === "undefined") return null;
  const key = ownerKey(workspaceKey);
  if (!key) return null;
  try {
    return (window.localStorage.getItem(key) ?? "").trim() || null;
  } catch {
    return null;
  }
}

export function writeWorkspaceCloudStateOwner(workspaceKey: string, userId: string | null) {
  if (typeof window === "undefined") return;
  const key = ownerKey(workspaceKey);
  if (!key) return;
  try {
    const resolved = userId?.trim() ?? "";
    if (resolved) {
      window.localStorage.setItem(key, resolved);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable. The stamp is an optimisation over re-purging, not a
    // correctness requirement — a missing one only means "adopt on next sync".
  }
}
