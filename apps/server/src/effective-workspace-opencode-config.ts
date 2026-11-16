import { readJsoncFile } from "./jsonc.js";
import { resolveGlobalOpenCodeConfigPath } from "./mcp.js";
import { inspectRuntimeOpencodeConfigState, mergeOpencodeConfigs, readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { opencodeConfigPath } from "./workspace-files.js";

export async function readEffectiveWorkspaceOpencodeConfig(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  options?: { readOnly?: boolean; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const [{ data: globalConfig }, { data: projectConfig }, runtime] = await Promise.all([
    readJsoncFile(resolveGlobalOpenCodeConfigPath(), {} as Record<string, unknown>, {
      allowInvalid: true,
      maxBytes: 1024 * 1024,
      regularFileOnly: true,
    }),
    readJsoncFile(opencodeConfigPath(workspace.path), {} as Record<string, unknown>, {
      allowInvalid: true,
      maxBytes: 1024 * 1024,
      regularFileOnly: true,
    }),
    options?.readOnly ? inspectRuntimeOpencodeConfigState(config, workspace.id, { signal: options.signal }).then(result => {
      if (["unreadable", "invalid-row"].includes(result.status)) throw new Error("runtime_config_unavailable");
      return result.config;
    }) : readRuntimeOpencodeConfig(config, workspace.id),
  ]);
  return mergeOpencodeConfigs(mergeOpencodeConfigs(globalConfig, projectConfig), runtime);
}
