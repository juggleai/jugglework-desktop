import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationSchedule } from "@jugglework/types/automation";
import { latestAutomationOccurrenceAtOrBefore, nextAutomationOccurrence, zonedLocalToEpoch } from "./schedule.js";

test("calendar recurrence observes timezone, DST gaps and overlaps deterministically", () => {
  const daily = (localTime: string): AutomationSchedule => ({
    version: 1,
    kind: "calendar",
    frequency: "daily",
    localTime,
    timezone: "America/New_York",
  });

  assert.equal(
    nextAutomationOccurrence(daily("02:30"), undefined, Date.parse("2026-03-08T00:00:00Z")),
    Date.parse("2026-03-08T07:00:00Z"),
  );
  assert.equal(
    nextAutomationOccurrence(daily("01:30"), undefined, Date.parse("2026-11-01T00:00:00Z")),
    Date.parse("2026-11-01T05:30:00Z"),
  );
});

test("monthly and yearly recurrence skip invalid calendar dates", () => {
  assert.equal(
    nextAutomationOccurrence({
      version: 1,
      kind: "calendar",
      frequency: "monthly",
      dayOfMonth: 31,
      localTime: "09:00",
      timezone: "UTC",
    }, undefined, Date.parse("2026-04-01T00:00:00Z")),
    Date.parse("2026-05-31T09:00:00Z"),
  );
  assert.equal(
    nextAutomationOccurrence({
      version: 1,
      kind: "calendar",
      frequency: "yearly",
      month: 2,
      dayOfMonth: 29,
      localTime: "09:00",
      timezone: "UTC",
    }, undefined, Date.parse("2026-01-01T00:00:00Z")),
    Date.parse("2028-02-29T09:00:00Z"),
  );
});

test("weekly multi-day and one-time variants calculate exact stored-timezone occurrences", () => {
  const weekly: AutomationSchedule = {
    version: 1,
    kind: "calendar",
    frequency: "weekly",
    weekdays: [1, 5],
    localTime: "09:00",
    timezone: "Asia/Shanghai",
  };
  assert.equal(
    nextAutomationOccurrence(weekly, undefined, Date.parse("2026-08-09T00:00:00Z")),
    Date.parse("2026-08-10T01:00:00Z"),
  );
  assert.equal(
    nextAutomationOccurrence(weekly, undefined, Date.parse("2026-08-10T01:00:00Z")),
    Date.parse("2026-08-14T01:00:00Z"),
  );

  const once: AutomationSchedule = {
    version: 1,
    kind: "once",
    localDate: "2026-08-21",
    localTime: "18:12",
    timezone: "Asia/Shanghai",
  };
  assert.equal(nextAutomationOccurrence(once, undefined, Date.parse("2026-08-20T00:00:00Z")), Date.parse("2026-08-21T10:12:00Z"));
  assert.equal(nextAutomationOccurrence(once, undefined, Date.parse("2026-08-21T10:12:00Z")), null);
});

test("interval recurrence remains anchored and active range is inclusive", () => {
  const interval: AutomationSchedule = {
    version: 1,
    kind: "interval",
    every: 2,
    unit: "hour",
    anchorLocalDate: "2026-08-11",
    anchorLocalTime: "00:00",
    timezone: "Asia/Shanghai",
  };
  assert.equal(
    nextAutomationOccurrence(interval, undefined, Date.parse("2026-08-11T02:15:00Z")),
    Date.parse("2026-08-11T04:00:00Z"),
  );
  assert.equal(
    nextAutomationOccurrence(interval, { startDate: "2026-08-12", endDate: "2026-08-12" }, Date.parse("2026-08-11T02:15:00Z")),
    Date.parse("2026-08-11T16:00:00Z"),
  );
});

test("interval weekdays restrict occurrences to the selected local weekdays", () => {
  // 2026-08-11 是周二；限制为周一(1)和周三(3)后，周二的候选全部跳过。
  const interval: AutomationSchedule = {
    version: 1,
    kind: "interval",
    every: 6,
    unit: "hour",
    anchorLocalDate: "2026-08-11",
    anchorLocalTime: "00:00",
    timezone: "Asia/Shanghai",
    weekdays: [1, 3],
  };
  assert.equal(
    nextAutomationOccurrence(interval, undefined, Date.parse("2026-08-10T20:00:00Z")),
    // 下一个允许的本地时刻是 8/12（周三）00:00 Asia/Shanghai。
    Date.parse("2026-08-11T16:00:00Z"),
  );
  assert.equal(
    latestAutomationOccurrenceAtOrBefore(interval, undefined, Date.parse("2026-08-11T20:00:00Z")),
    Date.parse("2026-08-11T16:00:00Z"),
  );
});

test("interval without matching weekday inside the active range yields no occurrence", () => {
  const interval: AutomationSchedule = {
    version: 1,
    kind: "interval",
    every: 1,
    unit: "day",
    anchorLocalDate: "2026-08-11",
    anchorLocalTime: "09:00",
    timezone: "Asia/Shanghai",
    weekdays: [6, 7],
  };
  assert.equal(
    nextAutomationOccurrence(interval, { startDate: "2026-08-11", endDate: "2026-08-13" }, Date.parse("2026-08-10T00:00:00Z")),
    null,
  );
});

test("zoned conversion does not depend on process timezone", () => {
  assert.equal(zonedLocalToEpoch("2026-08-11T10:00", "Asia/Shanghai"), Date.parse("2026-08-11T02:00:00Z"));
});
