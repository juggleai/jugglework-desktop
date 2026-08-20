import { unwrap } from "@/app/lib/opencode";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import type { Client } from "@/app/types";

type WorkspaceType = "local" | "remote" | string;

export type UpdateManagedDisabledProvidersOptions = {
  opencodeClient: Client | null;
  juggleworkClient?: JuggleWorkServerClient | null;
  workspaceId?: string | null;
  workspaceType?: WorkspaceType | null;
  disabledProviders: unknown;
  currentConfig?: unknown;
  removeFallbackKeyWhenEmpty?: boolean;
  markReloadRequired?: () => void;
};

export type UpdateManagedDisabledProvidersResult = {
  managedRuntime: boolean;
  disabledProviders: string[];
  changed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDisabledProviders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const providers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const provider = entry.trim();
    if (provider && !providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function disabledProvidersFromConfig(config: unknown): string[] {
  return isRecord(config) ? normalizeDisabledProviders(config.disabled_providers) : [];
}

function configWithDisabledProviders(
  config: unknown,
  providers: string[],
  removeWhenEmpty: boolean,
): Record<string, unknown> {
  const next = { ...(isRecord(config) ? config : {}) };
  if (providers.length > 0 || !removeWhenEmpty) {
    next.disabled_providers = providers;
  } else {
    delete next.disabled_providers;
  }
  return next;
}

export async function updateManagedDisabledProviders(
  options: UpdateManagedDisabledProvidersOptions,
): Promise<UpdateManagedDisabledProvidersResult> {
  const disabledProviders = normalizeDisabledProviders(options.disabledProviders);
  const workspaceId = options.workspaceId?.trim() ?? "";

  if (options.juggleworkClient && workspaceId && options.workspaceType === "local") {
    const result = await options.juggleworkClient.setRuntimeDisabledProviders(workspaceId, disabledProviders);
    // Older embedded servers do not return `changed`; fail open across a
    // rolling desktop/server upgrade and suppress reload only on an explicit
    // semantic no-op from the new contract.
    const changed = result.changed !== false;
    if (changed) options.markReloadRequired?.();
    return { managedRuntime: true, disabledProviders: result.disabledProviders, changed };
  }

  const client = options.opencodeClient;
  if (!client) throw new Error("OpenCode client is not connected.");
  const currentConfig = options.currentConfig ?? unwrap(await client.config.get());
  // OpenCode persists every config.update call even when the effective value
  // is unchanged. Its config watcher then treats that mtime-only rewrite as a
  // real change and disposes the active instance, aborting running tools.
  // Keep the comparison at this single managed write choke point so periodic
  // policy reconciliation remains read-only when disabled_providers already
  // matches the desired state.
  if (sameStringList(disabledProvidersFromConfig(currentConfig), disabledProviders)) {
    return { managedRuntime: false, disabledProviders, changed: false };
  }
  await client.config.update({
    config: configWithDisabledProviders(
      currentConfig,
      disabledProviders,
      options.removeFallbackKeyWhenEmpty === true,
    ),
  });
  return { managedRuntime: false, disabledProviders, changed: true };
}
