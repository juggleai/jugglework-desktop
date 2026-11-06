import { describe, expect, test } from "bun:test";

import { createCalendarScope } from "../src/react-app/domains/calendar/calendar-scope";
import { CalendarScopeStaleError, createCalendarScopeLifecycle } from "../src/react-app/domains/calendar/calendar-scope-lifecycle";

const scope = (organizationId: string, memberId = "member-a", deploymentBaseUrl = "https://den.example/api") => createCalendarScope({ deploymentBaseUrl, organizationId, memberId })!;

describe("calendar scope lifecycle", () => {
  test("reuses an equal scope and rotates on every identity dimension", () => {
    const lifecycle = createCalendarScopeLifecycle();
    const first = lifecycle.transition(scope("org-a")).current!;
    expect(lifecycle.transition(scope("org-a")).current).toBe(first);
    expect(first.signal.aborted).toBe(false);
    const second = lifecycle.transition(scope("org-b")).current!;
    expect(first.signal.aborted).toBe(true);
    expect(second.generation).toBeGreaterThan(first.generation);
    const third = lifecycle.transition(scope("org-b", "member-b")).current!;
    expect(second.signal.aborted).toBe(true);
    const fourth = lifecycle.transition(scope("org-b", "member-b", "https://other.example/api")).current!;
    expect(third.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(fourth)).toBe(true);
  });

  test("hides the current scope immediately on logout and rejects stale leases", () => {
    const lifecycle = createCalendarScopeLifecycle();
    const generation = lifecycle.transition(scope("org-a")).current!;
    lifecycle.transition(null);
    expect(lifecycle.current()).toBeNull();
    expect(generation.signal.aborted).toBe(true);
    expect(() => lifecycle.throwIfStale(generation)).toThrow(CalendarScopeStaleError);
  });

  test("dispose aborts the current generation", () => {
    const lifecycle = createCalendarScopeLifecycle();
    const generation = lifecycle.transition(scope("org-a")).current!;
    lifecycle.dispose();
    expect(generation.signal.aborted).toBe(true);
    expect(lifecycle.current()).toBeNull();
  });
});
