import { useSyncExternalStore } from "react";
import { createJuggleWorkServerClient } from "./jugglework-server";
import { resolveJuggleWorkConnection } from "../../react-app/shell/jugglework-connection";
import { createDenClient, readDenSettings, readDenUserId } from "./den";
import { isDesktopRuntime } from "./runtime-env";
import { desktopBridge } from "./desktop";

// A renderer cache epoch is only a UI fence. The host token and the host's
// compare-and-set revision protect the actual authority and dispatch decisions.
let epoch = 0;
let switching = 0;
let switchTail: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const settledListeners = new Set<() => void>();
const catalogListeners = new Set<() => void>();
let catalogRevision = 0;
function subscribeManagedProviderCatalog(listener: () => void) {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}
export function useManagedProviderCatalogRevision() {
  return useSyncExternalStore(subscribeManagedProviderCatalog, managedProviderCatalogRevision, () => 0);
}
export const managedProviderCatalogRevision = () => catalogRevision;
export function subscribeManagedProviderSwitchSettled(listener: () => void) {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}
export function subscribeManagedProviderScope(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function invalidateManagedProviderScope() {
  epoch += 1;
  for (const listener of listeners) listener();
}
export const managedProviderEpoch = () => epoch;
export const managedProviderSwitchPending = () => switching > 0;
export function useManagedProviderEpoch() {
  return useSyncExternalStore(subscribeManagedProviderScope, managedProviderEpoch, () => 0);
}

export async function managedProviderHost() {
  const connection = await resolveJuggleWorkConnection();
  if (isDesktopRuntime() && connection.source !== "desktop-runtime") return null;
  if (!connection.normalizedBaseUrl || !connection.resolvedHostToken) return null;
  return createJuggleWorkServerClient({ baseUrl: connection.normalizedBaseUrl, hostToken: connection.resolvedHostToken });
}

export async function fenceManagedProviderHost() {
  invalidateManagedProviderScope();
  const host = await managedProviderHost();
  if (!host && isDesktopRuntime()) throw new Error("Local model authority is unavailable.");
  await host?.fenceManagedProviderAuthority();
  notifyFileWindowProviderCatalogChanged();
}

export function notifyFileWindowProviderCatalogChanged() {
  if (isDesktopRuntime()) void desktopBridge.invalidateFileWindowProviderCatalog().catch(() => undefined);
}

export function notifyManagedProviderCatalogChanged() {
  catalogRevision += 1;
  for (const listener of catalogListeners) listener();
  notifyFileWindowProviderCatalogChanged();
}

/** Wrap the actual Den mutation so Settings, onboarding and background bootstrap all share the fence. */
export async function duringManagedProviderSwitch<T>(work: () => Promise<T>): Promise<T> {
  switching += 1;
  invalidateManagedProviderScope();
  const run = switchTail.then(async () => {
    await fenceManagedProviderHost();
    return work();
  });
  switchTail = run.catch(() => undefined);
  try {
    return await run;
  } finally {
    switching -= 1;
    invalidateManagedProviderScope();
    if (!switching) queueMicrotask(() => {
      if (!switching) for (const listener of settledListeners) listener();
    });
  }
}

/** Storage can also change through sign-in, sign-out or deployment bootstrap. */
export function managedProviderIdentityChanged() {
  void duringManagedProviderSwitch(async () => undefined).catch(() => undefined);
}

export function managedProviderConfirmationCurrent(capturedEpoch: number) {
  return switching === 0 && capturedEpoch === epoch;
}

/** Confirm the active organization of this bearer session, without an organization override. */
export async function confirmManagedProviderScope(host: ReturnType<typeof createJuggleWorkServerClient>, revision?: string) {
  const captured = managedProviderEpoch();
  const settings = readDenSettings();
  const token = settings.authToken?.trim();
  const organizationId = settings.activeOrgId?.trim();
  const userId = readDenUserId()?.trim();
  if (!token || !organizationId || !userId || !managedProviderConfirmationCurrent(captured)) throw new Error("Managed model identity is unavailable.");
  const den = createDenClient({ baseUrl: settings.baseUrl, token });
  revision ??= (await host.managedProviderRevision()).revision;
  const [user, orgs, hash] = await Promise.all([den.getSession(), den.listOrgs(), crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))]);
  const live = readDenSettings();
  if (!managedProviderConfirmationCurrent(captured) || live.baseUrl !== settings.baseUrl || live.authToken !== token ||
    live.activeOrgId !== organizationId || readDenUserId()?.trim() !== userId || user.id !== userId ||
    orgs.activeOrgId !== organizationId || !orgs.orgs.some((org) => org.id === organizationId)) {
    throw new Error("Managed model identity changed during confirmation.");
  }
  const session = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return (await host.confirmManagedProviderAuthority({ revision, deployment: den.baseUrls.apiBaseUrl, organizationId, userId, session })).id;
}
