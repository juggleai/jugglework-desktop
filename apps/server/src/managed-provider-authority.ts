import { randomUUID } from "node:crypto";
import type { ServerConfig } from "./types.js";

export type ManagedProviderScope = { deployment: string; userId: string; organizationId: string; session: string };
export type ManagedProviderAuthority = ManagedProviderScope & { id: string };

// Host-only transitions; no identity is recovered from workspace files, a
// request header, or a previous server process.
export class ManagedProviderAuthorityStore {
  private revision = randomUUID();
  private active: ManagedProviderAuthority | null = null;
  private readonly workspaces = new Map<string, ManagedProviderAuthority>();

  snapshot() { return this.active; }
  fenceIfCurrent(revision: string) {
    return revision === this.revision ? this.fence() : null;
  }
  fence() {
    this.active = null;
    this.workspaces.clear();
    return this.revision = randomUUID();
  }
  confirm(revision: string, scope: ManagedProviderScope) {
    if (revision !== this.revision) return null;
    const current = this.active;
    if (current && current.deployment === scope.deployment && current.userId === scope.userId &&
      current.organizationId === scope.organizationId && current.session === scope.session) return current;
    this.revision = randomUUID();
    this.workspaces.clear();
    return this.active = { ...scope, id: this.revision };
  }
  currentRevision() { return this.revision; }
  setWorkspaceReady(id: string, workspaceId: string, ready: boolean) {
    if (this.active?.id !== id) return false;
    if (ready) {
      if (!this.workspaces.has(workspaceId)) this.workspaces.set(workspaceId, { ...this.active });
    }
    else this.workspaces.delete(workspaceId);
    return true;
  }
  forWorkspace(workspaceId: string) { return this.workspaces.get(workspaceId) ?? null; }
}

const stores = new WeakMap<ServerConfig, ManagedProviderAuthorityStore>();
export function managedProviderAuthority(config: ServerConfig) {
  let store = stores.get(config);
  if (!store) stores.set(config, store = new ManagedProviderAuthorityStore());
  return store;
}
