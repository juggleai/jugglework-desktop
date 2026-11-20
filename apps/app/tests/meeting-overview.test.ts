import { expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendarEvent, DenCalendarSchedulingOccurrence } from "../src/app/lib/den";
import { calendarMeetingOccurrences, collapseHistoricalCalendarOccurrences, meetingOverviewLists, meetingOverviewWindow } from "../src/react-app/domains/meeting/meeting-overview";
import type { Meeting } from "../src/react-app/domains/meeting/types";

const baseEvent = (id: string): DenCalendarEvent => ({
  id,
  organizationId: "org-a",
  ownerMemberId: "member-a",
  calendarId: "calendar-a",
  title: `Meeting ${id}`,
  description: "",
  videoConferenceEnabled: true,
  time: {
    kind: "timed",
    startInstant: "2026-11-16T01:00:00Z",
    endInstantExclusive: "2026-11-16T02:00:00Z",
    timeZone: "Asia/Shanghai",
  },
  version: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
});

test("meeting overview uses a rolling cross-month window within the scheduling limit", () => {
  const range = meetingOverviewWindow(Temporal.Instant.from("2026-11-16T04:00:00Z"), "Asia/Shanghai");
  expect(range.calendarRange).toEqual({ startDate: "2026-10-17", endDateExclusive: "2026-12-17" });
  expect((range.to.getTime() - range.from.getTime()) / 86_400_000).toBe(61);
});

test("calendar video meetings include every expanded recurring occurrence", () => {
  const aggregate = {
    ...baseEvent("series-a"),
    status: "active" as const,
    attendees: [{ memberId: "member-a", responseStatus: "accepted" as const }],
    recurrence: { frequency: "daily" as const, interval: 1, end: { kind: "count" as const, count: 2 } },
  };
  const occurrences: DenCalendarSchedulingOccurrence[] = [
    { event: aggregate, occurrenceIndex: 1, time: aggregate.time },
    { event: aggregate, occurrenceIndex: 2, time: { ...aggregate.time, startInstant: "2026-11-17T01:00:00Z", endInstantExclusive: "2026-11-17T02:00:00Z" } },
  ];

  const result = calendarMeetingOccurrences([aggregate], occurrences, "Asia/Shanghai");

  expect(result).toHaveLength(2);
  expect(result.map((item) => item.occurrenceIndex)).toEqual([1, 2]);
  expect(result.every((item) => item.recurring)).toBe(true);
  expect(new Set(result.map((item) => item.key)).size).toBe(2);
});

test("calendar meeting projection keeps ordinary events and omits disabled video intent", () => {
  const enabled = baseEvent("enabled");
  const disabled = { ...baseEvent("disabled"), videoConferenceEnabled: false };

  const result = calendarMeetingOccurrences([enabled, disabled], [], "Asia/Shanghai");

  expect(result.map((item) => item.eventId)).toEqual(["enabled"]);
  expect(result[0]).toMatchObject({ description: "", attendeeMemberIds: ["member-a"] });
});

test("upcoming contains only calendar reservations, even after a room is created for one", () => {
  const now = Date.parse("2026-11-16T01:00:00Z");
  const reservation = baseEvent("reservation");
  const later: DenCalendarEvent = { ...baseEvent("later"), time: {
    kind: "timed", startInstant: "2026-11-17T01:00:00Z", endInstantExclusive: "2026-11-17T02:00:00Z", timeZone: "Asia/Shanghai",
  } };
  const past: DenCalendarEvent = { ...baseEvent("past"), time: {
    kind: "timed", startInstant: "2026-11-16T00:00:00Z", endInstantExclusive: "2026-11-16T01:00:00Z", timeZone: "Asia/Shanghai",
  } };
  const room: Meeting = {
    id: "instant-room", organizationId: "org-a", code: "123456", title: reservation.title,
    description: "", sourceKind: "workbench", sourceId: "", organizerId: "user-a", hostId: "user-a",
    status: "preparing", version: 1, startAt: "2026-11-16T01:00:00Z", endAt: "2026-11-16T01:30:00Z",
    timezone: "Asia/Shanghai", locked: false, invites: {}, participants: {},
  };
  const ended: Meeting = { ...room, id: "ended-room", status: "ended", startAt: "2026-11-16T00:15:00Z", endAt: "2026-11-16T00:45:00Z" };
  const occurrences = calendarMeetingOccurrences([later, past, reservation], [], "Asia/Shanghai");

  for (const status of ["scheduled", "preparing", "live"] as const) {
    const rooms = [{ ...room, status }, ended];
    const { upcoming, history } = meetingOverviewLists(rooms, occurrences, now);
    expect(upcoming.map((item) => item.eventId)).toEqual(["reservation", "later"]);
    expect(history.map((entry) => entry.kind === "meeting" ? entry.value.id : entry.value.eventId)).toEqual(["ended-room", "past"]);
    expect(meetingOverviewLists(rooms, [], now).upcoming).toEqual([]);
  }
});

test("historical recurring occurrences collapse to the latest row per series", () => {
  const recurring = (eventId: string, occurrenceIndex: number, startAt: string) => ({
    key: `${eventId}:${occurrenceIndex}`,
    eventId,
    occurrenceIndex,
    title: `Series ${eventId}`,
    startAt,
    endAt: Temporal.Instant.from(startAt).add({ hours: 1 }).toString(),
    allDay: false,
    recurring: true,
    description: "",
    attendeeMemberIds: ["member-a"],
  });
  const oneOff = { ...recurring("one-off", 1, "2026-11-12T01:00:00Z"), recurring: false };

  const result = collapseHistoricalCalendarOccurrences([
    recurring("series-a", 1, "2026-11-10T01:00:00Z"),
    recurring("series-a", 2, "2026-11-11T01:00:00Z"),
    recurring("series-b", 1, "2026-11-09T01:00:00Z"),
    oneOff,
  ]);

  expect(result).toHaveLength(3);
  expect(result.find((item) => item.eventId === "series-a")).toMatchObject({ occurrenceIndex: 2, collapsedCount: 2 });
  expect(result.find((item) => item.eventId === "series-b")).toMatchObject({ collapsedCount: 1 });
  expect(result.find((item) => item.eventId === "one-off")?.collapsedCount).toBeUndefined();
});
