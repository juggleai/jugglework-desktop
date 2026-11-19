import {
  cloudGatewayCredentialEnvName,
  cloudGatewayMirrorEnvName,
  cloudGatewayMirrorOwnerId,
  cloudProviderConfigFingerprint,
  isCloudGatewayCredentialEnvName,
  isManagedProvider,
} from "@jugglework/types/provider-credentials";
import { createHash } from "node:crypto";
import type { EnvService } from "./env-file.js";
import { inspectJuggleWorkWorkspaceConfig, readJuggleWorkWorkspaceConfig } from "./jugglework-workspace-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { managedProviderAuthority, type ManagedProviderAuthority } from "./managed-provider-authority.js";
import { readEffectiveWorkspaceOpencodeConfig } from "./effective-workspace-opencode-config.js";
import { ApiError } from "./errors.js";

type CredentialStoreEntry = { key: string; value: string; owner?: string };
type ImportedProviderRecord = {
  cloudProviderId: string;
  providerId: string;
  modelIds: string[];
  metadataVersion: number | null;
  organizationId: string | null;
  authorityId?: string | null;
  providerConfigFingerprint: string | null;
  gatewayMirror: { workspaceId?: string; organizationId: string; cloudProviderId: string; key: string } | null;
};

const ORGANIZATION_OWNED_PROVIDER_METADATA_VERSION = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function importedProviders(value: unknown): ImportedProviderRecord[] {
  if (!isRecord(value)) return [];
  const cloudImports = isRecord(value.cloudImports) ? value.cloudImports : {};
  const providers = isRecord(cloudImports.providers) ? cloudImports.providers : {};
  return Object.entries(providers).flatMap(([key, raw]) => {
    if (!isRecord(raw)) return [];
    const cloudProviderId = typeof raw.cloudProviderId === "string" ? raw.cloudProviderId.trim() : key.trim();
    const providerId = typeof raw.providerId === "string" ? raw.providerId.trim() : "";
    const organizationId = typeof raw.organizationId === "string" ? raw.organizationId.trim() : "";
    const metadataVersion = typeof raw.metadataVersion === "number" ? raw.metadataVersion : 0;
    const modelIds = Array.isArray(raw.modelIds)
      ? raw.modelIds.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
    const fingerprint = typeof raw.providerConfigFingerprint === "string" ? raw.providerConfigFingerprint : null;
    const rawMirror = isRecord(raw.gatewayMirror) ? raw.gatewayMirror : null;
    const legacyWorkspaceId = typeof rawMirror?.workspaceId === "string" ? rawMirror.workspaceId.trim() : "";
    const gatewayMirror = rawMirror && typeof rawMirror.organizationId === "string" &&
      typeof rawMirror.cloudProviderId === "string" && typeof rawMirror.key === "string"
      ? {
        ...(legacyWorkspaceId ? { workspaceId: legacyWorkspaceId } : {}),
        organizationId: rawMirror.organizationId,
        cloudProviderId: rawMirror.cloudProviderId,
        key: rawMirror.key,
      }
      : null;
    return cloudProviderId && providerId && organizationId
      ? [{ cloudProviderId, providerId, organizationId, metadataVersion, modelIds, providerConfigFingerprint: fingerprint, gatewayMirror,
          authorityId: typeof raw.authorityId === "string" ? raw.authorityId : null }]
      : [];
  });
}

function matchingImport(input: {
  imports: ImportedProviderRecord[];
  providerID: string;
  modelID?: string;
  declaredEnvKey?: string;
  workspaceId: string;
  providerConfig?: unknown;
  authority?: ManagedProviderAuthority | null;
}): ImportedProviderRecord | null {
  return input.imports.find((entry) =>
    (input.authority === undefined || (entry.authorityId === input.authority?.id && entry.organizationId === input.authority?.organizationId)) &&
    Boolean(entry.organizationId?.trim()) &&
    (entry.metadataVersion ?? 0) >= ORGANIZATION_OWNED_PROVIDER_METADATA_VERSION &&
    entry.providerId === input.providerID &&
    (!input.modelID || entry.modelIds.includes(input.modelID)) &&
    (!input.declaredEnvKey || cloudGatewayCredentialEnvName(entry.cloudProviderId) === input.declaredEnvKey) &&
    (!input.providerConfig || entry.providerConfigFingerprint === cloudProviderConfigFingerprint(input.providerConfig)) &&
    Boolean(mirrorOwner(entry, input.workspaceId))
  ) ?? null;
}

/**
 * The owner this import's mirror must carry: the shared organization record,
 * or a legacy record scoped to exactly this workspace. Anything else is
 * treated as unowned.
 */
function mirrorOwner(entry: ImportedProviderRecord, workspaceId: string) {
  const mirror = entry.gatewayMirror;
  if (!mirror || !entry.organizationId) return null;
  if (mirror.organizationId !== entry.organizationId || mirror.cloudProviderId !== entry.cloudProviderId) return null;
  const owner = mirror.workspaceId
    ? (mirror.workspaceId === workspaceId ? { workspaceId, organizationId: entry.organizationId, cloudProviderId: entry.cloudProviderId } : null)
    : { organizationId: entry.organizationId, cloudProviderId: entry.cloudProviderId };
  return owner && mirror.key === cloudGatewayMirrorEnvName(owner) ? owner : null;
}

export function resolveProviderCredentialFromSnapshot(input: {
  declaredEnvKeys: readonly string[];
  entries: readonly CredentialStoreEntry[];
  imports: ImportedProviderRecord[];
  workspaceId: string;
  providerID: string;
  modelID?: string;
  providerConfig?: unknown;
  processEnv?: NodeJS.ProcessEnv;
  authority?: ManagedProviderAuthority | null;
}): string | null {
  const managed = isManagedProvider(input.providerID, input.providerConfig, input.declaredEnvKeys) || input.imports.some((entry) => entry.providerId === input.providerID);
  if (managed && input.authority === null) return null;
  for (const rawKey of input.declaredEnvKeys) {
    const key = rawKey.trim();
    if (!key) continue;
    if (isCloudGatewayCredentialEnvName(key)) {
      const owned = matchingImport({
        imports: input.imports,
        workspaceId: input.workspaceId,
        providerID: input.providerID,
        ...(input.modelID ? { modelID: input.modelID } : {}),
        declaredEnvKey: key,
        providerConfig: input.providerConfig,
        authority: input.authority,
      });
      const owner = owned ? mirrorOwner(owned, input.workspaceId) : null;
      if (!owned || !owner) continue;
      const mirror = input.entries.find((entry) => entry.key === owned.gatewayMirror?.key);
      if (!mirror || mirror.owner !== cloudGatewayMirrorOwnerId(owner)) continue;
      const value = mirror.value.trim();
      if (value) return value;
      continue;
    }
    if (managed || /^(?:JUGGLEWORK|MCP)_GATEWAY_KEY(?:_|$)/i.test(key)) continue;
    if (key.startsWith("OPENCODE_")) continue;
    if (key.startsWith("JUGGLEWORK_") && key !== "JUGGLEWORK_API_KEY") continue;
    const value = input.entries.find((entry) => entry.key === key)?.value.trim() || input.processEnv?.[key]?.trim();
    if (value) return value;
  }
  return null;
}

export function createWorkspaceProviderCredentialResolver(options: {
  config: ServerConfig;
  env: EnvService;
  readOnly?: boolean;
  /** Only the worker for already persisted submissions may use the old binding. */
  reconcileSubmittedVideo?: boolean;
}) {
  const authority = managedProviderAuthority(options.config);
  const active = (workspaceId: string) => authority.forWorkspace(workspaceId);
  const snapshot = async (workspaceId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const entries = await options.env.list();
    signal?.throwIfAborted();
    const imports = importedProviders(await (options.readOnly ? inspectJuggleWorkWorkspaceConfig : readJuggleWorkWorkspaceConfig)(options.config, workspaceId));
    signal?.throwIfAborted();
    return { entries, imports };
  };
  return {
    capture(workspaceId: string) {
      const scope = active(workspaceId);
      return () => Boolean(scope && scope === active(workspaceId));
    },
    beforeDispatch(workspaceId: string, providerID: string, providerConfig: unknown) {
      if (!isManagedProvider(providerID, providerConfig)) return undefined;
      const captured = active(workspaceId);
      return () => {
        if (!captured || captured !== active(workspaceId)) throw new ApiError(403, "managed_provider_scope_unavailable", "Managed model scope is unavailable.");
      };
    },
    /** Validate explicit engine submissions without restricting non-managed providers. */
    async prepareTextSubmission(workspace: WorkspaceInfo, model: { providerID: string; modelID: string }) {
      const captured = active(workspace.id);
      const deny = () => { throw new ApiError(403, "managed_provider_scope_unavailable", "Managed model scope is unavailable."); };
      if (isManagedProvider(model.providerID) && !captured) deny();
      const effective = await readEffectiveWorkspaceOpencodeConfig(options.config, workspace, { readOnly: true });
      const provider = isRecord(effective.provider) ? effective.provider[model.providerID] : undefined;
      const imports = importedProviders(await inspectJuggleWorkWorkspaceConfig(options.config, workspace.id));
      if (!isManagedProvider(model.providerID, provider) && !imports.some((entry) => entry.providerId === model.providerID)) return undefined;

      const guard = () => { if (!captured || captured !== active(workspace.id)) deny(); };
      guard();
      if (!isRecord(provider) || !isRecord(provider.models) || !Object.hasOwn(provider.models, model.modelID) ||
        (Array.isArray(effective.disabled_providers) && effective.disabled_providers.includes(model.providerID))) deny();
      const declaredEnvKeys = isRecord(provider) && Array.isArray(provider.env)
        ? provider.env.filter((key): key is string => typeof key === "string") : [];
      const entries = await options.env.list();
      if (!resolveProviderCredentialFromSnapshot({ ...model, workspaceId: workspace.id, providerConfig: provider,
        declaredEnvKeys, imports, entries, authority: captured })) deny();
      guard();
      return guard;
    },
    async filterCatalog<T extends { all: readonly { id: string; models?: Record<string, unknown> }[]; connected: string[]; default: Record<string, string> }>(workspaceId: string, catalog: T, scopeCurrent?: () => boolean): Promise<T> {
      const captured = active(workspaceId);
      let imports: ImportedProviderRecord[] = [];
      let entries: readonly CredentialStoreEntry[] = [];
      try {
        imports = importedProviders(await inspectJuggleWorkWorkspaceConfig(options.config, workspaceId));
        if (captured) entries = await options.env.list();
      } catch { /* Unknown managed entries are hidden below. */ }
      const current = captured && captured === active(workspaceId) && (scopeCurrent?.() ?? true) ? captured : null;
      const all = catalog.all.flatMap((provider) => {
        if (!isManagedProvider(provider.id, provider) && !imports.some((entry) => entry.providerId === provider.id)) return [provider];
        const entry = matchingImport({ imports, workspaceId, providerID: provider.id, authority: current });
        if (!entry || !catalog.connected.includes(provider.id)) return [];
        const credential = resolveProviderCredentialFromSnapshot({ imports, entries, workspaceId, providerID: provider.id,
          declaredEnvKeys: [cloudGatewayCredentialEnvName(entry.cloudProviderId)], authority: current });
        if (!credential) return [];
        const models = Object.fromEntries(Object.entries(provider.models ?? {}).filter(([id]) => entry.modelIds.includes(id)));
        return Object.keys(models).length ? [{ ...provider, models }] : [];
      });
      const visible = new Map(all.map((provider) => [provider.id, provider]));
      return { ...catalog, all, connected: catalog.connected.filter((id) => visible.has(id)),
        default: Object.fromEntries(Object.entries(catalog.default ?? {}).filter(([id, model]) => {
          const provider = visible.get(id);
          return provider && (!isManagedProvider(id, provider) && !imports.some((entry) => entry.providerId === id)
            || Object.hasOwn(provider.models ?? {}, model));
        })) };
    },
    async resolve(input: { workspaceId: string; providerID: string; modelID?: string; declaredEnvKeys: readonly string[]; providerConfig?: unknown }, signal?: AbortSignal) {
      const captured = active(input.workspaceId);
      const current = await snapshot(input.workspaceId, signal);
      return resolveProviderCredentialFromSnapshot({ ...input, ...current, processEnv: process.env,
        authority: options.reconcileSubmittedVideo ? undefined : captured === active(input.workspaceId) ? captured : null });
    },
    async organizationProviderProvenance(input: { workspaceId: string; providerID: string; modelID: string; declaredEnvKeys: readonly string[]; providerConfig: unknown }) {
      const captured = active(input.workspaceId);
      const current = await snapshot(input.workspaceId);
      const reserved = input.declaredEnvKeys.filter(isCloudGatewayCredentialEnvName);
      if (reserved.length !== 1) return null;
      const owned = matchingImport({ ...input, imports: current.imports, declaredEnvKey: reserved[0],
        authority: options.reconcileSubmittedVideo ? undefined : captured === active(input.workspaceId) ? captured : null });
      return owned ? { cloudProviderId: owned.cloudProviderId, organizationId: owned.organizationId! } : null;
    },
    async canDispatch(workspace: WorkspaceInfo, input: { providerID?: string; url: string; digest: string }) {
      const captured = active(workspace.id);
      if (!captured) return false;
      try {
        const [current, effective] = await Promise.all([snapshot(workspace.id), readEffectiveWorkspaceOpencodeConfig(options.config, workspace, { readOnly: true })]);
        if (captured !== active(workspace.id)) return false;
        const url = new URL(input.url);
        return current.imports.some((entry) => {
          if (input.providerID && entry.providerId !== input.providerID) return false;
          const provider = isRecord(effective.provider) ? effective.provider[entry.providerId] : null;
          if (!isRecord(provider)) return false;
          const baseURL = isRecord(provider.options) ? provider.options.baseURL ?? provider.api : provider.api;
          if (typeof baseURL !== "string" || !URL.canParse(baseURL)) return false;
          const base = new URL(baseURL);
          if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/`)) return false;
          const value = resolveProviderCredentialFromSnapshot({ ...current, workspaceId: workspace.id, providerID: entry.providerId,
            providerConfig: provider, declaredEnvKeys: [cloudGatewayCredentialEnvName(entry.cloudProviderId)], authority: captured });
          return Boolean(value && createHash("sha256").update(value).digest("hex") === input.digest);
        });
      } catch { return false; }
    },
  };
}

export type WorkspaceProviderCredentialResolver = ReturnType<typeof createWorkspaceProviderCredentialResolver>;
