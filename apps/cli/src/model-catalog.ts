import type { JuggleWorkApiClient, RuntimeProviderList, WorkspaceInfo } from "./api.js";

export type AvailableModel = {
  id: string;
  provider: string;
  model: string;
  label: string;
  variants: string[];
};

export function availableModels(payload: RuntimeProviderList): AvailableModel[] {
  const connected = new Set(payload.connected ?? []);
  return (payload.all ?? [])
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) => Object.entries(provider.models ?? {}).flatMap(([modelId, model]) => {
      const output = model.capabilities?.output;
      if (output && output.text !== true && (output.image === true || output.video === true)) return [];
      return [{
        id: `${provider.id}/${modelId}`,
        provider: provider.id,
        model: modelId,
        label: model.name || modelId,
        variants: Object.keys(model.variants ?? {}),
      }];
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadAvailableModels(api: Pick<JuggleWorkApiClient, "providerList">, workspace: WorkspaceInfo): Promise<AvailableModel[]> {
  return availableModels(await api.providerList(workspace.id));
}
