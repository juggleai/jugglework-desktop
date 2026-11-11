import { expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendarEvent, DenCalendarEventTime } from "../src/app/lib/den";
import { layoutCalendarTimeView } from "../src/react-app/domains/calendar/calendar-time-layout";

const event = (id: string, time: DenCalendarEventTime): DenCalendarEvent => ({
  id, organizationId: "org", ownerMemberId: "member", calendarId: "cal", title: id, description: "", time,
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});
const days = [Temporal.PlainDate.from("2026-11-09"), Temporal.PlainDate.from("2026-11-10")];

test("timed overlap lanes are deterministic and equal boundaries do not overlap", () => {
  const result = layoutCalendarTimeView({
    days, visibleCalendarIds: ["cal"], displayTimeZone: "Asia/Shanghai",
    events: [
      event("a", { kind: "timed", startInstant: "2026-11-09T01:00:00Z", endInstantExclusive: "2026-11-09T02:00:00Z", timeZone: "Asia/Shanghai" }),
      event("b", { kind: "timed", startInstant: "2026-11-09T01:30:00Z", endInstantExclusive: "2026-11-09T02:30:00Z", timeZone: "Asia/Shanghai" }),
      event("c", { kind: "timed", startInstant: "2026-11-09T02:30:00Z", endInstantExclusive: "2026-11-09T03:00:00Z", timeZone: "Asia/Shanghai" }),
    ],
  });
  const segments = result.timedByDate.get("2026-11-09")!;
  expect(segments.map(({ event: item, lane, laneCount }) => [item.id, lane, laneCount])).toEqual([
    ["a", 0, 2], ["b", 1, 2], ["c", 0, 1],
  ]);
});

test("cross-midnight timed events split by day while all-day events keep one span", () => {
  const result = layoutCalendarTimeView({
    days, visibleCalendarIds: ["cal"], displayTimeZone: "Asia/Shanghai",
    events: [
      event("night", { kind: "timed", startInstant: "2026-11-09T15:00:00Z", endInstantExclusive: "2026-11-09T18:00:00Z", timeZone: "Asia/Shanghai" }),
      event("trip", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-11" }),
    ],
  });
  expect(result.timedByDate.get("2026-11-09")![0]).toMatchObject({ startMinute: 1380, endMinute: 1440, continuesToNext: true });
  expect(result.timedByDate.get("2026-11-10")![0]).toMatchObject({ startMinute: 0, endMinute: 120, continuesFromPrevious: true });
  expect(result.allDaySpans[0]).toMatchObject({ startIndex: 0, endIndexExclusive: 2, row: 0 });
});
