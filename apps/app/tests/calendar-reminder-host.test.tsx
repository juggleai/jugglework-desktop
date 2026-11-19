import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { DenCalendarEvent } from "../src/app/lib/den";
import { calendarQueryKeys } from "../src/react-app/domains/calendar/calendar-query-keys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope = { deployment: "https://example.org", organizationId: "org", memberId: "member" };
const start = new Date(Date.now() + 4.5 * 60_000).toISOString(); // default five-minute reminder is due
const core: DenCalendarEvent = {
  id: "core", title: "Planning", organizationId: "org", ownerMemberId: "member", calendarId: "personal",
  version: 1, createdAt: start, updatedAt: start, description: "", videoConferenceEnabled: false,
  time: { kind: "timed", startInstant: start, endInstantExclusive: new Date(Date.parse(start) + 3600_000).toISOString(), timeZone: "UTC" },
};
const personal = { id: "personal", kind: "personal", organizationId: "org", capabilities: { canViewDetails: true } };
const team = { ...personal, id: "team", kind: "team", authorizationVersion: 1 };
const busy = { ...team, id: "busy", capabilities: { canViewDetails: false } };
const series = { ...core, id: "series", status: "active", recurrence: { frequency: "daily", interval: 1, end: { kind: "never" } }, attendees: [] };
let ordinary = [core];
const client = {
  getCalendarBootstrap: mock(async () => ({ calendars: [personal], events: [...ordinary, series] })),
  listCalendarCollaboration: mock(async () => ({ authorizationGeneration: 1, items: [personal, team, busy] })),
  getTeamCalendarSnapshot: mock(async (_org: string, id: string) => ({ calendar: team, events: [{ ...core, calendarId: id, id: "team-event", title: "Team" }] })),
  listCalendarSchedulingEvents: mock(async () => ({ items: [{ event: series, occurrenceIndex: 7, time: core.time }] })),
};
const session = { isSignedIn: false, baseUrl: scope.deployment, activeOrganization: { id: "org", slug: "studio", kind: undefined as "organization" | undefined, orgMemberId: "member" }, client };
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({ useCloudSession: () => session }));
const { CalendarReminderHost } = await import("../src/react-app/domains/calendar/calendar-reminder-host");

test("loads personal reminders first, then authorized team snapshots after workspace kind resolves", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const open = mock(() => {});
  const render = () => <QueryClientProvider client={cache}><CalendarReminderHost onOpen={open} /></QueryClientProvider>;
  let tree!: TestRenderer.ReactTestRenderer;
  const titles = () => tree.root.findAllByType("strong").map((node) => node.children[0]);
  const cardButton = (title: string, index: number) => tree.root.findAllByType("strong").find((n) => n.children[0] === title)!.parent!.parent!.findAllByType("button")[index]!;
  const settle = async (predicate: () => boolean) => {
    for (let i = 0; i < 50 && !predicate(); ++i) await act(async () => { await Bun.sleep(5); });
    expect(predicate()).toBe(true);
  };
  try {
    await act(async () => { tree = TestRenderer.create(render()); });
    expect(client.getCalendarBootstrap).not.toHaveBeenCalled();
    session.isSignedIn = true;
    await act(async () => { tree.update(render()); });
    await settle(() => titles().length === 2);
    expect(client.listCalendarCollaboration).not.toHaveBeenCalled();
    expect(client.getTeamCalendarSnapshot).not.toHaveBeenCalled();
    session.activeOrganization.kind = "organization";
    await act(async () => { tree.update(render()); });
    await settle(() => titles().length === 3);
    expect(client.getTeamCalendarSnapshot.mock.calls.map((args) => args[1])).toEqual(["team"]);
    await act(async () => { cardButton("Team", 1).props.onClick(); });
    expect(open).not.toHaveBeenCalled();
    ordinary = [{ ...core, version: 2, title: "Renamed" }];
    const refresh = () => cache.invalidateQueries({ queryKey: calendarQueryKeys.bootstraps(scope) });
    await act(refresh);
    await settle(() => titles().includes("Renamed"));
    expect(titles()).not.toContain("Team");
    ordinary = [];
    await act(refresh);
    await settle(() => titles().length === 1);
    await act(async () => { cardButton("Planning", 0).props.onClick(); });
    expect(open).toHaveBeenCalledWith({ scope, eventId: "series", calendarId: "personal", occurrenceIndex: 7, date: start.slice(0, 10), startInstant: start });
    expect(titles()).toEqual([]);
  } finally {
    await act(async () => { tree?.unmount(); });
    cache.clear();
  }
});
