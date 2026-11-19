import { describe, expect, test } from "bun:test";

import { resolveCalendarPageGate, type CalendarPageGateInput } from "../src/react-app/domains/calendar/calendar-page-gate";

const organization = { id: "org-a", slug: "studio", kind: "organization" as const, orgMemberId: "member-a" };
const ready: CalendarPageGateInput = {
  isSignedIn: true,
  baseUrl: "https://den.example/api/",
  activeOrganization: organization,
};

describe("calendar page gate", () => {
  test("opens for a complete signed-in member scope", () => {
    expect(resolveCalendarPageGate(ready)).toEqual({
      kind: "ready",
      scope: { deployment: "https://den.example/api", organizationId: "org-a", memberId: "member-a" },
      workspaceKind: "organization",
    });
    expect(resolveCalendarPageGate({ ...ready, activeOrganization: { ...organization, orgMemberId: undefined, membershipId: "legacy-member" } }))
      .toMatchObject({ kind: "ready", scope: { memberId: "legacy-member" } });
  });

  test("fails closed for every missing identity dimension", () => {
    expect(resolveCalendarPageGate({ ...ready, isSignedIn: false })).toEqual({ kind: "signed-out" });
    expect(resolveCalendarPageGate({ ...ready, activeOrganization: null })).toEqual({ kind: "no-organization" });
    expect(resolveCalendarPageGate({ ...ready, activeOrganization: { ...organization, id: " " } })).toEqual({ kind: "no-organization" });
    expect(resolveCalendarPageGate({ ...ready, activeOrganization: { ...organization, orgMemberId: undefined } })).toEqual({ kind: "membership-unavailable" });
    expect(resolveCalendarPageGate({ ...ready, baseUrl: "not a url" })).toEqual({ kind: "membership-unavailable" });
  });

  test("uses Den personal workspace rules and keeps missing kinds unresolved", () => {
    for (const activeOrganization of [
      { ...organization, kind: "personal" as const },
      { ...organization, kind: undefined, id: "personal_legacy" },
      { ...organization, slug: " Personal " },
    ]) {
      expect(resolveCalendarPageGate({ ...ready, activeOrganization })).toMatchObject({ kind: "ready", workspaceKind: "personal" });
    }
    expect(resolveCalendarPageGate({ ...ready, activeOrganization: { ...organization, kind: undefined } }))
      .toMatchObject({ kind: "ready", workspaceKind: "unresolved" });
  });
});
