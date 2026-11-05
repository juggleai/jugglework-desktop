export type CalendarScope = Readonly<{
  deployment: string;
  organizationId: string;
  memberId: string;
}>;

export function normalizeCalendarDeployment(input: string | null | undefined): string | null {
  const value = input?.trim() ?? "";
  if (!value) return null;

  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function createCalendarScope(input: {
  deploymentBaseUrl?: string | null;
  organizationId?: string | null;
  memberId?: string | null;
}): CalendarScope | null {
  const deployment = normalizeCalendarDeployment(input.deploymentBaseUrl);
  const organizationId = input.organizationId?.trim() ?? "";
  const memberId = input.memberId?.trim() ?? "";
  if (!deployment || !organizationId || !memberId) return null;
  return Object.freeze({ deployment, organizationId, memberId });
}

export function calendarScopeKey(scope: CalendarScope): readonly [string, string, string] {
  return [scope.deployment, scope.organizationId, scope.memberId];
}
