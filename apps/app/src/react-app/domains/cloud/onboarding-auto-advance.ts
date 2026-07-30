import type { DenOrgLlmProvider, DenOrgSummary } from "@/app/lib/den";
import { resolveModelDisplayName, resolveProviderDisplayName } from "@/app/utils";

/**
 * Onboarding screens that present a single option are not a choice, they are a
 * confirmation. These decide when a step can settle itself and get out of the
 * way — always by doing exactly what the one available control would have done.
 */

export type DefaultModelSelection = {
  providerId: string;
  modelId: string;
  label: string;
};

/**
 * What "Use as default" on a provider card resolves to. The first model is the
 * provider's own ordering from Den, and is what the button has always picked —
 * shared so the auto-advance path cannot drift from the click path.
 */
export function buildDefaultModelSelection(
  provider: DenOrgLlmProvider,
): DefaultModelSelection | null {
  const providerId = provider.id.trim();
  const firstModel = provider.models[0] ?? null;
  if (!providerId || !firstModel) return null;
  return {
    providerId,
    modelId: firstModel.id,
    label: `${resolveProviderDisplayName(provider.name || provider.providerId)} · ${firstModel.name || resolveModelDisplayName(firstModel.id)}`,
  };
}

/** The org to adopt without asking, or null when the user has a real choice. */
export function autoAdvanceOrganization(
  orgs: readonly DenOrgSummary[] | null | undefined,
): DenOrgSummary | null {
  return orgs?.length === 1 ? orgs[0] : null;
}

/**
 * The default model to adopt without asking, or null when the resource step
 * still has something to say.
 *
 * Only one provider offering only one model makes the default unambiguous.
 * Several providers is an obvious choice to leave alone, and so is one
 * provider offering several models: picking the first would quietly decide
 * something the member can see is a decision. A provider with no models has
 * no default to set at all.
 */
export function autoAdvanceDefaultModel(
  providers: readonly DenOrgLlmProvider[] | null | undefined,
): DefaultModelSelection | null {
  if (providers?.length !== 1) return null;
  const provider = providers[0];
  if (provider.models.length !== 1) return null;
  return buildDefaultModelSelection(provider);
}
