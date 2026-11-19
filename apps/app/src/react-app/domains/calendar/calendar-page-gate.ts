import { isPersonalDenOrganization, type DenOrgSummary } from "@/app/lib/den";
import { createCalendarScope, type CalendarScope } from "./calendar-scope";

export type CalendarPageGateInput = {
  isSignedIn: boolean;
  baseUrl: string | null | undefined;
  activeOrganization: Pick<DenOrgSummary, "id" | "slug" | "kind" | "orgMemberId" | "membershipId"> | null | undefined;
};

export type CalendarWorkspaceKind = "personal" | "organization" | "unresolved";

export type CalendarPageGate =
  | { kind: "signed-out" }
  | { kind: "no-organization" }
  | { kind: "membership-unavailable" }
  | { kind: "ready"; scope: CalendarScope; workspaceKind: CalendarWorkspaceKind };

/**
 * A complete signed-in scope is required even to read cached member data.
 * Team APIs also need a confirmed organization workspace; cached settings may
 * have an ID and slug before Den supplies the workspace kind.
 */
export function resolveCalendarPageGate(input: CalendarPageGateInput): CalendarPageGate {
  if (!input.isSignedIn) return { kind: "signed-out" };
  const organization = input.activeOrganization;
  if (!organization?.id.trim()) return { kind: "no-organization" };
  const scope = createCalendarScope({
    deploymentBaseUrl: input.baseUrl,
    organizationId: organization.id,
    memberId: organization.orgMemberId || organization.membershipId,
  });
  if (!scope) return { kind: "membership-unavailable" };
  const workspaceKind = isPersonalDenOrganization(organization) ? "personal"
    : organization.kind === "organization" ? "organization" : "unresolved";
  return { kind: "ready", scope, workspaceKind };
}
