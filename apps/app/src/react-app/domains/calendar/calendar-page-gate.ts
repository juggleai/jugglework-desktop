import { createCalendarScope, type CalendarScope } from "./calendar-scope";

export type CalendarPageGateInput = {
  isSignedIn: boolean;
  baseUrl: string | null | undefined;
  organizationId: string | null | undefined;
  memberId: string | null | undefined;
  configLoading: boolean;
  calendarEnabled: boolean | undefined;
  calendarWriteEnabled: boolean | undefined;
};

export type CalendarPageGate =
  | { kind: "signed-out" }
  | { kind: "no-organization" }
  | { kind: "membership-unavailable" }
  | { kind: "loading-capability" }
  | { kind: "disabled" }
  | { kind: "ready"; scope: CalendarScope; writeEnabled: boolean };

/**
 * Decide what the Calendar page may render. Anything short of a complete,
 * enabled scope fails closed so no cached member data is ever shown.
 */
export function resolveCalendarPageGate(input: CalendarPageGateInput): CalendarPageGate {
  if (!input.isSignedIn) return { kind: "signed-out" };
  const scope = createCalendarScope({
    deploymentBaseUrl: input.baseUrl,
    organizationId: input.organizationId,
    memberId: input.memberId,
  });
  if (!input.organizationId?.trim()) return { kind: "no-organization" };
  if (!scope) return { kind: "membership-unavailable" };
  if (input.calendarEnabled !== true) {
    return input.configLoading ? { kind: "loading-capability" } : { kind: "disabled" };
  }
  return { kind: "ready", scope, writeEnabled: input.calendarWriteEnabled === true };
}
