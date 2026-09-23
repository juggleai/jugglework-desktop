import type { CliOptions } from "./args.js";
import type { JuggleWorkApiClient, WorkspaceInfo } from "./api.js";

export type ModelContext = { provider: string | null; model: string | null; reasoningEffort: string | null; source: "cli" | "workspace" | "runtime" };

export function parseModelContext(model: string | null, reasoningEffort: string | null, source: ModelContext["source"]): ModelContext {
  const slash = model?.indexOf("/") ?? -1;
  return {
    provider: slash > 0 ? model!.slice(0, slash) : null,
    model: slash > 0 ? model!.slice(slash + 1) : null,
    reasoningEffort,
    source,
  };
}

export function modelContextLabel(context: ModelContext): string {
  const model = context.provider && context.model ? `${context.provider}/${context.model}` : "runtime default model";
  return `${model} · ${context.reasoningEffort ?? "default"} reasoning`;
}

export async function resolveModelContext(api: Pick<JuggleWorkApiClient, "workspaceConfig" | "providerList">, workspace: WorkspaceInfo, options: Pick<CliOptions, "model" | "reasoningEffort">): Promise<ModelContext> {
  if (options.model) return parseModelContext(options.model, options.reasoningEffort, "cli");
  try {
    const config = await api.workspaceConfig(workspace.id);
    const model = typeof config.opencode?.model === "string" ? config.opencode.model.trim() : null;
    if (model && model.includes("/")) return parseModelContext(model, options.reasoningEffort, "workspace");
  } catch { /* Older Servers may not expose workspace config. */ }
  try {
    const providers = await api.providerList(workspace.id);
    const firstDefault = Object.entries(providers.default ?? {}).find(([provider]) => providers.connected?.includes(provider));
    if (firstDefault?.[1]) return parseModelContext(`${firstDefault[0]}/${firstDefault[1]}`, options.reasoningEffort, "runtime");
  } catch { /* The runtime may not expose a provider list. */ }
  return parseModelContext(null, options.reasoningEffort, "runtime");
}
