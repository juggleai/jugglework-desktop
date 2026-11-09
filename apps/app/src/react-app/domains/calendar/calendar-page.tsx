/** @jsxImportSource react */
import * as React from "react";
import type { CSSProperties } from "react";
import { CalendarDays, CircleAlert, LoaderCircle, LogIn } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Temporal } from "@js-temporal/polyfill";

import { Button } from "@/components/ui/button";
import { currentLocale, t } from "@/i18n";
import { useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { calendarScopeIdentity, type CalendarScope } from "./calendar-scope";
import { resolveCalendarPageGate, type CalendarPageGate } from "./calendar-page-gate";
import { useCalendarBootstrapQuery, useCalendarsQuery } from "./calendar-queries";
import {
  calendarGridRange,
  calendarMonthGrid,
  calendarToday,
  calendarWeekStart,
  moveCalendarSelection,
  navigateCalendarMonth,
  readHiddenCalendarIds,
  reconcileHiddenCalendarIds,
  selectCalendarDate,
  visibleCalendarIds,
  writeHiddenCalendarIds,
} from "./calendar-month-model";
import { CalendarFilterList, CalendarMiniMonth, CalendarMonthGrid, CalendarMonthToolbar } from "./calendar-month-view";
import { CalendarDayEvents } from "./calendar-day-events";
import { CalendarAgenda, CalendarEventDetail } from "./calendar-agenda";
import { layoutCalendarEvents } from "./calendar-event-layout";
import { CalendarEventEditor } from "./calendar-event-editor";
import { calendarEventToForm, defaultCalendarEventForm } from "./calendar-event-form-model";

export type CalendarPageProps = {
  /** Retained-shell workspace, only forwarded to the navigation rail. Calendar data never depends on it. */
  workspaceId: string;
  sessionPath: string;
  onOpenAccount: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenReviews: () => void;
  onOpenSettings: () => void;
  onOpenTaskSearch?: () => void;
  /** Injectable for deterministic tests; defaults to the system clock and zone. */
  clock?: CalendarClock;
};

export function CalendarPage(props: CalendarPageProps) {
  const cloud = useCloudSession();
  const desktopConfig = useDesktopConfig();
  const gate = resolveCalendarPageGate({
    isSignedIn: cloud.isSignedIn,
    baseUrl: cloud.baseUrl,
    organizationId: cloud.activeOrganization?.id,
    memberId: cloud.activeOrganization?.orgMemberId || cloud.activeOrganization?.membershipId,
    configLoading: desktopConfig.loading,
    calendarEnabled: desktopConfig.config.calendarEnabled,
    calendarWriteEnabled: desktopConfig.config.calendarWriteEnabled,
  });
  // Re-key on scope identity so no state from a previous member/org/deployment survives a switch.
  const scopeKey = gate.kind === "ready" ? calendarScopeIdentity(gate.scope) : gate.kind;
  return (
    <CalendarPageFrame {...props}>
      <CalendarGateContent key={scopeKey ?? "none"} gate={gate} onOpenAccount={props.onOpenAccount} clock={props.clock ?? systemCalendarClock} />
    </CalendarPageFrame>
  );
}

function CalendarPageFrame(props: CalendarPageProps & { children: React.ReactNode }) {
  const navigate = useNavigate();
  const pageStyle = { WebkitAppRegion: "drag" } as CSSProperties;
  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag" style={pageStyle}>
      <AppNavigationRail
        workspaceId={props.workspaceId}
        onOpenAccount={props.onOpenAccount}
        onOpenHome={() => navigate(props.sessionPath)}
        onOpenApps={props.onOpenApps}
        onOpenChat={props.onOpenChat}
        onOpenReviews={props.onOpenReviews}
        onOpenSettings={props.onOpenSettings}
        onOpenTaskSearch={props.onOpenTaskSearch}
      />
      <AppInsetSurface testId="calendar-inset-surface">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="calendar-main">
          <div className="flex h-[54px] shrink-0 items-center border-b border-dls-border px-7">
            <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-dls-text" data-testid="calendar-page-title">
              {t("calendar.title")}
            </h2>
          </div>
          <div className="flex min-h-0 flex-1 overflow-auto">{props.children}</div>
        </main>
      </AppInsetSurface>
    </div>
  );
}

function CalendarGateContent(props: { gate: CalendarPageGate; onOpenAccount: () => void; clock: CalendarClock }) {
  const { gate } = props;
  if (gate.kind === "loading-capability") {
    return (
      <CalendarCenteredState testId="calendar-gate-loading">
        <div className="flex flex-col items-center gap-3 text-center text-dls-secondary" role="status" aria-live="polite">
          <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
          <p className="text-sm">{t("calendar.loading")}</p>
        </div>
      </CalendarCenteredState>
    );
  }
  if (gate.kind === "signed-out" || gate.kind === "no-organization" || gate.kind === "membership-unavailable") {
    const description = gate.kind === "signed-out"
      ? t("calendar.sign_in_required")
      : gate.kind === "no-organization"
        ? t("calendar.organization_required")
        : t("calendar.membership_unavailable");
    return (
      <CalendarCenteredState testId={`calendar-gate-${gate.kind}`}>
        <div className="flex max-w-sm flex-col items-center gap-3 text-center" role="alert">
          <CircleAlert className="size-8 text-dls-secondary" aria-hidden="true" />
          <p className="text-sm text-dls-secondary">{description}</p>
          <Button variant="outline" size="sm" onClick={props.onOpenAccount}>
            <LogIn className="size-4" aria-hidden="true" />
            {t("calendar.open_account")}
          </Button>
        </div>
      </CalendarCenteredState>
    );
  }
  if (gate.kind === "disabled") {
    return (
      <CalendarCenteredState testId="calendar-gate-disabled">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center" role="status">
          <CalendarDays className="size-8 text-dls-secondary" aria-hidden="true" />
          <p className="text-sm text-dls-secondary">{t("calendar.unavailable")}</p>
        </div>
      </CalendarCenteredState>
    );
  }
  return <CalendarReadyView scope={gate.scope} writeEnabled={gate.writeEnabled} clock={props.clock} />;
}

export type CalendarClock = { now: () => Temporal.Instant; timeZone: () => string };

const systemCalendarClock: CalendarClock = {
  now: () => Temporal.Now.instant(),
  timeZone: () => Temporal.Now.timeZoneId(),
};

function CalendarReadyView(props: { scope: CalendarScope; writeEnabled: boolean; clock: CalendarClock }) {
  const cloud = useCloudSession();
  const locale = currentLocale();
  const timeZone = React.useMemo(() => props.clock.timeZone(), [props.clock]);
  const today = React.useMemo(() => calendarToday(timeZone, props.clock.now()), [props.clock, timeZone]);
  const weekStart = React.useMemo(() => calendarWeekStart(locale), [locale]);
  const [navigation, setNavigation] = React.useState(() => selectCalendarDate(today));
  const [hiddenIds, setHiddenIds] = React.useState(() => readHiddenCalendarIds(props.scope));
  const calendarsQuery = useCalendarsQuery({ client: cloud.client, scope: props.scope });
  const calendars = calendarsQuery.data ?? [];
  const activeIds = calendars.map((calendar) => calendar.id);
  const activeKey = activeIds.join("\u0000");

  // Soft-deleted calendars leave the filter list; their hidden-state entry is dropped too.
  React.useEffect(() => {
    if (!calendarsQuery.data) return;
    setHiddenIds((current) => {
      const next = reconcileHiddenCalendarIds(current, activeIds);
      if (next.length === current.length) return current;
      writeHiddenCalendarIds(props.scope, next);
      return next;
    });
  }, [activeKey, calendarsQuery.data, props.scope]);

  const gridRange = React.useMemo(() => calendarGridRange(navigation.month, weekStart), [navigation.month, weekStart]);
  const bootstrapQuery = useCalendarBootstrapQuery({ client: cloud.client, scope: props.scope, range: gridRange });
  const visibleIds = React.useMemo(() => visibleCalendarIds(activeIds, hiddenIds), [activeKey, hiddenIds]);
  const calendarsById = React.useMemo(() => new Map(calendars.map((calendar) => [calendar.id, calendar])), [calendars]);
  const dayEntries = React.useMemo(() => layoutCalendarEvents({
    events: bootstrapQuery.data?.events ?? [],
    days: calendarMonthGrid(navigation.month, weekStart),
    visibleCalendarIds: visibleIds,
  }), [bootstrapQuery.data, navigation.month, visibleIds, weekStart]);

  const [selectedEventId, setSelectedEventId] = React.useState<string | null>(null);
  const eventsById = React.useMemo(
    () => new Map((bootstrapQuery.data?.events ?? []).map((event) => [event.id, event])),
    [bootstrapQuery.data],
  );
  const selectedEvent = selectedEventId ? eventsById.get(selectedEventId) ?? null : null;
  const selectedEventVisible = selectedEvent ? visibleIds.includes(selectedEvent.calendarId) : false;
  // Once fresh data no longer contains the open event (deleted elsewhere, or its calendar removed), close it.
  React.useEffect(() => {
    if (!selectedEventId || !bootstrapQuery.data || bootstrapQuery.isFetching) return;
    if (!selectedEvent || !selectedEventVisible) setSelectedEventId(null);
  }, [bootstrapQuery.data, bootstrapQuery.isFetching, selectedEvent, selectedEventId, selectedEventVisible]);
  const selectedDayEntries = dayEntries.get(navigation.selectedDate.toString()) ?? [];
  const [editor, setEditor] = React.useState<{ mode: "create" } | { mode: "edit"; eventId: string } | null>(null);
  const editingEvent = editor?.mode === "edit" ? eventsById.get(editor.eventId) : undefined;
  const openEvent = (eventId: string, date?: Temporal.PlainDate) => {
    if (date) setNavigation(selectCalendarDate(date));
    setEditor(null);
    setSelectedEventId(eventId);
  };
  const startCreate = () => {
    setSelectedEventId(null);
    setEditor({ mode: "create" });
  };
  const defaultCalendarId = calendars.find((calendar) => calendar.isDefault)?.id ?? calendars[0]?.id ?? "";

  const toggleCalendar = (calendarId: string, visible: boolean) => {
    setHiddenIds((current) => {
      const next = visible ? current.filter((id) => id !== calendarId) : [...new Set([...current, calendarId])];
      writeHiddenCalendarIds(props.scope, next);
      return next;
    });
  };

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4 lg:flex-row"
      data-testid="calendar-ready"
      data-calendar-write-enabled={props.writeEnabled ? "true" : "false"}
      data-visible-calendar-ids={visibleIds.join(",")}
    >
      <aside className="flex shrink-0 flex-col gap-5 lg:w-56" data-testid="calendar-sidebar">
        <CalendarMiniMonth
          state={navigation}
          today={today}
          weekStart={weekStart}
          locale={locale}
          onSelectDate={(date) => setNavigation(selectCalendarDate(date))}
        />
        <CalendarFilterList calendars={calendars} hiddenIds={hiddenIds} onToggle={toggleCalendar} />
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" aria-label={t("calendar.month_view")}>
        <CalendarMonthToolbar
          state={navigation}
          locale={locale}
          onPrevious={() => setNavigation((current) => navigateCalendarMonth(current, -1))}
          onNext={() => setNavigation((current) => navigateCalendarMonth(current, 1))}
          onToday={() => setNavigation(selectCalendarDate(today))}
        />
        {bootstrapQuery.isError ? (
          <p className="text-sm text-dls-secondary" role="alert" data-testid="calendar-events-error">{t("calendar.events_unavailable")}</p>
        ) : null}
        <CalendarMonthGrid
          state={navigation}
          today={today}
          weekStart={weekStart}
          locale={locale}
          onSelectDate={(date) => setNavigation(selectCalendarDate(date))}
          onMoveSelection={(days) => setNavigation((current) => moveCalendarSelection(current, days))}
          renderDayContent={(date) => {
            const key = date.toString();
            const entries = dayEntries.get(key) ?? [];
            if (entries.length === 0) return null;
            return (
              <CalendarDayEvents
                date={key}
                entries={entries}
                calendarsById={calendarsById}
                locale={locale}
                onOpenEvent={(eventId) => openEvent(eventId, date)}
                onShowMore={() => setNavigation(selectCalendarDate(date))}
              />
            );
          }}
        />
      </section>
      <aside className="flex min-h-0 shrink-0 flex-col gap-3 overflow-auto lg:w-72" data-testid="calendar-day-panel">
        <CalendarAgenda
          date={navigation.selectedDate}
          entries={selectedDayEntries}
          calendarsById={calendarsById}
          locale={locale}
          selectedEventId={selectedEventId}
          canCreate={props.writeEnabled && calendars.length > 0}
          onOpenEvent={(eventId) => openEvent(eventId)}
          onCreate={startCreate}
        />
        {editor && props.writeEnabled && (editor.mode === "create" || editingEvent) ? (
          <CalendarEventEditor
            key={editor.mode === "edit" ? `edit:${editor.eventId}` : `create:${navigation.selectedDate.toString()}`}
            client={cloud.client}
            scope={props.scope}
            calendars={calendars}
            timeZone={timeZone}
            event={editingEvent}
            initial={editingEvent
              ? calendarEventToForm(editingEvent)
              : defaultCalendarEventForm({ date: navigation.selectedDate, calendarId: defaultCalendarId, timeZone })}
            onSaved={(event) => { setEditor(null); setSelectedEventId(event.id); }}
            onDeleted={() => { setEditor(null); setSelectedEventId(null); }}
            onCancel={() => setEditor(null)}
          />
        ) : selectedEvent && selectedEventVisible ? (
          <CalendarEventDetail
            event={selectedEvent}
            calendar={calendarsById.get(selectedEvent.calendarId)}
            locale={locale}
            onClose={() => setSelectedEventId(null)}
            onEdit={props.writeEnabled ? () => setEditor({ mode: "edit", eventId: selectedEvent.id }) : undefined}
          />
        ) : null}
      </aside>
    </div>
  );
}

function CalendarCenteredState(props: { testId: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid={props.testId}>
      {props.children}
    </div>
  );
}
