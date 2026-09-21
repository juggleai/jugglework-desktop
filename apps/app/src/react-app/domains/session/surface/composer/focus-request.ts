export const COMPOSER_FOCUS_REQUEST_EVENT = "jugglework:focusPrompt";

export type ComposerFocusReason =
  | "session-switch"
  | "session-created"
  | "model-picker"
  | "onboarding"
  | "control";

export type ComposerFocusRequest = {
  id: number;
  sessionId: string;
  reason: ComposerFocusReason;
  requestedAt: number;
  expiresAt: number;
};

const REQUEST_LIFETIME_MS = 4_000;

let requestSequence = 0;
let pendingRequest: ComposerFocusRequest | null = null;
let expiryTimer: number | null = null;
let removeIntentListeners: (() => void) | null = null;

function clearPendingRequest(expectedId?: number) {
  if (expectedId !== undefined && pendingRequest?.id !== expectedId) return false;
  pendingRequest = null;
  if (expiryTimer !== null) {
    window.clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  removeIntentListeners?.();
  removeIntentListeners = null;
  return true;
}

function cancelOnNextUserIntent(requestId: number) {
  const cancel = () => {
    clearPendingRequest(requestId);
  };
  const options = { capture: true, once: true } as const;
  window.addEventListener("pointerdown", cancel, options);
  window.addEventListener("keydown", cancel, options);
  removeIntentListeners = () => {
    window.removeEventListener("pointerdown", cancel, true);
    window.removeEventListener("keydown", cancel, true);
  };
}

/**
 * Request a single focus handoff to one session composer.
 *
 * The request remains pending until the target composer is mounted and
 * editable. A newer navigation replaces it, while any subsequent pointer or
 * keyboard input cancels it so delayed application work never overrides the
 * user's newer intent.
 */
export function requestComposerFocus(sessionId: string, reason: ComposerFocusReason) {
  if (typeof window === "undefined") return null;
  const targetSessionId = sessionId.trim();
  if (!targetSessionId) return null;

  clearPendingRequest();
  const requestedAt = Date.now();
  const request: ComposerFocusRequest = {
    id: ++requestSequence,
    sessionId: targetSessionId,
    reason,
    requestedAt,
    expiresAt: requestedAt + REQUEST_LIFETIME_MS,
  };
  pendingRequest = request;
  cancelOnNextUserIntent(request.id);
  expiryTimer = window.setTimeout(() => clearPendingRequest(request.id), REQUEST_LIFETIME_MS);
  window.dispatchEvent(new CustomEvent<ComposerFocusRequest>(COMPOSER_FOCUS_REQUEST_EVENT, {
    detail: request,
  }));
  return request.id;
}

export function getPendingComposerFocusRequest() {
  if (!pendingRequest) return null;
  if (pendingRequest.expiresAt <= Date.now()) {
    clearPendingRequest(pendingRequest.id);
    return null;
  }
  return pendingRequest;
}

export function cancelComposerFocusRequest(requestId?: number) {
  if (typeof window === "undefined") return false;
  return clearPendingRequest(requestId);
}

export function completeComposerFocusRequest(requestId: number, sessionId: string) {
  if (pendingRequest?.id !== requestId || pendingRequest.sessionId !== sessionId) return false;
  return clearPendingRequest(requestId);
}
