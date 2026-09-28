import {
  cloudGatewayCredentialEnvName,
  cloudGatewayMirrorEnvName,
  cloudGatewayMirrorOwnerId,
  cloudProviderConfigFingerprint,
  isCloudGatewayCredentialEnvName,
} from "@jugglework/types/provider-credentials";
import type { EnvService } from "./env-file.js";
import { readJuggleWorkWorkspaceConfig } from "./jugglework-workspace-config-store.js";
import type { ServerConfig } from "./types.js";

type CredentialStoreEntry = { key: string; value: string; owner?: string };
type ImportedProviderRecord = {
  cloudProviderId: string;
  providerId: string;
  modelIds: string[];
  metadataVersion: number | null;
  organizationId: string | null;
  providerConfigFingerprint: string | null;
  gatewayMirror: { workspaceId: string; organizationId: string; cloudProviderId: string; key: string } | null;
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
    const gatewayMirror = rawMirror && typeof rawMirror.workspaceId === "string" && typeof rawMirror.organizationId === "string" &&
      typeof rawMirror.cloudProviderId === "string" && typeof rawMirror.key === "string"
      ? { workspaceId: rawMirror.workspaceId, organizationId: rawMirror.organizationId, cloudProviderId: rawMirror.cloudProviderId, key: rawMirror.key }
      : null;
    return cloudProviderId && providerId && organizationId
      ? [{ cloudProviderId, providerId, organizationId, metadataVersion, modelIds, providerConfigFingerprint: fingerprint, gatewayMirror }]
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
}): ImportedProviderRecord | null {
  return input.imports.find((entry) =>
    Boolean(entry.organizationId?.trim()) &&
    (entry.metadataVersion ?? 0) >= ORGANIZATION_OWNED_PROVIDER_METADATA_VERSION &&
    entry.providerId === input.providerID &&
    (!input.modelID || entry.modelIds.includes(input.modelID)) &&
    (!input.declaredEnvKey || cloudGatewayCredentialEnvName(entry.cloudProviderId) === input.declaredEnvKey) &&
    (!input.providerConfig || entry.providerConfigFingerprint === cloudProviderConfigFingerprint(input.providerConfig)) &&
    entry.gatewayMirror?.workspaceId === input.workspaceId &&
    entry.gatewayMirror.organizationId === entry.organizationId &&
    entry.gatewayMirror.cloudProviderId === entry.cloudProviderId &&
    entry.gatewayMirror.key === cloudGatewayMirrorEnvName({ workspaceId: input.workspaceId, organizationId: entry.organizationId!, cloudProviderId: entry.cloudProviderId })
  ) ?? null;
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
}): string | null {
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
      });
      if (!owned) continue;
      const mirror = input.entries.find((entry) => entry.key === owned.gatewayMirror?.key);
      if (mirror?.owner !== cloudGatewayMirrorOwnerId({ workspaceId: input.workspaceId, organizationId: owned.organizationId!, cloudProviderId: owned.cloudProviderId })) continue;
      const value = mirror.value.trim();
      if (value) return value;
      continue;
    }
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
}) {
  const snapshot = async (workspaceId: string) => ({
    entries: await options.env.list(),
    imports: importedProviders(await readJuggleWorkWorkspaceConfig(options.config, workspaceId)),
  });
  return {
    async resolve(input: { workspaceId: string; providerID: string; modelID?: string; declaredEnvKeys: readonly string[]; providerConfig?: unknown }) {
      const current = await snapshot(input.workspaceId);
      return resolveProviderCredentialFromSnapshot({ ...input, ...current, processEnv: process.env });
    },
    async organizationProviderProvenance(input: { workspaceId: string; providerID: string; modelID: string; declaredEnvKeys: readonly string[]; providerConfig: unknown }) {
      const current = await snapshot(input.workspaceId);
      const reserved = input.declaredEnvKeys.filter(isCloudGatewayCredentialEnvName);
      if (reserved.length !== 1) return null;
      const owned = matchingImport({ imports: current.imports, workspaceId: input.workspaceId, providerID: input.providerID, modelID: input.modelID, declaredEnvKey: reserved[0], providerConfig: input.providerConfig });
      return owned ? { cloudProviderId: owned.cloudProviderId, organizationId: owned.organizationId! } : null;
    },
  };
}

export type WorkspaceProviderCredentialResolver = ReturnType<typeof createWorkspaceProviderCredentialResolver>;
