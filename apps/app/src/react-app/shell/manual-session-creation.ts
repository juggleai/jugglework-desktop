// Shared by retained routes, not component instances. The first caller owns
// navigation, draft and group effects; joiners receive exactly the same promise.
export function createManualSessionCreationRegistry() {
  const flights = new Map<string, Promise<string | null>>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const emit = () => {
    revision++;
    listeners.forEach((listener) => listener());
  };
  return {
    revision: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    pending: (key: string) => flights.has(key),
    run(key: string, operation: () => Promise<string | null>): Promise<string | null> {
      const existing = flights.get(key);
      if (existing) return existing;
      // Reserve before executing any user code (including navigation generation).
      const promise = Promise.resolve().then(operation).finally(() => {
        flights.delete(key);
        emit();
      });
      flights.set(key, promise);
      emit();
      return promise;
    },
  };
}

const credentialScopes = new Map<string, string>();
export function manualSessionCreationKey(runtimeUrl: string, workspaceId: string, credential = "") {
  let scope = credentialScopes.get(credential);
  if (!scope) { scope = crypto.randomUUID(); credentialScopes.set(credential, scope); }
  return JSON.stringify([runtimeUrl.replace(/\/+$/, ""), workspaceId, scope]);
}

// UI effects singleflight; stable transport intents and server ledger handle
// retries after this promise settles, including client timeout/disconnect.
export const manualSessionCreation = createManualSessionCreationRegistry();
