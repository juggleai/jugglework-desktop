import { createHash } from "node:crypto";
import { JuggleWorkApiError, type JuggleWorkApiClient } from "./api.js";
import type { CloudClient } from "./cloud-client.js";

export type ManagedProviderApi = Pick<JuggleWorkApiClient, "managedProviderRevision" | "fenceManagedProviderAuthority" | "confirmManagedProviderAuthority" | "setManagedProviderReadiness">;
export type ManagedProviderCloud = Pick<CloudClient, "currentUser" | "organizationState" | "setActiveOrganization">;

export async function suspendOwnedManagedProviders(api: ManagedProviderApi, workspaceId: string) {
  const { revision } = await api.managedProviderRevision();
  try {
    await api.setManagedProviderReadiness(workspaceId, revision, false);
  } catch (error) {
    if (!(error instanceof JuggleWorkApiError && error.code === "stale_managed_provider_authority")) throw error;
  }
  return revision;
}

export async function confirmOwnedManagedProviders(input: {
  api: ManagedProviderApi; cloud: ManagedProviderCloud; token: string; workspaceId: string;
  organizationId: string; activeOrgId: string | null; deployment: string; revision: string; expectedUserId?: string;
}) {
  const { api, cloud, token, organizationId, deployment, expectedUserId } = input;
  let revision = input.revision;
  if (input.activeOrgId !== organizationId) {
    const fenced = await api.fenceManagedProviderAuthority(revision);
    if (!fenced.revision) throw new Error("Managed model identity changed before organization selection.");
    revision = fenced.revision;
    await cloud.setActiveOrganization(token, organizationId);
  }
  const [user, orgs] = await Promise.all([cloud.currentUser(token), cloud.organizationState(token)]);
  if (!user.id || (expectedUserId && expectedUserId !== user.id) || orgs.activeOrgId !== organizationId || !orgs.items.some((org) => org.id === organizationId)) {
    throw new Error("The Cloud session did not confirm the selected organization.");
  }
  const session = createHash("sha256").update(token).digest("hex");
  const { id } = await api.confirmManagedProviderAuthority({ revision, deployment, userId: user.id, organizationId, session });
  await api.setManagedProviderReadiness(input.workspaceId, id, false);
  return id;
}

export async function hasManagedProviderAuthority(api: Pick<ManagedProviderApi, "managedProviderRevision">) {
  try {
    await api.managedProviderRevision();
    return true;
  } catch (error) {
    if (error instanceof JuggleWorkApiError && error.status === 404) return false;
    throw error;
  }
}
