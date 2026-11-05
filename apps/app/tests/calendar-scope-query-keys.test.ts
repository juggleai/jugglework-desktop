import { describe, expect, test } from "bun:test";

import { calendarQueryKeys } from "../src/react-app/domains/calendar/calendar-query-keys";
import { createCalendarScope, normalizeCalendarDeployment } from "../src/react-app/domains/calendar/calendar-scope";

describe("calendar scope and query keys", () => {
  test("normalizes trailing slashes but preserves the complete deployment base path", () => {
    expect(normalizeCalendarDeployment(" https://WORK.example:8443/tenant/api/// ")).toBe("https://work.example:8443/tenant/api");
    expect(normalizeCalendarDeployment("file:///tmp/calendar")).toBeNull();
    expect(normalizeCalendarDeployment("https://user:secret@example.com/api")).toBeNull();
    expect(normalizeCalendarDeployment("https://example.com/api?tenant=one")).toBeNull();
  });

  test("requires every isolation dimension", () => {
    expect(createCalendarScope({ deploymentBaseUrl: "https://one.test/base", organizationId: "org", memberId: "member" })).not.toBeNull();
    expect(createCalendarScope({ deploymentBaseUrl: null, organizationId: "org", memberId: "member" })).toBeNull();
    expect(createCalendarScope({ deploymentBaseUrl: "https://one.test", organizationId: " ", memberId: "member" })).toBeNull();
    expect(createCalendarScope({ deploymentBaseUrl: "https://one.test", organizationId: "org", memberId: "" })).toBeNull();
  });

  test("never collides across deployment path, organization, or member", () => {
    const scope = createCalendarScope({ deploymentBaseUrl: "https://one.test/base-a", organizationId: "org-a", memberId: "member-a" })!;
    const variants = [
      createCalendarScope({ deploymentBaseUrl: "https://one.test/base-b", organizationId: "org-a", memberId: "member-a" })!,
      createCalendarScope({ deploymentBaseUrl: "https://two.test/base-a", organizationId: "org-a", memberId: "member-a" })!,
      createCalendarScope({ deploymentBaseUrl: "https://one.test/base-a", organizationId: "org-b", memberId: "member-a" })!,
      createCalendarScope({ deploymentBaseUrl: "https://one.test/base-a", organizationId: "org-a", memberId: "member-b" })!,
    ];
    const key = JSON.stringify(calendarQueryKeys.range(scope, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }));
    expect(new Set(variants.map((variant) => JSON.stringify(calendarQueryKeys.range(variant, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" })))).has(key)).toBe(false);
  });

  test("canonicalizes opaque calendar ID sets without trimming or dropping values", () => {
    const scope = createCalendarScope({ deploymentBaseUrl: "https://one.test/base", organizationId: "org", memberId: "member" })!;
    const input = { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: ["b", "", " a", "a ", " ", "b"] };
    const equivalent = { ...input, calendarIds: [" ", "a ", "b", " a", ""] };
    expect(calendarQueryKeys.bootstrap(scope, input)).toEqual(calendarQueryKeys.bootstrap(scope, equivalent));
    expect(calendarQueryKeys.range(scope, input)).toEqual(calendarQueryKeys.range(scope, equivalent));
    expect(calendarQueryKeys.search(scope, { query: "review", calendarIds: input.calendarIds })).toEqual(
      calendarQueryKeys.search(scope, { query: "review", calendarIds: equivalent.calendarIds }),
    );
    expect(calendarQueryKeys.range(scope, { ...input, calendarIds: ["a"] })).not.toEqual(
      calendarQueryKeys.range(scope, { ...input, calendarIds: [" a"] }),
    );
    expect(calendarQueryKeys.range(scope, { ...input, calendarIds: [] })).not.toEqual(
      calendarQueryKeys.range(scope, { ...input, calendarIds: [""] }),
    );
  });

  test("isolates every range, search, detail, and changes dimension", () => {
    const scope = createCalendarScope({ deploymentBaseUrl: "https://one.test/base", organizationId: "org", memberId: "member" })!;
    const cases = [
      {
        name: "range",
        base: calendarQueryKeys.range(scope, { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: ["a"], cursor: "cursor-a", limit: 10 }),
        variants: [
          calendarQueryKeys.range(scope, { startDate: "2026-11-02", endDateExclusive: "2026-12-01", calendarIds: ["a"], cursor: "cursor-a", limit: 10 }),
          calendarQueryKeys.range(scope, { startDate: "2026-11-01", endDateExclusive: "2026-12-02", calendarIds: ["a"], cursor: "cursor-a", limit: 10 }),
          calendarQueryKeys.range(scope, { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: ["b"], cursor: "cursor-a", limit: 10 }),
          calendarQueryKeys.range(scope, { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: ["a"], cursor: "cursor-b", limit: 10 }),
          calendarQueryKeys.range(scope, { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: ["a"], cursor: "cursor-a", limit: 20 }),
        ],
      },
      {
        name: "search",
        base: calendarQueryKeys.search(scope, { query: "review", calendarIds: ["a"], cursor: "cursor-a", limit: 10 }),
        variants: [
          calendarQueryKeys.search(scope, { query: "planning", calendarIds: ["a"], cursor: "cursor-a", limit: 10 }),
          calendarQueryKeys.search(scope, { query: "review", calendarIds: ["b"], cursor: "cursor-a", limit: 10 }),
          calendarQueryKeys.search(scope, { query: "review", calendarIds: ["a"], cursor: "cursor-b", limit: 10 }),
          calendarQueryKeys.search(scope, { query: "review", calendarIds: ["a"], cursor: "cursor-a", limit: 20 }),
        ],
      },
      {
        name: "detail",
        base: calendarQueryKeys.event(scope, "event-a"),
        variants: [calendarQueryKeys.event(scope, "event-b")],
      },
      {
        name: "changes",
        base: calendarQueryKeys.changes(scope, "cursor-a", 10),
        variants: [calendarQueryKeys.changes(scope, "cursor-b", 10), calendarQueryKeys.changes(scope, "cursor-a", 20)],
      },
    ];
    for (const { name, base, variants } of cases) {
      const serialized = [base, ...variants].map((key) => JSON.stringify(key));
      expect(new Set(serialized).size, `${name} query key dimensions collided`).toBe(serialized.length);
    }
    expect(new Set(cases.map(({ base }) => JSON.stringify(base))).size).toBe(cases.length);
  });
});
