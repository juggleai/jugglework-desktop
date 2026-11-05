import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import {
  calendarCoverageDates,
  calendarTimeToForm,
  convertCalendarTime,
  createCalendarTimeFromForm,
  formatCalendarTime,
  parseCalendarEventTime,
  resolveCalendarZonedDateTime,
  serializeCalendarEventTime,
} from "../src/react-app/domains/calendar/calendar-time-adapter";

describe("calendar Temporal time adapter", () => {
  test("keeps all-day dates independent from UTC and preserves exclusive end", () => {
    const time = parseCalendarEventTime({ kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-06" });
    expect(time.kind).toBe("allDay");
    expect(serializeCalendarEventTime(createCalendarTimeFromForm(calendarTimeToForm(time)))).toEqual({ kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-06" });
    expect(serializeCalendarEventTime(time)).toEqual({ kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-06" });
    expect(Object.values(serializeCalendarEventTime(time)).some((value) => typeof value === "string" && value.includes("T00:00:00Z"))).toBe(false);
  });

  test.each([
    ["spring gap rejects", "2026-03-08", "02:30", "America/New_York", "reject", true],
    ["spring gap chooses later", "2026-03-08", "02:30", "America/New_York", "later", false],
    ["fall fold rejects", "2026-11-01", "01:30", "America/New_York", "reject", true],
    ["fall fold chooses earlier", "2026-11-01", "01:30", "America/New_York", "earlier", false],
    ["fall fold chooses later", "2026-11-01", "01:30", "America/New_York", "later", false],
  ] as const)("%s with explicit disambiguation", (_name, date, time, timeZone, disambiguation, throws) => {
    const action = () => resolveCalendarZonedDateTime({ date, time, timeZone, disambiguation });
    if (throws) expect(action).toThrow();
    else expect(action().timeZoneId).toBe(timeZone);
  });

  test("maps fold choices to distinct real instants", () => {
    const earlier = resolveCalendarZonedDateTime({ date: "2026-11-01", time: "01:30", timeZone: "America/New_York", disambiguation: "earlier" });
    const later = resolveCalendarZonedDateTime({ date: "2026-11-01", time: "01:30", timeZone: "America/New_York", disambiguation: "later" });
    expect(later.epochMilliseconds - earlier.epochMilliseconds).toBe(3_600_000);
  });

  test.each([
    ["spring forward", "2026-03-08", "01:30", "2026-03-08", "03:30", 3_600_000],
    ["fall back", "2026-11-01", "00:30", "2026-11-01", "02:30", 10_800_000],
  ])("creates a %s interval from real elapsed instants", (_name, startDate, startTime, endDate, endTime, duration) => {
    const interval = createCalendarTimeFromForm({
      kind: "timed",
      startDate,
      startTime,
      endDate,
      endTime,
      timeZone: "America/New_York",
      startDisambiguation: "reject",
      endDisambiguation: "reject",
    });
    expect(interval.kind).toBe("timed");
    if (interval.kind === "timed") expect(interval.endInstantExclusive.epochMilliseconds - interval.startInstant.epochMilliseconds).toBe(duration);
  });

  test.each([
    ["gap", "2026-03-08", "02:30", "later", "2026-03-08T07:30:00Z"],
    ["fold earlier", "2026-11-01", "01:30", "earlier", "2026-11-01T05:30:00Z"],
    ["fold later", "2026-11-01", "01:30", "later", "2026-11-01T06:30:00Z"],
  ] as const)("handles an end in a DST %s explicitly", (_name, endDate, endTime, endDisambiguation, expectedEnd) => {
    const common = {
      kind: "timed" as const,
      startDate: endDate,
      startTime: "00:30",
      endDate,
      endTime,
      timeZone: "America/New_York",
      startDisambiguation: "reject" as const,
    };
    expect(() => createCalendarTimeFromForm({ ...common, endDisambiguation: "reject" })).toThrow();
    const interval = createCalendarTimeFromForm({ ...common, endDisambiguation });
    expect(interval.kind === "timed" && interval.endInstantExclusive.toString()).toBe(expectedEnd);
  });

  test("round-trips authoritative instants through fold-aware form values", () => {
    const interval = parseCalendarEventTime({
      kind: "timed",
      startInstant: "2026-11-01T05:15:00Z",
      endInstantExclusive: "2026-11-01T06:45:00Z",
      timeZone: "America/New_York",
    });
    const form = calendarTimeToForm(interval);
    expect(form).toEqual({
      kind: "timed",
      startDate: "2026-11-01",
      startTime: "01:15:00",
      endDate: "2026-11-01",
      endTime: "01:45:00",
      timeZone: "America/New_York",
      startDisambiguation: "earlier",
      endDisambiguation: "later",
    });
    expect(serializeCalendarEventTime(createCalendarTimeFromForm(form))).toEqual(serializeCalendarEventTime(interval));
  });

  test.each([
    ["midnight exclusive end", "2026-11-05T15:00:00Z", "2026-11-05T16:00:00Z", "Asia/Shanghai", "2026-11-05", "2026-11-06"],
    ["cross-day non-midnight end", "2026-11-05T15:00:00Z", "2026-11-06T17:00:00Z", "Asia/Shanghai", "2026-11-05", "2026-11-08"],
    ["DST spring transition", "2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z", "America/New_York", "2026-03-08", "2026-03-09"],
    ["DST fall repeated hour", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "America/New_York", "2026-11-01", "2026-11-02"],
  ])("derives coverage for %s", (_name, startInstant, endInstantExclusive, timeZone, startDate, endDateExclusive) => {
    const coverage = calendarCoverageDates(parseCalendarEventTime({ kind: "timed", startInstant, endInstantExclusive, timeZone }));
    expect(coverage.startDate.toString()).toBe(startDate);
    expect(coverage.endDateExclusive.toString()).toBe(endDateExclusive);
  });

  test("converts form local values to instants and rejects non-exclusive ranges", () => {
    const timed = createCalendarTimeFromForm({
      kind: "timed",
      startDate: "2026-11-05",
      startTime: "09:00",
      endDate: "2026-11-05",
      endTime: "10:00",
      timeZone: "Asia/Shanghai",
      startDisambiguation: "reject",
      endDisambiguation: "reject",
    });
    expect(serializeCalendarEventTime(timed)).toEqual({
      kind: "timed",
      startInstant: "2026-11-05T01:00:00Z",
      endInstantExclusive: "2026-11-05T02:00:00Z",
      timeZone: "Asia/Shanghai",
    });
    expect(() => createCalendarTimeFromForm({ kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-05" })).toThrow();
  });

  test("uses the saved zone when displaying and refilling authoritative instants", () => {
    const shanghai = parseCalendarEventTime({ kind: "timed", startInstant: "2026-11-05T01:00:00Z", endInstantExclusive: "2026-11-05T02:00:00Z", timeZone: "Asia/Shanghai" });
    const newYork = parseCalendarEventTime({ kind: "timed", startInstant: "2026-11-05T01:00:00Z", endInstantExclusive: "2026-11-05T02:00:00Z", timeZone: "America/New_York" });
    expect(calendarTimeToForm(shanghai)).toMatchObject({ startDate: "2026-11-05", startTime: "09:00:00", endTime: "10:00:00", timeZone: "Asia/Shanghai" });
    expect(calendarTimeToForm(newYork)).toMatchObject({ startDate: "2026-11-04", startTime: "20:00:00", endTime: "21:00:00", timeZone: "America/New_York" });
    expect(formatCalendarTime(shanghai, "en-US")).not.toBe(formatCalendarTime(newYork, "en-US"));
  });

  test("formats a multi-day all-day range with its inclusive display end", () => {
    const interval = parseCalendarEventTime({ kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-08" });
    expect(formatCalendarTime(interval, "en-US")).toBe("Nov 5, 2026 - Nov 7, 2026");
  });

  test("revalidates an IANA zone when serializing timed values", () => {
    expect(() => serializeCalendarEventTime({
      kind: "timed",
      startInstant: Temporal.Instant.from("2026-11-05T01:00:00Z"),
      endInstantExclusive: Temporal.Instant.from("2026-11-05T02:00:00Z"),
      timeZone: "+08:00",
    })).toThrow(/IANA/);
  });

  test("converts timed to all-day with an explicit projection zone and clears timed fields", () => {
    const timed = parseCalendarEventTime({ kind: "timed", startInstant: "2026-11-05T04:30:00Z", endInstantExclusive: "2026-11-06T05:00:00Z", timeZone: "UTC" });
    const allDay = convertCalendarTime(timed, { kind: "allDay", timeZone: "America/New_York" });
    expect(serializeCalendarEventTime(allDay)).toEqual({ kind: "allDay", startDate: "2026-11-04", endDateExclusive: "2026-11-06" });
  });

  test("converts all-day to timed with explicit local boundaries and clears date-only fields", () => {
    const allDay = parseCalendarEventTime({ kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-07" });
    const timed = convertCalendarTime(allDay, {
      kind: "timed",
      timeZone: "Asia/Shanghai",
      startTime: "09:00",
      endTime: "17:00",
      startDisambiguation: "reject",
      endDisambiguation: "reject",
    });
    expect(serializeCalendarEventTime(timed)).toEqual({
      kind: "timed",
      startInstant: "2026-11-05T01:00:00Z",
      endInstantExclusive: "2026-11-06T09:00:00Z",
      timeZone: "Asia/Shanghai",
    });
  });

  test("formats all-day and timed values by locale without changing domain types", () => {
    const allDay = parseCalendarEventTime({ kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-06" });
    const timed = parseCalendarEventTime({ kind: "timed", startInstant: "2026-11-05T01:00:00Z", endInstantExclusive: "2026-11-05T02:00:00Z", timeZone: "Asia/Shanghai" });
    expect(formatCalendarTime(allDay, "en-US")).toContain("Nov");
    expect(formatCalendarTime(allDay, "zh-CN")).toContain("2026");
    expect(formatCalendarTime(timed, "en-US")).toMatch(/9:00|09:00/);
    expect(formatCalendarTime(timed, "zh-CN")).toContain("2026");
    expect(allDay.kind === "allDay" && allDay.startDate).toBeInstanceOf(Temporal.PlainDate);
    expect(timed.kind === "timed" && timed.startInstant).toBeInstanceOf(Temporal.Instant);
  });
});
