import { describe, expect, test } from "bun:test";

import { effectiveGenerationState, generationDraftAvailable } from "../src/react-app/domains/session/surface/composer/generation-model-reconciliation";

type Model = { id: string };
type Selection = { model: { id: string }; ratio: string };

const reconcile = (input: { models?: Model[]; selection: Selection | null; unavailable: boolean }) =>
  effectiveGenerationState({
    ...input,
    modelKey: (model) => model.id,
    selectionKey: (selection) => selection.model.id,
  });

describe("generation model reconciliation", () => {
  test("clears a removed selection without falling back when another model remains", () => {
    const state = reconcile({
      models: [{ id: "remaining" }],
      selection: { model: { id: "removed" }, ratio: "16:9" },
      unavailable: false,
    });
    expect(state.models).toEqual([{ id: "remaining" }]);
    expect(state.selection).toBeNull();
  });

  test("keeps a selection that remains in the settled result", () => {
    const selection = { model: { id: "selected" }, ratio: "1:1" };
    const state = reconcile({ models: [{ id: "selected" }], selection, unavailable: false });
    expect(state.selection).toBe(selection);
    expect(state.selectedModel).toEqual({ id: "selected" });
  });

  test("exposes no models or active selection during pending, fetching, or error state", () => {
    for (const queryState of ["pending", "fetching", "error"] as const) {
      const state = reconcile({
        models: [{ id: "stale" }],
        selection: { model: { id: "stale" }, ratio: "auto" },
        unavailable: queryState !== "settled",
      });
      expect(state).toEqual({ models: [], selection: null, selectedModel: null });
    }
  });

  test("blocks queued generation drafts when discovery is unavailable or the selected model is gone", () => {
    const selected = { model: { providerID: "images", modelID: "v1" } };
    const modelKey = (model: { providerID: string; modelID: string }) => `${model.providerID}\0${model.modelID}`;
    expect(generationDraftAvailable({ selection: selected, models: [], unavailable: true, modelKey })).toBe(false);
    expect(generationDraftAvailable({ selection: selected, models: [{ providerID: "images", modelID: "v2" }], unavailable: false, modelKey })).toBe(false);
    expect(generationDraftAvailable({ selection: selected, models: [{ providerID: "images", modelID: "v1" }], unavailable: false, modelKey })).toBe(true);
  });
});
