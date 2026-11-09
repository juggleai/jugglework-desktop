import { describe, expect, test } from "bun:test";

import { resolveCalendarPageGate, type CalendarPageGateInput } from "../src/react-app/domains/calendar/calendar-page-gate";

const ready: CalendarPageGateInput = {
  isSignedIn: true,
  baseUrl: "https://den.example/api/",
  organizationId: "org-a",
  memberId: "member-a",
  configLoading: false,
  calendarEnabled: true,
  calendarWriteEnabled: true,
};

describe("calendar page gate", () => {
  test("opens only for a complete, enabled scope", () => {
    expect(resolveCalendarPageGate(ready)).toEqual({
      kind: "ready",
      scope: { deployment: "https://den.example/api", organizationId: "org-a", memberId: "member-a" },
      writeEnabled: true,
    });
    expect(resolveCalendarPageGate({ ...ready, calendarWriteEnabled: false })).toMatchObject({ kind: "ready", writeEnabled: false });
  });

  test("fails closed for every missing identity dimension", () => {
    expect(resolveCalendarPageGate({ ...ready, isSignedIn: false })).toEqual({ kind: "signed-out" });
    expect(resolveCalendarPageGate({ ...ready, organizationId: " " })).toEqual({ kind: "no-organization" });
    expect(resolveCalendarPageGate({ ...ready, memberId: null })).toEqual({ kind: "membership-unavailable" });
    expect(resolveCalendarPageGate({ ...ready, baseUrl: "not a url" })).toEqual({ kind: "membership-unavailable" });
  });

  test("never treats an unknown or loading capability as enabled", () => {
    expect(resolveCalendarPageGate({ ...ready, calendarEnabled: undefined, configLoading: true })).toEqual({ kind: "loading-capability" });
    expect(resolveCalendarPageGate({ ...ready, calendarEnabled: undefined })).toEqual({ kind: "disabled" });
    expect(resolveCalendarPageGate({ ...ready, calendarEnabled: false })).toEqual({ kind: "disabled" });
    expect(resolveCalendarPageGate({ ...ready, isSignedIn: false, calendarEnabled: true })).toEqual({ kind: "signed-out" });
  });
});
