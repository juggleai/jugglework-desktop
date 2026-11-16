import { describe, expect, test } from "bun:test";

import { CALENDAR_COLOR_PALETTE, nextCalendarColor, withDefaultCalendarColors } from "../src/react-app/domains/calendar/calendar-colors";
import type { DenCalendar } from "../src/app/lib/den";

const calendar = (id: string, color: string | null): DenCalendar => ({
  id, organizationId: "org-a", ownerMemberId: "member-a", name: id, color, isDefault: id === "one",
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});

describe("calendar colors", () => {
  test("the selectable palette starts blue and excludes black", () => {
    expect(CALENDAR_COLOR_PALETTE[0]).toBe("#3370ff");
    expect(CALENDAR_COLOR_PALETTE.map((color) => color.toLowerCase())).not.toContain("#000000");
  });

  test("defaults use the first unused palette color and cycle after exhaustion", () => {
    expect(nextCalendarColor([])).toBe("#3370ff");
    expect(nextCalendarColor(["#3370FF"])).toBe("#d84fa3");
    expect(nextCalendarColor(CALENDAR_COLOR_PALETTE)).toBe("#3370ff");
    expect(nextCalendarColor([...CALENDAR_COLOR_PALETTE, "#123456"])).toBe("#d84fa3");
  });

  test("legacy calendars without colors receive distinct palette defaults", () => {
    expect(withDefaultCalendarColors([calendar("one", null), calendar("two", null), calendar("three", "#2fbd50")]).map((item) => item.color))
      .toEqual(["#3370ff", "#d84fa3", "#2fbd50"]);
  });

  test("legacy defaults stay bound to calendar IDs across reorder and keep cycling after palette exhaustion", () => {
    const legacy = [calendar("z-last", null), calendar("a-first", null)];
    const first = withDefaultCalendarColors(legacy);
    const reordered = withDefaultCalendarColors([...legacy].reverse());
    expect(Object.fromEntries(first.map((item) => [item.id, item.color])))
      .toEqual(Object.fromEntries(reordered.map((item) => [item.id, item.color])));

    const explicit = CALENDAR_COLOR_PALETTE.map((color, index) => calendar(`explicit-${index}`, color));
    const cycled = withDefaultCalendarColors([...explicit, calendar("legacy-b", null), calendar("legacy-a", null)]);
    expect(cycled.slice(-2).map((item) => item.color)).toEqual(["#d84fa3", "#3370ff"]);
  });
});
