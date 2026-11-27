import { createHash, randomUUID } from "node:crypto";
import type { ServerConfig } from "./types.js";

export type ManagedProviderScope = { deployment: string; userId: string; organizationId: string; session: string };
export type ManagedProviderAuthority = ManagedProviderScope & { id: string };

/**
 * 授权 ID 由身份四元组加「围栏代数」派生。
 * 进程重启后代数归零，同一身份得到同一个 ID，落盘的导入基线仍然匹配，
 * 不会每次启动都被判成「已变更」而整批重新导入、重载引擎。
 * 同一进程内每次围栏（切账号、切组织、登出、凭据被拒）代数加一，
 * 回到同一身份也会得到新 ID，晚到的旧结果无法借旧 ID 写入。
 */
export function managedProviderAuthorityId(scope: ManagedProviderScope, fenceGeneration: number) {
  const digest = createHash("sha256")
    .update(JSON.stringify([scope.deployment, scope.userId, scope.organizationId, scope.session, fenceGeneration]))
    .digest("hex");
  return `mpa_${digest.slice(0, 32)}`;
}

// Host-only transitions; no identity is recovered from workspace files, a
// request header, or a previous server process. The authority id is a pure
// function of the confirmed identity and this process's fence count, so it
// never grants access by itself.
export class ManagedProviderAuthorityStore {
  private revision = randomUUID();
  private active: ManagedProviderAuthority | null = null;
  private fenceGeneration = 0;
  private readonly workspaces = new Map<string, ManagedProviderAuthority>();

  snapshot() { return this.active; }
  fenceIfCurrent(revision: string) {
    return revision === this.revision ? this.fence() : null;
  }
  fence() {
    this.fenceGeneration += 1;
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
    return this.active = { ...scope, id: managedProviderAuthorityId(scope, this.fenceGeneration) };
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
