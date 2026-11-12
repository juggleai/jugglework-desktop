import type { CloudImportedProvider } from "@/app/cloud/import-state";
import {
  classifyProviderError,
  extractProviderErrorSignals,
} from "@/react-app/domains/session/sync/provider-error-classify";

export type GatewayCredentialRepairRequest = {
  workspaceId: string;
  sessionId: string;
  providerId: string | null;
};

type GatewayCredentialRepairListener = (
  request: GatewayCredentialRepairRequest,
) => void;

const gatewayCredentialRepairListeners = new Set<GatewayCredentialRepairListener>();

/**
 * Convert only the gateway's own rejected credential into a repair request.
 * A provider's normal 401 must keep its existing user-facing auth flow.
 */
export function gatewayCredentialRepairRequestFromError(input: {
  workspaceId: string;
  sessionId: string;
  error: unknown;
}): GatewayCredentialRepairRequest | null {
  if (classifyProviderError(input.error) !== "gateway_credential_invalid") {
    return null;
  }
  const providerId = extractProviderErrorSignals(input.error).provider?.trim() || null;
  return {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    providerId,
  };
}

/** Renderer-local handoff from the session event stream to the provider store. */
export function requestGatewayCredentialRepair(
  request: GatewayCredentialRepairRequest,
): void {
  for (const listener of gatewayCredentialRepairListeners) {
    try {
      listener(request);
    } catch (error) {
      console.warn("[gateway-credential-repair] listener failed", error);
    }
  }
}

export function subscribeGatewayCredentialRepair(
  listener: GatewayCredentialRepairListener,
): () => void {
  gatewayCredentialRepairListeners.add(listener);
  return () => {
    gatewayCredentialRepairListeners.delete(listener);
  };
}

/**
 * Resolve the cloud import that owns a rejected runtime provider id. When the
 * engine omitted the provider id, recovery is still unambiguous if this
 * workspace has exactly one imported organization provider.
 */
export function resolveGatewayCredentialRepairTarget(
  importedProviders: Record<string, CloudImportedProvider>,
  providerId: string | null,
): CloudImportedProvider | null {
  const imports = Object.values(importedProviders);
  const resolvedProviderId = providerId?.trim() ?? "";
  if (resolvedProviderId) {
    return imports.find((provider) =>
      provider.providerId === resolvedProviderId
      || provider.cloudProviderId === resolvedProviderId
    ) ?? null;
  }
  return imports.length === 1 ? imports[0]! : null;
}
