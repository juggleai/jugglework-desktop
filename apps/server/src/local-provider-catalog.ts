import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isManagedProvider } from "@jugglework/types/provider-credentials";
import { readJsoncFile } from "./jsonc.js";
import { resolveGlobalOpenCodeConfigPath } from "./mcp.js";
import { inspectRuntimeOpencodeConfigState } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type ProviderCatalog = {
  all: readonly { id: string; source?: string }[];
  connected: string[];
  default: Record<string, string>;
};

function providerDefinitions(config: unknown): Record<string, unknown> {
  const value = (config as { provider?: unknown } | null)?.provider;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function configPaths(directory: string): string[] {
  const files = new Set<string>();
  const add = (root: string) => {
    for (const name of ["opencode.json", "opencode.jsonc"]) files.add(join(root, name));
  };
  const global = dirname(resolveGlobalOpenCodeConfigPath({ opencodeConfigDir: "" }));
  add(global);
  files.add(join(global, "config.json"));
  add(dirname(resolveGlobalOpenCodeConfigPath()));
  add(join(homedir(), ".opencode"));
  for (let root = resolve(directory); ; root = dirname(root)) {
    add(root);
    add(join(root, ".opencode"));
    if (root === dirname(root)) break;
  }
  return [...files];
}

/**
 * OpenCode's global config cache can outlive /global/dispose. Only drop a
 * provider when it still exists in that cache and its persisted definition
 * is gone. Other discovery sources and workspace overrides keep working.
 */
export async function filterRemovedGlobalProviders<T extends ProviderCatalog>(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  directory: string,
  catalog: T,
  readEngineGlobalConfig: () => Promise<unknown>,
): Promise<T> {
  if (!isAbsolute(directory)) return catalog;
  const connected = new Set(catalog.connected);
  const candidates = catalog.all.filter((provider) =>
    provider.source === "config" && connected.has(provider.id) && !isManagedProvider(provider.id, provider));
  if (!candidates.length) return catalog;

  try {
    const read = (path: string) => readJsoncFile<Record<string, unknown>>(path, {}, {
      regularFileOnly: true,
      maxBytes: 1024 * 1024,
    });
    const [files, runtime] = await Promise.all([
      Promise.all(configPaths(directory).map(read)),
      inspectRuntimeOpencodeConfigState(config, workspace.id),
    ]);
    if (runtime.status === "unreadable" || runtime.status === "invalid-row") return catalog;
    const currentIds = new Set([runtime.config, ...files.map((file) => file.data)]
      .flatMap((value) => Object.keys(providerDefinitions(value))));
    const missing = candidates.filter(({ id }) => !currentIds.has(id));
    if (!missing.length) return catalog;

    const cached = providerDefinitions(await readEngineGlobalConfig());
    const removed = new Set(missing.filter(({ id }) => Object.hasOwn(cached, id)).map(({ id }) => id));
    if (!removed.size) return catalog;
    return {
      ...catalog,
      all: catalog.all.filter(({ id }) => !removed.has(id)),
      connected: catalog.connected.filter((id) => !removed.has(id)),
      default: Object.fromEntries(Object.entries(catalog.default ?? {}).filter(([id]) => !removed.has(id))),
    };
  } catch {
    // A failed config read cannot establish that the entry was removed.
    return catalog;
  }
}
