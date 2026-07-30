import { MODEL_PREF_KEY } from "../../../app/constants";
import { readDenUserId, writeDenUserId } from "../../../app/lib/den";
import { clearAllCloudMcpLocalState } from "../connections/cloud-mcp-user-state";

/**
 * Local state on this machine is not owned by any account: the workspace list,
 * each workspace's cloud config, and a handful of localStorage records all
 * outlive a sign-out. That is fine for a re-login and wrong for a different
 * person, so every account-scoped record has to be recognised and dropped when
 * the signed-in identity changes.
 */

export type AccountTransition =
  /** Same person as last time, or no identity to compare against yet. */
  | "same"
  /** First sign-in this machine has recorded — nothing to attribute to anyone. */
  | "first-known"
  /** A different account: local state still belongs to the previous user. */
  | "switched";

export function classifyAccountTransition(
  storedUserId: string | null | undefined,
  nextUserId: string | null | undefined,
): AccountTransition {
  const next = nextUserId?.trim() ?? "";
  // Without an identity for the incoming session there is nothing to compare,
  // and guessing "switched" would purge a working session's state.
  if (!next) return "same";
  const stored = storedUserId?.trim() ?? "";
  if (!stored) return "first-known";
  return stored === next ? "same" : "switched";
}

/**
 * Machine-wide records that only mean something to the account that wrote
 * them. Per-workspace cloud state is not here: it lives in each workspace's
 * runtime config and is purged by the provider-auth store, which is the only
 * place holding a client that can reach it.
 */
function clearAccountScopedLocalState() {
  if (typeof window === "undefined") return;
  try {
    // Points at the previous org's `lpr_*` provider, which is about to be
    // removed from the workspace.
    window.localStorage.removeItem(MODEL_PREF_KEY);
    // "This provider is not new to me" — a judgement the new account never made.
    window.localStorage.removeItem("jugglework.acknowledgedProviders");
  } catch {
    // Storage unavailable — nothing was persisted to clear.
  }
  clearAllCloudMcpLocalState();
}

/**
 * Record who is signed in and, when that is a different account than the one
 * this machine last held state for, drop the state that belonged to them.
 *
 * Call on every confirmed sign-in. Returns the transition so callers can tell
 * a switch from a routine session refresh.
 */
export function reconcileDenAccountIdentity(nextUserId: string | null | undefined): AccountTransition {
  const storedUserId = readDenUserId();
  const transition = classifyAccountTransition(storedUserId, nextUserId);
  if (transition === "same") return transition;

  if (transition === "switched") {
    clearAccountScopedLocalState();
    // Per-workspace cloud state is deliberately NOT purged from here. Each
    // workspace settles its own owner stamp at the top of its next provider
    // sync, which is the one place where the purge is ordered before the new
    // account's import — purging from here would race that import and could
    // delete what it just wrote.
  }

  writeDenUserId(nextUserId ?? null);
  return transition;
}
