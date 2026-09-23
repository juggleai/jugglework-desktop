import type { CloudOrganization, CloudOrganizations } from "./cloud-client.js";

/** Resolve the account's current choice, then its local history, then Cloud's list order. */
export function resolveCloudOrganization(
  state: CloudOrganizations,
  input: { explicit?: string | null; remembered?: string | null; current?: string | null } = {},
): CloudOrganization | null {
  const find = (value: string | null | undefined) => {
    const key = value?.trim();
    return key ? state.items.find((item) => item.id === key || item.slug === key) ?? null : null;
  };
  if (input.explicit) return find(input.explicit);
  return find(state.activeOrgId)
    ?? find(state.activeOrgSlug)
    ?? find(input.remembered)
    ?? find(input.current)
    ?? state.items[0]
    ?? null;
}
