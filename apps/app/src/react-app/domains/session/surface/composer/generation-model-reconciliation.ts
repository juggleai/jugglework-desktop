export function effectiveGenerationState<Model, Selection>(input: {
  models: Model[] | undefined;
  selection: Selection | null;
  unavailable: boolean;
  modelKey: (model: Model) => string;
  selectionKey: (selection: Selection) => string;
}): { models: Model[]; selection: Selection | null; selectedModel: Model | null } {
  if (input.unavailable) return { models: [], selection: null, selectedModel: null };
  const models = input.models ?? [];
  if (!input.selection) return { models, selection: null, selectedModel: null };
  const selectedModel = models.find((model) => input.modelKey(model) === input.selectionKey(input.selection!)) ?? null;
  return {
    models,
    selection: selectedModel ? input.selection : null,
    selectedModel,
  };
}

export function generationDraftAvailable<Model>(input: {
  selection: { model: { providerID: string; modelID: string } } | undefined;
  models: Model[];
  unavailable: boolean;
  modelKey: (model: Model) => string;
}): boolean {
  if (!input.selection) return true;
  if (input.unavailable) return false;
  const selectionKey = `${input.selection.model.providerID}\0${input.selection.model.modelID}`;
  return input.models.some((model) => input.modelKey(model) === selectionKey);
}
