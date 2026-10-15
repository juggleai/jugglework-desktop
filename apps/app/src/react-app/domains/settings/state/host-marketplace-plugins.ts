import {
  hostMarketplacePackageFromDenResolved,
  JuggleWorkServerError,
  type JuggleWorkHostMarketplaceEnvironment,
  type JuggleWorkHostMarketplaceIdentityScope,
  type JuggleWorkHostMarketplaceInstallation,
  type JuggleWorkHostMarketplaceMigrationPlan,
  type JuggleWorkHostMarketplaceMutationResult,
  type JuggleWorkHostMarketplacePackage,
  type JuggleWorkHostMarketplaceRegistryList,
  type JuggleWorkServerCapabilities,
  type createJuggleWorkServerClient,
} from "@/app/lib/jugglework-server";
import type { DenOrgPluginResolved } from "@/app/lib/den-types";
import type { WorkspaceKind, WorkspaceRemoteKind } from "@jugglework/types/workspace";

export type HostMarketplaceClient = Pick<ReturnType<typeof createJuggleWorkServerClient>,
  | "baseUrl"
  | "capabilities"
  | "getHostMarketplaceEnvironment"
  | "setHostMarketplaceScope"
  | "listHostMarketplacePlugins"
  | "putHostMarketplacePlugin"
  | "planHostMarketplacePluginMigration"
  | "migrateHostMarketplacePluginWorkspaceCopies"
  | "deleteHostMarketplacePlugin"
>;

export function supportsHostMarketplaceWorkspace(
  workspace: { workspaceType: WorkspaceKind; remoteType?: WorkspaceRemoteKind | null } | null | undefined,
): boolean {
  return Boolean(
    workspace
    && (workspace.workspaceType !== "remote" || workspace.remoteType === "jugglework"),
  );
}

export type HostMarketplacePluginsOperation = "load_scope" | "ensure_scope" | "refresh" | "put" | "migrate" | "delete" | "clear";

export type HostMarketplaceMigrationRequest = {
  scope: JuggleWorkHostMarketplaceIdentityScope;
  package: JuggleWorkHostMarketplacePackage;
  plan: JuggleWorkHostMarketplaceMigrationPlan;
};

export class HostMarketplaceMigrationRequiredError extends Error {
  constructor(readonly request: HostMarketplaceMigrationRequest) {
    super("Workspace copies require explicit confirmation before this plugin can become global.");
    this.name = "HostMarketplaceMigrationRequiredError";
  }
}

export type HostMarketplacePluginsSnapshot = {
  key: string | null;
  scope: JuggleWorkHostMarketplaceIdentityScope | null;
  environment: JuggleWorkHostMarketplaceEnvironment | null;
  registry: JuggleWorkHostMarketplaceRegistryList | null;
  writable: boolean;
  status: "idle" | "loading" | "ready" | "error";
  operation: HostMarketplacePluginsOperation | null;
  error: Error | null;
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeHostMarketplaceIdentityScope(
  scope: JuggleWorkHostMarketplaceIdentityScope,
): JuggleWorkHostMarketplaceIdentityScope {
  const origin = new URL(scope.controlPlaneOrigin);
  if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.username || origin.password) {
    throw new Error("Host Marketplace controlPlaneOrigin must be an HTTP(S) origin without credentials.");
  }
  const normalized = {
    controlPlaneOrigin: origin.origin,
    userId: scope.userId.trim(),
    organizationId: scope.organizationId.trim(),
  };
  if (!normalized.userId || !normalized.organizationId) {
    throw new Error("Host Marketplace scope requires a Den user and organization.");
  }
  return normalized;
}

/** The host registry is identity-scoped and intentionally never includes a workspace id. */
export function hostMarketplacePluginsKey(
  hostBaseUrl: string,
  scope: JuggleWorkHostMarketplaceIdentityScope,
): string {
  const normalized = normalizeHostMarketplaceIdentityScope(scope);
  return [
    normalizeBaseUrl(hostBaseUrl),
    normalized.controlPlaneOrigin,
    normalized.userId,
    normalized.organizationId,
  ].join("\0");
}

function operationId(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Host Marketplace mutations require crypto.randomUUID().");
  }
  return globalThis.crypto.randomUUID();
}

function assertReadCapability(
  capabilities: JuggleWorkServerCapabilities,
  environment: JuggleWorkHostMarketplaceEnvironment,
): void {
  if (capabilities.hostMarketplacePlugins?.read === false || !environment.capability.read) {
    throw new Error("This JuggleWork host does not support reading host Marketplace plugins.");
  }
}

function canWrite(
  capabilities: JuggleWorkServerCapabilities,
  environment: JuggleWorkHostMarketplaceEnvironment,
): boolean {
  return capabilities.hostMarketplacePlugins?.write === true && environment.capability.write;
}

function assertWriteCapability(
  capabilities: JuggleWorkServerCapabilities,
  environment: JuggleWorkHostMarketplaceEnvironment,
): void {
  if (capabilities.hostMarketplacePlugins?.write !== true || !environment.capability.write) {
    throw new Error("This JuggleWork host does not support changing host Marketplace plugins.");
  }
}

function optimisticRegistry(
  registry: JuggleWorkHostMarketplaceRegistryList,
  result: JuggleWorkHostMarketplaceMutationResult,
  pluginId?: string,
): JuggleWorkHostMarketplaceRegistryList {
  let installations = registry.installations;
  if (result.installation) {
    installations = [
      ...installations.filter((installation) => installation.pluginId !== result.installation!.pluginId),
      result.installation,
    ].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  } else if ((result.operation === "remove" || result.operation === "cloud_only") && pluginId) {
    installations = installations.filter((installation) => installation.pluginId !== pluginId);
  }
  return {
    ...registry,
    registryRevision: result.registryRevision,
    active: result.activeScope !== null,
    installations,
  };
}

/**
 * Observable state for one host and the currently requested Den identity scope.
 * Calls are serialized and fenced so superseded identity requests cannot publish
 * state, and a newer request runs as soon as any in-flight mutation completes.
 */
export class HostMarketplacePluginsController {
  private snapshot: HostMarketplacePluginsSnapshot = {
    key: null,
    scope: null,
    environment: null,
    registry: null,
    writable: false,
    status: "idle",
    operation: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private activeScope: { key: string; scope: JuggleWorkHostMarketplaceIdentityScope } | null = null;

  constructor(private readonly client: HostMarketplaceClient) {}

  getSnapshot = (): HostMarketplacePluginsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: HostMarketplacePluginsSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private isCurrent(generation: number, key: string): boolean {
    return this.generation === generation && this.snapshot.key === key;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private begin(scope: JuggleWorkHostMarketplaceIdentityScope, operation: HostMarketplacePluginsOperation) {
    const normalized = normalizeHostMarketplaceIdentityScope(scope);
    const key = hostMarketplacePluginsKey(this.client.baseUrl, normalized);
    const generation = ++this.generation;
    const sameScope = this.snapshot.key === key;
    this.publish({
      key,
      scope: normalized,
      environment: sameScope ? this.snapshot.environment : null,
      registry: sameScope ? this.snapshot.registry : null,
      writable: sameScope ? this.snapshot.writable : false,
      status: "loading",
      operation,
      error: null,
    });
    return { normalized, key, generation };
  }

  private fail(generation: number, key: string, error: unknown): void {
    if (!this.isCurrent(generation, key)) return;
    this.publish({
      ...this.snapshot,
      status: "error",
      operation: null,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  private observeRegistry(
    scope: JuggleWorkHostMarketplaceIdentityScope,
    registry: JuggleWorkHostMarketplaceRegistryList,
  ): void {
    const key = hostMarketplacePluginsKey(this.client.baseUrl, scope);
    if (registry.active) {
      this.activeScope = { key, scope };
    } else if (this.activeScope?.key === key) {
      this.activeScope = null;
    }
  }

  private observeMutation(result: JuggleWorkHostMarketplaceMutationResult): void {
    const active = result.activeScope;
    this.activeScope = active
      ? {
          key: hostMarketplacePluginsKey(this.client.baseUrl, active),
          scope: {
            controlPlaneOrigin: active.controlPlaneOrigin,
            userId: active.userId,
            organizationId: active.organizationId,
          },
        }
      : null;
  }

  private publishContext(
    generation: number,
    key: string,
    environment: JuggleWorkHostMarketplaceEnvironment,
    registry: JuggleWorkHostMarketplaceRegistryList,
    writable: boolean,
  ): void {
    if (!this.isCurrent(generation, key)) return;
    this.publish({ ...this.snapshot, environment, registry, writable });
  }

  private async readContext(
    scope: JuggleWorkHostMarketplaceIdentityScope,
    request?: { generation: number; key: string },
  ) {
    const [capabilities, environment] = await Promise.all([
      this.client.capabilities(),
      this.client.getHostMarketplaceEnvironment(),
    ]);
    if (request && !this.isCurrent(request.generation, request.key)) return null;
    assertReadCapability(capabilities, environment);
    const registry = await this.client.listHostMarketplacePlugins(scope);
    if (registry.scope.environmentId !== environment.environmentId) {
      throw new Error("Host Marketplace environment changed while reading the registry.");
    }
    this.observeRegistry(scope, registry);
    return { capabilities, environment, registry };
  }

  private async listForEnvironment(
    scope: JuggleWorkHostMarketplaceIdentityScope,
    environment: JuggleWorkHostMarketplaceEnvironment,
  ): Promise<JuggleWorkHostMarketplaceRegistryList> {
    const registry = await this.client.listHostMarketplacePlugins(scope);
    if (registry.scope.environmentId !== environment.environmentId) {
      throw new Error("Host Marketplace environment changed while reading the registry.");
    }
    this.observeRegistry(scope, registry);
    return registry;
  }

  /** Read the host projection without activating or otherwise mutating its identity scope. */
  async loadScope(scope: JuggleWorkHostMarketplaceIdentityScope): Promise<HostMarketplacePluginsSnapshot> {
    const request = this.begin(scope, "load_scope");
    return this.enqueue(async () => {
      if (!this.isCurrent(request.generation, request.key)) return this.snapshot;
      try {
        const context = await this.readContext(request.normalized, request);
        if (!context) return this.snapshot;
        if (this.isCurrent(request.generation, request.key)) {
          this.publish({
            ...this.snapshot,
            environment: context.environment,
            registry: context.registry,
            writable: canWrite(context.capabilities, context.environment),
            status: "ready",
            operation: null,
            error: null,
          });
        }
      } catch (error) {
        this.fail(request.generation, request.key, error);
        throw error;
      }
      return this.snapshot;
    });
  }

  async ensureScope(scope: JuggleWorkHostMarketplaceIdentityScope): Promise<HostMarketplacePluginsSnapshot> {
    const request = this.begin(scope, "ensure_scope");
    return this.enqueue(async () => {
      if (!this.isCurrent(request.generation, request.key)) return this.snapshot;
      try {
        const context = await this.readContext(request.normalized, request);
        if (!context) return this.snapshot;
        if (!this.isCurrent(request.generation, request.key)) return this.snapshot;
        this.publishContext(request.generation, request.key, context.environment, context.registry, canWrite(context.capabilities, context.environment));

        let registry = context.registry;
        if (!context.registry.active && canWrite(context.capabilities, context.environment)) {
          if (!this.isCurrent(request.generation, request.key)) return this.snapshot;
          const result = await this.client.setHostMarketplaceScope({
            scope: request.normalized,
            active: true,
            expectedRevision: context.registry.registryRevision,
            idempotencyKey: operationId(),
          });
          this.observeMutation(result);
          if (!this.isCurrent(request.generation, request.key)) return this.snapshot;
          this.publish({
            ...this.snapshot,
            environment: context.environment,
            registry: optimisticRegistry(context.registry, result),
            writable: canWrite(context.capabilities, context.environment),
          });
          registry = await this.listForEnvironment(request.normalized, context.environment);
        }
        if (this.isCurrent(request.generation, request.key)) {
          this.publish({
            ...this.snapshot,
            environment: context.environment,
            registry,
            writable: canWrite(context.capabilities, context.environment),
            status: "ready",
            operation: null,
            error: null,
          });
        }
      } catch (error) {
        this.fail(request.generation, request.key, error);
        throw error;
      }
      return this.snapshot;
    });
  }

  async refresh(): Promise<HostMarketplacePluginsSnapshot> {
    if (!this.snapshot.scope) throw new Error("Call ensureScope() before refreshing host Marketplace plugins.");
    const request = this.begin(this.snapshot.scope, "refresh");
    return this.enqueue(async () => {
      if (!this.isCurrent(request.generation, request.key)) return this.snapshot;
      try {
        const context = await this.readContext(request.normalized, request);
        if (!context) return this.snapshot;
        if (this.isCurrent(request.generation, request.key)) {
          this.publish({
            ...this.snapshot,
            environment: context.environment,
            registry: context.registry,
            writable: canWrite(context.capabilities, context.environment),
            status: "ready",
            operation: null,
            error: null,
          });
        }
      } catch (error) {
        this.fail(request.generation, request.key, error);
        throw error;
      }
      return this.snapshot;
    });
  }

  async put(
    marketplaceId: string,
    resolved: DenOrgPluginResolved,
    options: { confirmExecutable?: boolean } = {},
  ): Promise<JuggleWorkHostMarketplaceInstallation | null> {
    const initialPackage = hostMarketplacePackageFromDenResolved(marketplaceId, resolved);
    const packageInput: JuggleWorkHostMarketplacePackage = options.confirmExecutable
      ? { ...initialPackage, confirmedExecutableRevision: initialPackage.revision }
      : initialPackage;
    return this.mutatePackage(packageInput);
  }

  private async mutatePackage(packageInput: JuggleWorkHostMarketplacePackage) {
    const currentScope = this.snapshot.scope;
    if (!currentScope) throw new Error("Call ensureScope() before changing host Marketplace plugins.");
    const request = this.begin(currentScope, "put");
    return this.enqueue(async () => {
      if (!this.isCurrent(request.generation, request.key)) return null;
      try {
        const context = await this.readContext(request.normalized, request);
        if (!context) return null;
        if (!this.isCurrent(request.generation, request.key)) return null;
        this.publishContext(request.generation, request.key, context.environment, context.registry, canWrite(context.capabilities, context.environment));
        assertWriteCapability(context.capabilities, context.environment);
        if (!context.registry.active) throw new Error("The requested host Marketplace scope is not active.");
        let result: JuggleWorkHostMarketplaceMutationResult;
        try {
          result = await this.client.putHostMarketplacePlugin({
            scope: request.normalized,
            expectedRevision: context.registry.registryRevision,
            idempotencyKey: operationId(),
            package: packageInput,
          });
        } catch (error) {
          if (!(error instanceof JuggleWorkServerError) || error.code !== "host_marketplace_workspace_copy_conflict") throw error;
          const plan = await this.client.planHostMarketplacePluginMigration({
            scope: request.normalized,
            package: packageInput,
          });
          if (this.isCurrent(request.generation, request.key)) {
            this.publish({ ...this.snapshot, status: "ready", operation: null, error: null });
          }
          throw new HostMarketplaceMigrationRequiredError({ scope: request.normalized, package: packageInput, plan });
        }
        this.observeMutation(result);
        if (!this.isCurrent(request.generation, request.key)) return result.installation;
        this.publish({
          ...this.snapshot,
          environment: context.environment,
          registry: optimisticRegistry(context.registry, result, packageInput.pluginId),
          writable: canWrite(context.capabilities, context.environment),
        });
        const registry = await this.listForEnvironment(request.normalized, context.environment);
        if (this.isCurrent(request.generation, request.key)) {
          this.publish({ ...this.snapshot, registry, status: "ready", operation: null, error: null });
        }
        return registry.installations.find((installation) => installation.pluginId === packageInput.pluginId) ?? null;
      } catch (error) {
        if (error instanceof HostMarketplaceMigrationRequiredError) throw error;
        this.fail(request.generation, request.key, error);
        throw error;
      }
    });
  }

  async migrate(requested: HostMarketplaceMigrationRequest): Promise<JuggleWorkHostMarketplaceInstallation | null> {
    const currentScope = this.snapshot.scope;
    if (!currentScope) throw new Error("Call ensureScope() before migrating host Marketplace plugins.");
    const currentKey = hostMarketplacePluginsKey(this.client.baseUrl, currentScope);
    const requestedKey = hostMarketplacePluginsKey(this.client.baseUrl, requested.scope);
    if (currentKey !== requestedKey) throw new Error("The host Marketplace identity changed after migration planning.");
    const request = this.begin(currentScope, "migrate");
    return this.enqueue(async () => {
      if (!this.isCurrent(request.generation, request.key)) return null;
      try {
        const capabilities = await this.client.capabilities();
        const environment = this.snapshot.environment ?? await this.client.getHostMarketplaceEnvironment();
        assertWriteCapability(capabilities, environment);
        const result = await this.client.migrateHostMarketplacePluginWorkspaceCopies({
          scope: request.normalized,
          package: requested.package,
          expectedRevision: requested.plan.registryRevision,
          idempotencyKey: operationId(),
          workspaceCopies: requested.plan.workspaces.map(({ workspaceId, recordDigest }) => ({ workspaceId, recordDigest })),
          confirmed: true,
          fingerprint: requested.plan.fingerprint,
          migrationToken: requested.plan.migrationToken,
        });
        this.observeMutation(result.host);
        const registry = await this.listForEnvironment(request.normalized, environment);
        if (this.isCurrent(request.generation, request.key)) {
          this.publish({
            ...this.snapshot,
            environment,
            registry,
            writable: canWrite(capabilities, environment),
            status: "ready",
            operation: null,
            error: null,
          });
        }
        return registry.installations.find((installation) => installation.pluginId === requested.package.pluginId) ?? null;
      } catch (error) {
        this.fail(request.generation, request.key, error);
        throw error;
      }
    });
  }

  async delete(pluginId: string): Promise<void> {
    const currentScope = this.snapshot.scope;
    if (!currentScope) throw new Error("Call ensureScope() before changing host Marketplace plugins.");
    const request = this.begin(currentScope, "delete");
    await this.enqueue(async () => {
      if (!this.isCurrent(request.generation, request.key)) return;
      try {
        const context = await this.readContext(request.normalized, request);
        if (!context) return;
        if (!this.isCurrent(request.generation, request.key)) return;
        this.publishContext(request.generation, request.key, context.environment, context.registry, canWrite(context.capabilities, context.environment));
        assertWriteCapability(context.capabilities, context.environment);
        if (!context.registry.active) throw new Error("The requested host Marketplace scope is not active.");
        const result = await this.client.deleteHostMarketplacePlugin(pluginId, {
          scope: request.normalized,
          expectedRevision: context.registry.registryRevision,
          idempotencyKey: operationId(),
        });
        this.observeMutation(result);
        if (!this.isCurrent(request.generation, request.key)) return;
        this.publish({
          ...this.snapshot,
          environment: context.environment,
          registry: optimisticRegistry(context.registry, result, pluginId),
          writable: canWrite(context.capabilities, context.environment),
        });
        const registry = await this.listForEnvironment(request.normalized, context.environment);
        if (this.isCurrent(request.generation, request.key)) {
          this.publish({ ...this.snapshot, registry, status: "ready", operation: null, error: null });
        }
      } catch (error) {
        this.fail(request.generation, request.key, error);
        throw error;
      }
    });
  }

  /** Fence in-flight reads and hide their state without contacting the host. */
  abandon(): void {
    ++this.generation;
    this.publish({
      key: null,
      scope: null,
      environment: null,
      registry: null,
      writable: false,
      status: "idle",
      operation: null,
      error: null,
    });
  }

  /** Clear identity-bound UI state immediately, then deactivate the exact known host scope if possible. */
  async clear(): Promise<void> {
    const fallbackActive = this.snapshot.registry?.active && this.snapshot.scope
      ? { key: this.snapshot.key!, scope: this.snapshot.scope }
      : null;
    const generation = ++this.generation;
    this.publish({
      key: null,
      scope: null,
      environment: null,
      registry: null,
      writable: false,
      status: "idle",
      operation: null,
      error: null,
    });
    await this.enqueue(async () => {
      if (this.generation !== generation) return;
      const active = this.activeScope ?? fallbackActive;
      if (!active) return;
      const context = await this.readContext(active.scope);
      if (!context) return;
      if (this.generation !== generation) return;
      if (context.registry.active && canWrite(context.capabilities, context.environment)) {
        const result = await this.client.setHostMarketplaceScope({
          scope: active.scope,
          active: false,
          expectedRevision: context.registry.registryRevision,
          idempotencyKey: operationId(),
        });
        this.observeMutation(result);
      }
    });
  }
}
