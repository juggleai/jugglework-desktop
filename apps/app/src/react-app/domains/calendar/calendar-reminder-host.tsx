/** @jsxImportSource react */
import * as React from "react";
import { Temporal } from "@js-temporal/polyfill";
import { CalendarClock, X } from "lucide-react";

import { currentLocale, t } from "@/i18n";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { resolveCalendarPageGate } from "./calendar-page-gate";
import { useCalendarBootstrapQuery, useCalendarCollaborationQuery, useCalendarSchedulingEventsQuery, useTeamCalendarSnapshotsQuery } from "./calendar-queries";
import { CALENDAR_REMINDER_PREFERENCES_CHANGED, readCalendarReminderMinutes } from "./calendar-reminder-preferences";
import { calendarReminderOccurrences, calendarReminderTick, calendarReminderWindow, planCalendarReminders, REMINDER_GRACE_MS, type CalendarReminder, type CalendarReminderTarget } from "./calendar-reminder-schedule";
import { calendarScopeIdentity, type CalendarScope } from "./calendar-scope";

export type { CalendarReminderTarget } from "./calendar-reminder-schedule";
export type CalendarReminderHostProps = { onOpen: (target: CalendarReminderTarget) => void };
const REFRESH_MS = 60_000;

export function CalendarReminderHost({ onOpen }: CalendarReminderHostProps) {
  const cloud = useCloudSession();
  const gate = resolveCalendarPageGate(cloud);
  // Survives switching away and back during the grace period. Contains keys, never card content.
  const delivered = React.useRef(new Map<string, number>());
  if (gate.kind !== "ready") return null;
  return <ScopedReminders key={calendarScopeIdentity(gate.scope)} scope={gate.scope} supportsTeamCalendars={gate.workspaceKind === "organization"} delivered={delivered.current} onOpen={onOpen} />;
}

function ScopedReminders({ scope, supportsTeamCalendars, delivered, onOpen }: CalendarReminderHostProps & {
  scope: CalendarScope; supportsTeamCalendars: boolean; delivered: Map<string, number>;
}) {
  const { client } = useCloudSession();
  const [tick, wake] = React.useReducer((n: number) => n + 1, 0);
  const [preferenceRevision, preferencesChanged] = React.useReducer((n: number) => n + 1, 0);
  const zone = Temporal.Now.timeZoneId();
  const today = Temporal.Now.plainDateISO(zone).toString();
  const windowRange = React.useMemo(() => calendarReminderWindow(today, zone), [today, zone]);
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  const query = { client, scope, active: online, refetchInterval: REFRESH_MS };
  const bootstrap = useCalendarBootstrapQuery({ ...query, range: windowRange.range });
  const resources = useCalendarCollaborationQuery({ ...query, scope: supportsTeamCalendars ? scope : null });
  const scheduling = useCalendarSchedulingEventsQuery({ ...query, range: windowRange.schedulingRange });
  const readable = React.useMemo(() => resources.isSuccess && supportsTeamCalendars
    ? resources.data.items.filter((c) => c.organizationId === scope.organizationId && c.capabilities.canViewDetails) : [],
    [resources.isSuccess, resources.data, supportsTeamCalendars, scope.organizationId]);
  const teams = useTeamCalendarSnapshotsQuery({ ...query, range: windowRange.range, calendars: readable.filter((c) => c.kind === "team") });

  const occurrences = React.useMemo(() => {
    const personalIds = new Set(supportsTeamCalendars ? readable.filter((c) => c.kind === "personal").map((c) => c.id) : bootstrap.data?.calendars.map((c) => c.id));
    const teamIds = new Set(readable.filter((c) => c.kind === "team").map((c) => c.id));
    const ordinary = bootstrap.isSuccess ? bootstrap.data.events.filter((e) => personalIds.has(e.calendarId)) : [];
    const snapshots = teams.data.flatMap((s) => teamIds.has(s.calendar.id) ? s.events : []);
    const expanded = scheduling.isSuccess ? scheduling.data.items.filter(({ event }) => personalIds.has(event.calendarId) || teamIds.has(event.calendarId)) : [];
    return calendarReminderOccurrences([...ordinary, ...snapshots], expanded);
  }, [bootstrap.data, bootstrap.isSuccess, supportsTeamCalendars, readable, scheduling.data, scheduling.isSuccess, teams.data]);
  const plan = React.useMemo(() => {
    const ids = new Set(occurrences.map(({ event }) => event.id));
    const preferences = new Map(Array.from(ids, (id) => [id, readCalendarReminderMinutes(scope, id)] as const));
    return planCalendarReminders(scope, zone, occurrences, preferences);
  }, [occurrences, scope, zone, preferenceRevision]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener(CALENDAR_REMINDER_PREFERENCES_CHANGED, preferencesChanged);
    window.addEventListener("storage", preferencesChanged);
    for (const event of ["online", "offline", "focus", "pageshow"]) window.addEventListener(event, wake);
    return () => {
      window.removeEventListener(CALENDAR_REMINDER_PREFERENCES_CHANGED, preferencesChanged);
      window.removeEventListener("storage", preferencesChanged);
      for (const event of ["online", "offline", "focus", "pageshow"]) window.removeEventListener(event, wake);
    };
  }, []);

  const [visible, setVisible] = React.useState<readonly string[]>([]);
  const expandedIds = React.useMemo(() => new Set(scheduling.data?.items.map(({ event }) => event.id)), [scheduling.data]);
  const teamIds = React.useMemo(() => new Set(readable.filter((c) => c.kind === "team").map((c) => c.id)), [readable]);
  React.useEffect(() => {
    const now = Date.now();
    for (const [key, at] of delivered) if (at < now - REMINDER_GRACE_MS) delivered.delete(key);
    const { due, nextMs } = calendarReminderTick(plan, now, delivered);
    // Wait for in-flight changes to this source, not an unrelated slow team snapshot.
    const arrivals = online && !(supportsTeamCalendars && resources.isFetching) ? due.filter(({ target }) => {
      if (expandedIds.has(target.eventId)) return !scheduling.isFetching;
      return teamIds.has(target.calendarId) ? !teams.isFetching : !bootstrap.isFetching;
    }) : [];
    for (const r of arrivals) delivered.set(r.key, r.dueMs);
    const valid = new Set(online ? plan.map((r) => r.key) : []);
    setVisible((prev) => {
      // Keep delivered keys while an unresolved workspace switches to the
      // team-aware source. Cards still render only from the current plan.
      if (online && supportsTeamCalendars && resources.isPending) return prev;
      const kept = prev.filter((key) => valid.has(key));
      return !arrivals.length && kept.length === prev.length ? prev : [...kept, ...arrivals.map((r) => r.key)];
    });
    // Cap sleep to detect clock/zone changes; query polling is independent of this deadline.
    const deadline = Math.min(now + REFRESH_MS, windowRange.rolloverMs, nextMs ?? Infinity);
    const timer = setTimeout(wake, Math.max(1, deadline - now));
    return () => clearTimeout(timer);
  }, [tick, plan, online, delivered, windowRange, supportsTeamCalendars, resources.isFetching, resources.isPending, expandedIds, scheduling.isFetching, teamIds, teams.isFetching, bootstrap.isFetching]);

  const shown = new Set(visible);
  const cards = online ? plan.filter((r) => shown.has(r.key)) : [];
  if (!cards.length) return null;
  const dismiss = (key: string) => setVisible((prev) => prev.filter((k) => k !== key));
  return <aside aria-label={t("calendar.reminder_assistant")} aria-live="polite" className="pointer-events-none fixed right-4 top-12 z-50 flex max-h-[80vh] w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto mac:titlebar-no-drag">
    {cards.map((r) => <div key={r.key} className="pointer-events-auto flex items-start rounded-xl border border-dls-border bg-dls-surface text-dls-text shadow-lg">
      <button type="button" className="min-w-0 flex-1 rounded-xl p-3 text-left focus-visible:ring-2 focus-visible:ring-dls-accent" onClick={() => { dismiss(r.key); onOpen(r.target); }}>
        <span className="flex items-center gap-2 text-xs text-dls-secondary"><CalendarClock className="size-4" aria-hidden="true" />{t("calendar.reminder_assistant")}</span>
        <strong className="mt-1 block break-words text-sm">{r.title}</strong>
        <span className="block text-xs text-dls-secondary">{t("calendar.field_start_time")} · {formatStart(r)}</span>
      </button>
      <button type="button" aria-label={t("common.close")} className="m-1 rounded-md p-2 text-dls-secondary hover:text-dls-text" onClick={() => dismiss(r.key)}><X className="size-4" aria-hidden="true" /></button>
    </div>)}
  </aside>;
}

function formatStart(r: CalendarReminder): string {
  const allDay = r.target.startDate !== undefined;
  const formatted = new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium", timeStyle: allDay ? undefined : "short", timeZone: r.timeZone }).format(r.startMs);
  return allDay ? `${formatted} · ${t("calendar.all_day")}` : formatted;
}
