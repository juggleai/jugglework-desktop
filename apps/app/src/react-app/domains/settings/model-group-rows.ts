import type { CloudImportedProvider } from "@/app/cloud/import-state";
import type { OrgManagedProvider } from "./pages/ai-view";

export function buildModelGroupRows(input: {
  runtimeProviders: Array<{
    id: string;
    name: string;
    source?: "env" | "api" | "config" | "custom";
    connected: boolean;
  }>;
  connectedProviderIds: readonly string[];
  cloudOrgProviders: Array<{ id: string; providerId: string; name: string; models: unknown[] }>;
  importedCloudProviders: Record<string, CloudImportedProvider>;
  providerAuthError: string | null;
}) {
  const normalize = (value: string) => value.trim().toLowerCase();
  const connectedIds = new Set(input.connectedProviderIds.map(normalize));
  const cloudRuntimeIds = new Set(input.cloudOrgProviders.map((provider) => normalize(provider.id)));
  const liveCloudIds = new Set(input.cloudOrgProviders.map((provider) => provider.id.trim()));
  const currentImportedByCloudId = new Map(
    Object.values(input.importedCloudProviders)
      .filter((imported) => liveCloudIds.has(imported.cloudProviderId.trim()))
      .map((imported) => [imported.cloudProviderId.trim(), imported]),
  );
  const importedLocalIds = new Set(
    Array.from(currentImportedByCloudId.values(), (imported) => normalize(imported.providerId)),
  );

  const orgManagedProviders: OrgManagedProvider[] = input.cloudOrgProviders.map((provider) => {
    const imported = currentImportedByCloudId.get(provider.id.trim());
    const connected = Boolean(imported && connectedIds.has(normalize(imported.providerId)));
    return {
      id: provider.id,
      sourceProviderId: provider.providerId,
      name: provider.name,
      connected,
      syncState: connected ? "ready" : input.providerAuthError ? "failed" : "pending",
      modelCount: provider.models.length,
    };
  });

  return {
    localProviders: input.runtimeProviders.filter((provider) => {
      const id = normalize(provider.id);
      return !cloudRuntimeIds.has(id) && !importedLocalIds.has(id);
    }),
    orgManagedProviders,
  };
}
