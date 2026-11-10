/** @jsxImportSource react */
import * as React from "react";
import type { CSSProperties } from "react";
import { CalendarDays, ChevronDown, CircleAlert, LoaderCircle, LogIn } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendarEvent } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
import { CalendarDraftList, CalendarOfflineBanner } from "./calendar-offline-view";
import { layoutCalendarEvents } from "./calendar-event-layout";
import { CalendarEventEditor } from "./calendar-event-editor";
import { calendarEventToForm, defaultCalendarEventForm, type CalendarEventFormValues } from "./calendar-event-form-model";
import {
  defaultCalendarOfflineRuntime,
  draftForm,
  eventDraftRecord,
  useCalendarBaselinePersistence,
  useCalendarEventDrafts,
  useCalendarOfflineView,
  useCalendarOnline,
  type CalendarOfflineRuntime,
} from "./calendar-offline-runtime";

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
  /** Injectable connectivity and local cache; defaults to navigator.onLine and IndexedDB. */
  offlineRuntime?: CalendarOfflineRuntime;
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
      <CalendarGateContent key={scopeKey ?? "none"} gate={gate} onOpenAccount={props.onOpenAccount} clock={props.clock ?? systemCalendarClock} offlineRuntime={props.offlineRuntime} />
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

function CalendarGateContent(props: { gate: CalendarPageGate; onOpenAccount: () => void; clock: CalendarClock; offlineRuntime?: CalendarOfflineRuntime }) {
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
  return <CalendarReadyView scope={gate.scope} writeEnabled={gate.writeEnabled} clock={props.clock} offlineRuntime={props.offlineRuntime} />;
}

export type CalendarClock = { now: () => Temporal.Instant; timeZone: () => string };

const systemCalendarClock: CalendarClock = {
  now: () => Temporal.Now.instant(),
  timeZone: () => Temporal.Now.timeZoneId(),
};

function CalendarReadyView(props: { scope: CalendarScope; writeEnabled: boolean; clock: CalendarClock; offlineRuntime?: CalendarOfflineRuntime }) {
  const cloud = useCloudSession();
  const [offlineRuntime] = React.useState(() => props.offlineRuntime ?? defaultCalendarOfflineRuntime());
  const online = useCalendarOnline(offlineRuntime.online);
  const locale = currentLocale();
  const timeZone = React.useMemo(() => props.clock.timeZone(), [props.clock]);
  const today = React.useMemo(() => calendarToday(timeZone, props.clock.now()), [props.clock, timeZone]);
  const weekStart = React.useMemo(() => calendarWeekStart(locale), [locale]);
  const [navigation, setNavigation] = React.useState(() => selectCalendarDate(today));
  const [hiddenIds, setHiddenIds] = React.useState(() => readHiddenCalendarIds(props.scope));
  const calendarsQuery = useCalendarsQuery({ client: cloud.client, scope: props.scope, active: online });
  const gridRange = React.useMemo(() => calendarGridRange(navigation.month, weekStart), [navigation.month, weekStart]);
  const bootstrapQuery = useCalendarBootstrapQuery({ client: cloud.client, scope: props.scope, range: gridRange, active: online });
  useCalendarBaselinePersistence({ runtime: offlineRuntime, scope: props.scope, bootstrap: bootstrapQuery.data, online });
  const offlineView = useCalendarOfflineView({ runtime: offlineRuntime, scope: props.scope, range: gridRange, online });
  const eventDrafts = useCalendarEventDrafts(offlineRuntime, props.scope);
  // Offline shows only what the scoped local cache fully covers; in-memory online results are not reused.
  const calendars = online
    ? calendarsQuery.data ?? []
    : offlineView.state === "offline-covered" || offlineView.state === "offline-uncovered" ? offlineView.calendars : [];
  const sourceEvents = online
    ? bootstrapQuery.data?.events
    : offlineView.state === "offline-covered" ? offlineView.events : undefined;
  const activeIds = calendars.map((calendar) => calendar.id);
  const activeKey = activeIds.join("\u0000");

  // Soft-deleted calendars leave the filter list; their hidden-state entry is dropped too.
  React.useEffect(() => {
    if (!online || !calendarsQuery.data) return;
    setHiddenIds((current) => {
      const next = reconcileHiddenCalendarIds(current, activeIds);
      if (next.length === current.length) return current;
      writeHiddenCalendarIds(props.scope, next);
      return next;
    });
  }, [activeKey, calendarsQuery.data, online, props.scope]);

  const visibleIds = React.useMemo(() => visibleCalendarIds(activeIds, hiddenIds), [activeKey, hiddenIds]);
  const calendarsById = React.useMemo(() => new Map(calendars.map((calendar) => [calendar.id, calendar])), [calendars]);
  const dayEntries = React.useMemo(() => layoutCalendarEvents({
    events: sourceEvents ?? [],
    days: calendarMonthGrid(navigation.month, weekStart),
    visibleCalendarIds: visibleIds,
  }), [navigation.month, sourceEvents, visibleIds, weekStart]);

  const [selectedEventId, setSelectedEventId] = React.useState<string | null>(null);
  const eventsById = React.useMemo(
    () => new Map((sourceEvents ?? []).map((event) => [event.id, event])),
    [sourceEvents],
  );
  const selectedEvent = selectedEventId ? eventsById.get(selectedEventId) ?? null : null;
  const selectedEventVisible = selectedEvent ? visibleIds.includes(selectedEvent.calendarId) : false;
  // Once fresh data no longer contains the open event (deleted elsewhere, or its calendar removed), close it.
  React.useEffect(() => {
    if (!selectedEventId || !sourceEvents || (online && bootstrapQuery.isFetching)) return;
    if (!selectedEvent || !selectedEventVisible) setSelectedEventId(null);
  }, [bootstrapQuery.isFetching, online, selectedEvent, selectedEventId, selectedEventVisible, sourceEvents]);
  const selectedDayEntries = dayEntries.get(navigation.selectedDate.toString()) ?? [];
  const [editor, setEditor] = React.useState<
    | { mode: "create"; instance: number; draftId?: string; form?: CalendarEventFormValues }
    | { mode: "edit"; instance: number; eventId: string; draftId?: string; form?: CalendarEventFormValues; draftBaseVersion?: number }
    | null
  >(null);
  // Remount the form only when a different editing session starts, never when its draft is saved.
  const editorInstance = React.useRef(0);
  const nextEditorInstance = () => ++editorInstance.current;
  const editingEvent = editor?.mode === "edit" ? eventsById.get(editor.eventId) : undefined;
  const draftsAvailable = eventDrafts.available;
  const saveEditorDraft = draftsAvailable ? async (form: CalendarEventFormValues, base: DenCalendarEvent | undefined) => {
    const id = editor?.draftId ?? createCalendarDraftId();
    await eventDrafts.save(eventDraftRecord({ id, form, base: base ? { id: base.id, version: editor?.mode === "edit" && editor.draftBaseVersion !== undefined && editor.draftId === id ? editor.draftBaseVersion : base.version } : undefined }));
    setEditor((current) => current ? { ...current, draftId: id, form } : current);
  } : undefined;
  const restoreDraft = (draftId: string) => {
    if (!panelOpen) rememberOpener();
    const draft = eventDrafts.drafts.find((item) => item.id === draftId);
    const form = draft ? draftForm(draft) : null;
    if (!draft || !form) return;
    setSelectedEventId(null);
    setEditor(draft.operation === "edit"
      ? { mode: "edit", instance: nextEditorInstance(), eventId: draft.baseEntity.id, draftId, form, draftBaseVersion: draft.baseEntity.version }
      : { mode: "create", instance: nextEditorInstance(), draftId, form });
  };
  const openEvent = (eventId: string, date?: Temporal.PlainDate) => {
    if (!panelOpen) rememberOpener();
    if (date) setNavigation(selectCalendarDate(date));
    setEditor(null);
    setSelectedEventId(eventId);
  };
  const startCreate = () => {
    if (!panelOpen) rememberOpener();
    setSelectedEventId(null);
    setEditor({ mode: "create", instance: nextEditorInstance() });
  };
  const closeEditorAfterAuthoritativeSave = async (draftId: string | undefined) => {
    // The draft is removed only after the cloud accepted the write.
    if (draftId) await eventDrafts.discard(draftId).catch(() => undefined);
  };
  // Writes are possible online; offline the form opens only to keep an unsynced local draft.
  const canOpenEditor = props.writeEnabled && (online || draftsAvailable);
  const defaultCalendarId = calendars.find((calendar) => calendar.isDefault)?.id ?? calendars[0]?.id ?? "";

  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const panelOpener = React.useRef<HTMLElement | null>(null);
  const panelOpen = editor !== null || (selectedEvent !== null && selectedEventVisible);
  const wasPanelOpen = React.useRef(panelOpen);
  const rememberOpener = () => {
    const doc = focusableDocument();
    if (!doc) return;
    const active = doc.activeElement;
    if (active instanceof HTMLElement && active !== doc.body) panelOpener.current = active;
  };
  React.useEffect(() => {
    const closed = wasPanelOpen.current && !panelOpen;
    wasPanelOpen.current = panelOpen;
    if (!closed) return;
    const doc = focusableDocument();
    const opener = panelOpener.current;
    panelOpener.current = null;
    if (!doc) return;
    // The opener may be gone (e.g. its event was deleted); fall back to the selected date in the grid.
    const target = opener && opener.isConnected ? opener : doc.querySelector<HTMLElement>('[data-calendar-selected-day="true"]');
    target?.focus();
  }, [panelOpen]);
  const toggleCalendar = (calendarId: string, visible: boolean) => {
    setHiddenIds((current) => {
      const next = visible ? current.filter((id) => id !== calendarId) : [...new Set([...current, calendarId])];
      writeHiddenCalendarIds(props.scope, next);
      return next;
    });
  };

  return (
    <div
      className="@container/calendar flex min-h-0 min-w-0 flex-1 overflow-y-auto"
      data-testid="calendar-layout"
    >
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3 @3xl/calendar:p-4 @5xl/calendar:flex-row"
      data-testid="calendar-ready"
      data-calendar-write-enabled={props.writeEnabled ? "true" : "false"}
      data-visible-calendar-ids={visibleIds.join(",")}
    >
      {/* Narrow: the filters collapse behind a disclosure and the mini month is hidden (the toolbar and
          main grid already provide month navigation and date selection). */}
      <aside className="order-2 flex shrink-0 flex-col gap-3 @5xl/calendar:order-none @5xl/calendar:w-56 @5xl/calendar:gap-5" aria-label={t("calendar.sidebar")} data-testid="calendar-sidebar">
        <div className="hidden @5xl/calendar:block" data-testid="calendar-mini-month-slot">
        <CalendarMiniMonth
          state={navigation}
          today={today}
          weekStart={weekStart}
          locale={locale}
          onSelectDate={(date) => setNavigation(selectCalendarDate(date))}
        />
        </div>
        <button
          type="button"
          className="flex items-center gap-1 self-start rounded-lg px-1 py-1 text-sm font-medium text-dls-text hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 @5xl/calendar:hidden"
          aria-expanded={filtersOpen}
          aria-controls="calendar-filter-region"
          onClick={() => setFiltersOpen((open) => !open)}
          data-testid="calendar-filter-toggle"
        >
          <ChevronDown className={cn("size-4 transition-transform", filtersOpen && "rotate-180")} aria-hidden="true" />
          {t("calendar.filter_title")}
        </button>
        <div id="calendar-filter-region" className={cn(filtersOpen ? "block" : "hidden", "@5xl/calendar:block")} data-testid="calendar-filter-region">
          <CalendarFilterList calendars={calendars} hiddenIds={hiddenIds} onToggle={toggleCalendar} />
        </div>
      </aside>
      <section className="order-1 flex min-h-[26rem] min-w-0 flex-1 flex-col gap-3 @5xl/calendar:order-none @5xl/calendar:min-h-0" aria-label={t("calendar.month_view")}>
        <CalendarMonthToolbar
          state={navigation}
          locale={locale}
          onPrevious={() => setNavigation((current) => navigateCalendarMonth(current, -1))}
          onNext={() => setNavigation((current) => navigateCalendarMonth(current, 1))}
          onToday={() => setNavigation(selectCalendarDate(today))}
        />
        {!online ? <CalendarOfflineBanner view={offlineView} locale={locale} /> : null}
        {online && bootstrapQuery.isError ? (
          <p className="text-sm text-dls-secondary" role="alert" data-testid="calendar-events-error">{t("calendar.events_unavailable")}</p>
        ) : null}
        <CalendarMonthGrid
          state={navigation}
          today={today}
          weekStart={weekStart}
          locale={locale}
          onSelectDate={(date) => setNavigation(selectCalendarDate(date))}
          onMoveSelection={(days) => setNavigation((current) => moveCalendarSelection(current, days))}
          renderDayContent={(date, selected) => {
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
                focusable={selected}
              />
            );
          }}
        />
      </section>
      <aside className="order-3 flex shrink-0 flex-col gap-3 @5xl/calendar:order-none @5xl/calendar:min-h-0 @5xl/calendar:w-72 @5xl/calendar:overflow-auto" aria-label={t("calendar.day_panel")} data-testid="calendar-day-panel">
        <CalendarAgenda
          date={navigation.selectedDate}
          entries={selectedDayEntries}
          calendarsById={calendarsById}
          locale={locale}
          selectedEventId={selectedEventId}
          canCreate={canOpenEditor && calendars.length > 0}
          onOpenEvent={(eventId) => openEvent(eventId)}
          onCreate={startCreate}
        />
        {eventDrafts.drafts.length > 0 ? (
          <CalendarDraftList
            drafts={eventDrafts.drafts}
            eventsById={eventsById}
            activeDraftId={editor?.draftId}
            onRestore={restoreDraft}
            onDiscard={(draftId) => {
              void eventDrafts.discard(draftId);
              if (editor?.draftId === draftId) setEditor(null);
            }}
          />
        ) : null}
        {editor && canOpenEditor && (editor.mode === "create" || editingEvent) ? (
          <CalendarEventEditor
            key={`editor:${editor.instance}`}
            client={cloud.client}
            scope={props.scope}
            calendars={calendars}
            timeZone={timeZone}
            event={editingEvent}
            initial={editor.form ?? (editingEvent
              ? calendarEventToForm(editingEvent)
              : defaultCalendarEventForm({ date: navigation.selectedDate, calendarId: defaultCalendarId, timeZone }))}
            online={online}
            onSaveDraft={saveEditorDraft}
            restoredFromDraft={Boolean(editor.draftId)}
            staleDraftBase={editor.mode === "edit" && editor.draftBaseVersion !== undefined && editingEvent !== undefined && editor.draftBaseVersion !== editingEvent.version}
            onDiscardDraft={editor.draftId ? () => {
              const draftId = editor.draftId!;
              void eventDrafts.discard(draftId);
              setEditor(null);
            } : undefined}
            onSaved={(event) => { void closeEditorAfterAuthoritativeSave(editor.draftId); setEditor(null); setSelectedEventId(event.id); }}
            onDeleted={() => { void closeEditorAfterAuthoritativeSave(editor.draftId); setEditor(null); setSelectedEventId(null); }}
            onCancel={() => setEditor(null)}
          />
        ) : selectedEvent && selectedEventVisible ? (
          <CalendarEventDetail
            event={selectedEvent}
            calendar={calendarsById.get(selectedEvent.calendarId)}
            locale={locale}
            onClose={() => setSelectedEventId(null)}
            onEdit={canOpenEditor ? () => setEditor({ mode: "edit", instance: nextEditorInstance(), eventId: selectedEvent.id }) : undefined}
          />
        ) : null}
      </aside>
    </div>
    </div>
  );
}

/** Focus restoration is a progressive enhancement: skip it when no usable DOM is present. */
function focusableDocument(): Document | null {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return null;
  return typeof document.querySelector === "function" ? document : null;
}

function createCalendarDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? `draft-${crypto.randomUUID()}` : `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function CalendarCenteredState(props: { testId: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid={props.testId}>
      {props.children}
    </div>
  );
}
