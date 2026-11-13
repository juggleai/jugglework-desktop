/** @jsxImportSource react */
import * as React from "react";
import type { CSSProperties } from "react";
import { CalendarDays, CalendarPlus, ChevronDown, CircleAlert, LoaderCircle, LogIn, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Temporal } from "@js-temporal/polyfill";

import { denCalendarFromCollaborationResource, type DenCalendarEvent, type DenCalendarSchedulingEvent } from "@/app/lib/den";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";
import { useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { calendarScopeIdentity, type CalendarScope } from "./calendar-scope";
import { resolveCalendarPageGate, type CalendarPageGate } from "./calendar-page-gate";
import { useCalendarBootstrapQuery, useCalendarCollaborationQuery, useCalendarsQuery, useCalendarSchedulingEventsQuery, useTeamCalendarSnapshotsQuery } from "./calendar-queries";
import {
  calendarToday,
  calendarWeekStart,
  moveCalendarSelection,
  readHiddenCalendarIds,
  reconcileHiddenCalendarIds,
  selectCalendarDate,
  visibleCalendarIds,
  writeHiddenCalendarIds,
} from "./calendar-month-model";
import { CalendarFilterList, CalendarMiniMonth, CalendarMonthGrid } from "./calendar-month-view";
import { CalendarDayEvents } from "./calendar-day-events";
import { CalendarEventDetail } from "./calendar-agenda";
import { CalendarDraftList, CalendarOfflineBanner } from "./calendar-offline-view";
import { layoutCalendarEvents } from "./calendar-event-layout";
import { CalendarEventEditor } from "./calendar-event-editor";
import { CalendarTimeView } from "./calendar-time-view";
import { CalendarViewToolbar } from "./calendar-view-toolbar";
import { CalendarCreateDialog } from "./calendar-create-dialog";
import { CalendarMembersDialog } from "./calendar-members-dialog";
import { calendarViewDays, calendarViewRange, navigateCalendarView, type CalendarViewMode } from "./calendar-view-model";
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

type CalendarPageHeaderAction = { onCreate: () => void };
const CalendarPageHeaderActionContext = React.createContext<React.Dispatch<React.SetStateAction<CalendarPageHeaderAction | null>> | null>(null);

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
      <CalendarGateContent key={scopeKey ?? "none"} gate={gate} collaborationEnabled={desktopConfig.config.calendarCollaborationEnabled === true} onOpenAccount={props.onOpenAccount} clock={props.clock ?? systemCalendarClock} offlineRuntime={props.offlineRuntime} />
    </CalendarPageFrame>
  );
}

function CalendarPageFrame(props: CalendarPageProps & { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [headerAction, setHeaderAction] = React.useState<CalendarPageHeaderAction | null>(null);
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
          <div className="flex h-[54px] shrink-0 items-center justify-between gap-4 border-b border-dls-border px-7" data-testid="calendar-page-header">
            <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-dls-text" data-testid="calendar-page-title">
              {t("calendar.title")}
            </h2>
            <div className="flex items-center mac:titlebar-no-drag" data-testid="calendar-page-actions">
              {headerAction ? (
                <button type="button" className={buttonVariants({ size: "sm" })} onClick={headerAction.onCreate} data-testid="calendar-create-event">
                  <CalendarPlus className="size-4" aria-hidden="true" />
                  {t("calendar.create_event")}
                </button>
              ) : null}
            </div>
          </div>
          <CalendarPageHeaderActionContext.Provider value={setHeaderAction}>
            <div className="flex min-h-0 flex-1 overflow-auto">{props.children}</div>
          </CalendarPageHeaderActionContext.Provider>
        </main>
      </AppInsetSurface>
    </div>
  );
}

function CalendarGateContent(props: { gate: CalendarPageGate; collaborationEnabled: boolean; onOpenAccount: () => void; clock: CalendarClock; offlineRuntime?: CalendarOfflineRuntime }) {
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
  return <CalendarReadyView scope={gate.scope} writeEnabled={gate.writeEnabled} collaborationEnabled={props.collaborationEnabled} clock={props.clock} offlineRuntime={props.offlineRuntime} />;
}

export type CalendarClock = { now: () => Temporal.Instant; timeZone: () => string };

const systemCalendarClock: CalendarClock = {
  now: () => Temporal.Now.instant(),
  timeZone: () => Temporal.Now.timeZoneId(),
};

function CalendarReadyView(props: { scope: CalendarScope; writeEnabled: boolean; collaborationEnabled: boolean; clock: CalendarClock; offlineRuntime?: CalendarOfflineRuntime }) {
  const cloud = useCloudSession();
  const setHeaderAction = React.useContext(CalendarPageHeaderActionContext);
  const [offlineRuntime] = React.useState(() => props.offlineRuntime ?? defaultCalendarOfflineRuntime());
  const online = useCalendarOnline(offlineRuntime.online);
  const locale = currentLocale();
  const timeZone = React.useMemo(() => props.clock.timeZone(), [props.clock]);
  const today = React.useMemo(() => calendarToday(timeZone, props.clock.now()), [props.clock, timeZone]);
  const weekStart = React.useMemo(() => calendarWeekStart(locale), [locale]);
  const [navigation, setNavigation] = React.useState(() => selectCalendarDate(today));
  const [view, setView] = React.useState<CalendarViewMode>("month");
  const [hiddenIds, setHiddenIds] = React.useState(() => readHiddenCalendarIds(props.scope));
  const calendarsQuery = useCalendarsQuery({ client: cloud.client, scope: props.scope, active: online && !props.collaborationEnabled });
  const collaborationQuery = useCalendarCollaborationQuery({ client: cloud.client, scope: props.scope, active: online && props.collaborationEnabled });
  const visibleDays = React.useMemo(() => calendarViewDays(navigation.selectedDate, view, weekStart), [navigation.selectedDate, view, weekStart]);
  const visibleRange = React.useMemo(() => calendarViewRange(navigation.selectedDate, view, weekStart), [navigation.selectedDate, view, weekStart]);
  const schedulingRange = React.useMemo(() => ({
    startInstant: Temporal.PlainDate.from(visibleRange.startDate).toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from("00:00") }).toInstant().toString(),
    endInstantExclusive: Temporal.PlainDate.from(visibleRange.endDateExclusive).toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from("00:00") }).toInstant().toString(),
    timeZone,
  }), [timeZone, visibleRange.endDateExclusive, visibleRange.startDate]);
  const bootstrapQuery = useCalendarBootstrapQuery({ client: cloud.client, scope: props.scope, range: visibleRange, active: online });
  const schedulingQuery = useCalendarSchedulingEventsQuery({ client: cloud.client, scope: props.scope, range: schedulingRange, active: online });
  const offlineView = useCalendarOfflineView({ runtime: offlineRuntime, scope: props.scope, range: visibleRange, online });
  const eventDrafts = useCalendarEventDrafts(offlineRuntime, props.scope);
  // Offline shows only what the scoped local cache fully covers; in-memory online results are not reused.
  const collaborationResources = props.collaborationEnabled ? collaborationQuery.data?.items ?? [] : [];
  const calendars = online
    ? props.collaborationEnabled ? collaborationResources.map(denCalendarFromCollaborationResource) : calendarsQuery.data ?? []
    : offlineView.state === "offline-covered" || offlineView.state === "offline-uncovered" ? offlineView.calendars : [];
  const activeIds = calendars.map((calendar) => calendar.id);
  const activeKey = activeIds.join("\u0000");
  const visibleIds = React.useMemo(() => visibleCalendarIds(activeIds, hiddenIds), [activeKey, hiddenIds]);
  const visibleTeamDetailCalendars = collaborationResources.filter((calendar) => calendar.kind === "team" && calendar.capabilities.canViewDetails && visibleIds.includes(calendar.id)).map(({ id, authorizationVersion }) => ({ id, authorizationVersion }));
  const teamSnapshotsQuery = useTeamCalendarSnapshotsQuery({ client: cloud.client, scope: props.scope, calendars: visibleTeamDetailCalendars, range: visibleRange, active: online && props.collaborationEnabled });
  const teamEvents = teamSnapshotsQuery.data?.flatMap((snapshot) => snapshot.events) ?? [];
  const schedulingOccurrences = schedulingQuery.data?.items ?? [];
  const schedulingMetadataReady = online && schedulingQuery.isSuccess && !schedulingQuery.isFetching;
  const schedulingEventIds = new Set(schedulingOccurrences.map((occurrence) => occurrence.event.id));
  const schedulingEvents = schedulingOccurrences.map((occurrence) => occurrence.event.recurrence
    ? { ...occurrence.event, id: schedulingOccurrenceId(occurrence.event.id, occurrence.occurrenceIndex), time: occurrence.time }
    : { ...occurrence.event, time: occurrence.time });
  const schedulingOccurrenceIds = new Set(schedulingOccurrences
    .filter((occurrence) => occurrence.event.recurrence !== null)
    .map((occurrence) => schedulingOccurrenceId(occurrence.event.id, occurrence.occurrenceIndex)));
  const baseOnlineEvents = [...new Map([...(bootstrapQuery.data?.events ?? []), ...teamEvents]
    .filter((event) => !schedulingEventIds.has(event.id) && !("attendees" in event))
    .map((event) => [event.id, event])).values()];
  const onlineEvents = [...baseOnlineEvents, ...schedulingEvents];
  const persistedBootstrap = React.useMemo(() => {
    if (!bootstrapQuery.data) return undefined;
    // A scheduling outage must not prevent the ordinary Calendar baseline from
    // remaining available offline. Online edit/delete authority still stays
    // fail-closed through schedulingMetadataReady below.
    if (schedulingQuery.isError) return bootstrapQuery.data;
    if (!schedulingMetadataReady) return undefined;
    const persistedOccurrences = schedulingQuery.data?.items ?? [];
    const persistedSchedulingIds = new Set(persistedOccurrences.map((occurrence) => occurrence.event.id));
    const events = [
      ...bootstrapQuery.data.events.filter((event) => !persistedSchedulingIds.has(event.id) && !isSchedulingAggregate(event)),
      ...persistedOccurrences.map((occurrence) => occurrence.event.recurrence
        ? { ...occurrence.event, id: schedulingOccurrenceId(occurrence.event.id, occurrence.occurrenceIndex), time: occurrence.time }
        : { ...occurrence.event, time: occurrence.time }),
    ];
    return { ...bootstrapQuery.data, events };
  }, [bootstrapQuery.data, schedulingMetadataReady, schedulingQuery.data, schedulingQuery.isError]);
  useCalendarBaselinePersistence({ runtime: offlineRuntime, scope: props.scope, bootstrap: persistedBootstrap, online });
  const sourceEvents = online
    ? onlineEvents
    : offlineView.state === "offline-covered" ? offlineView.events : undefined;

  // Soft-deleted calendars leave the filter list; their hidden-state entry is dropped too.
  React.useEffect(() => {
    if (!online || !(props.collaborationEnabled ? collaborationQuery.data : calendarsQuery.data)) return;
    setHiddenIds((current) => {
      const next = reconcileHiddenCalendarIds(current, activeIds);
      if (next.length === current.length) return current;
      writeHiddenCalendarIds(props.scope, next);
      return next;
    });
  }, [activeKey, calendarsQuery.data, collaborationQuery.data, online, props.collaborationEnabled, props.scope]);

  const calendarsById = React.useMemo(() => new Map(calendars.map((calendar) => [calendar.id, calendar])), [calendars]);
  const resourcesById = React.useMemo(() => new Map(collaborationResources.map((calendar) => [calendar.id, calendar])), [collaborationResources]);
  const teamCalendarIds = React.useMemo(() => new Set(collaborationResources.filter((calendar) => calendar.kind === "team").map((calendar) => calendar.id)), [collaborationResources]);
  const writableCalendars = React.useMemo(() => calendars.filter((calendar) => {
    if (!props.writeEnabled) return false;
    const resource = resourcesById.get(calendar.id);
    return props.collaborationEnabled ? resource?.capabilities.canEditEvents === true : true;
  }), [calendars, props.collaborationEnabled, props.writeEnabled, resourcesById]);
  const dayEntries = React.useMemo(() => layoutCalendarEvents({
    events: sourceEvents ?? [],
    days: visibleDays,
    visibleCalendarIds: visibleIds,
  }), [sourceEvents, visibleDays, visibleIds]);

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
  const [editor, setEditor] = React.useState<
    | { mode: "create"; instance: number; draftId?: string; form?: CalendarEventFormValues }
    | { mode: "edit"; instance: number; eventId: string; draftId?: string; form?: CalendarEventFormValues; draftBaseVersion?: number }
    | null
  >(null);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [createCalendarOpen, setCreateCalendarOpen] = React.useState(false);
  const [membersCalendarId, setMembersCalendarId] = React.useState<string | null>(null);
  const membersDialogOpener = React.useRef<HTMLElement | null>(null);
  const panelOpener = React.useRef<HTMLElement | null>(null);
  const createDialogOpen = editor?.mode === "create";
  const sidePanelOpen = editor?.mode === "edit" || (selectedEvent !== null && selectedEventVisible);
  const interactionSurfaceOpen = createDialogOpen || sidePanelOpen;
  const wasInteractionSurfaceOpen = React.useRef(interactionSurfaceOpen);
  const rememberOpener = () => {
    const doc = focusableDocument();
    if (!doc) return;
    const active = doc.activeElement;
    if (isFocusableElement(active) && active !== doc.body) panelOpener.current = active;
  };
  // Remount the form only when a different editing session starts, never when its draft is saved.
  const editorInstance = React.useRef(0);
  const nextEditorInstance = () => ++editorInstance.current;
  const editingEvent = editor?.mode === "edit" ? eventsById.get(editor.eventId) : undefined;
  const editingEventAllowed = editingEvent
    ? online
      ? teamCalendarIds.has(editingEvent.calendarId) || schedulingMetadataReady
      : !("attendees" in editingEvent)
    : false;
  React.useEffect(() => {
    if (!online && editingEvent && "attendees" in editingEvent) setEditor(null);
  }, [editingEvent, online]);
  const draftsAvailable = eventDrafts.available;
  const saveEditorDraft = draftsAvailable ? async (form: CalendarEventFormValues, base: DenCalendarEvent | undefined) => {
    const id = editor?.draftId ?? createCalendarDraftId();
    await eventDrafts.save(eventDraftRecord({ id, form, base: base ? { id: base.id, version: editor?.mode === "edit" && editor.draftBaseVersion !== undefined && editor.draftId === id ? editor.draftBaseVersion : base.version } : undefined }));
    setEditor((current) => current ? { ...current, draftId: id, form } : current);
  } : undefined;
  const restoreDraft = (draftId: string) => {
    if (!interactionSurfaceOpen) rememberOpener();
    const draft = eventDrafts.drafts.find((item) => item.id === draftId);
    const form = draft ? draftForm(draft) : null;
    if (!draft || !form) return;
    const event = draft.operation === "edit" ? eventsById.get(draft.baseEntity.id) : undefined;
    if (draft.operation === "edit" && event && !online && "attendees" in event) {
      setSelectedEventId(event.id);
      setEditor(null);
      return;
    }
    if (draft.operation === "edit" && online && !schedulingMetadataReady) {
      if (!event || !teamCalendarIds.has(event.calendarId)) {
        setSelectedEventId(event?.id ?? null);
        setEditor(null);
        return;
      }
    }
    const restoredForm = event ? preserveAuthoritativeSchedulingAttendees(form, event) : form;
    setSelectedEventId(null);
    setEditor(draft.operation === "edit"
      ? { mode: "edit", instance: nextEditorInstance(), eventId: draft.baseEntity.id, draftId, form: restoredForm, draftBaseVersion: draft.baseEntity.version }
      : { mode: "create", instance: nextEditorInstance(), draftId, form: restoredForm });
  };
  const openEvent = (eventId: string, date?: Temporal.PlainDate) => {
    if (!interactionSurfaceOpen) rememberOpener();
    if (date) setNavigation(selectCalendarDate(date));
    setEditor(null);
    setSelectedEventId(eventId);
  };
  const startCreate = () => {
    if (!interactionSurfaceOpen) rememberOpener();
    setSelectedEventId(null);
    setEditor({ mode: "create", instance: nextEditorInstance() });
  };
  const closeEditorAfterAuthoritativeSave = async (draftId: string | undefined) => {
    // The draft is removed only after the cloud accepted the write.
    if (draftId) await eventDrafts.discard(draftId).catch(() => undefined);
  };
  // Writes are possible online; offline the form opens only to keep an unsynced local draft.
  const canOpenEditor = writableCalendars.length > 0 && (online || draftsAvailable);
  const authoritativeDefaultCalendarId = bootstrapQuery.data?.calendars.find((calendar) => calendar.isDefault)?.id ?? null;
  const defaultCalendarId = writableCalendars.find((calendar) => calendar.id === authoritativeDefaultCalendarId)?.id ?? "";
  const canCreateEvent = canOpenEditor && defaultCalendarId !== "";
  const startCreateRef = React.useRef(startCreate);
  startCreateRef.current = startCreate;
  const openCreateFromHeader = React.useCallback(() => startCreateRef.current(), []);
  React.useEffect(() => {
    if (!setHeaderAction) return;
    const action = canCreateEvent ? { onCreate: openCreateFromHeader } : null;
    setHeaderAction(action);
    return () => setHeaderAction((current) => current?.onCreate === openCreateFromHeader ? null : current);
  }, [canCreateEvent, openCreateFromHeader, setHeaderAction]);

  const currentUserDisplayName = cloud.user?.name?.trim() || cloud.user?.account?.trim() || "";
  const editorCalendars = React.useMemo(() => writableCalendars.map((calendar) => calendar.id === authoritativeDefaultCalendarId && currentUserDisplayName ? { ...calendar, name: currentUserDisplayName } : calendar), [authoritativeDefaultCalendarId, currentUserDisplayName, writableCalendars]);

  React.useEffect(() => {
    if (!props.writeEnabled && createCalendarOpen) setCreateCalendarOpen(false);
  }, [createCalendarOpen, props.writeEnabled]);
  const closeMembersDialog = React.useCallback(() => {
    setMembersCalendarId(null);
    const opener = membersDialogOpener.current;
    membersDialogOpener.current = null;
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus();
      else focusableDocument()?.querySelector<HTMLElement>('[data-calendar-selected-day="true"]')?.focus();
    });
  }, []);
  const membersCalendar = membersCalendarId ? resourcesById.get(membersCalendarId) : undefined;
  React.useEffect(() => {
    if (membersCalendarId && (!membersCalendar || !membersCalendar.capabilities.canManage || !props.writeEnabled)) closeMembersDialog();
  }, [closeMembersDialog, membersCalendar, membersCalendarId, props.writeEnabled]);
  React.useEffect(() => {
    const closed = wasInteractionSurfaceOpen.current && !interactionSurfaceOpen;
    wasInteractionSurfaceOpen.current = interactionSurfaceOpen;
    if (!closed) return;
    const doc = focusableDocument();
    const opener = panelOpener.current;
    panelOpener.current = null;
    if (!doc) return;
    // The opener may be gone (e.g. its event was deleted); fall back to the selected date in the grid.
    const target = opener && opener.isConnected ? opener : doc.querySelector<HTMLElement>('[data-calendar-selected-day="true"]');
    target?.focus();
  }, [interactionSurfaceOpen]);
  const toggleCalendar = (calendarId: string, visible: boolean) => {
    setHiddenIds((current) => {
      const next = visible ? current.filter((id) => id !== calendarId) : [...new Set([...current, calendarId])];
      writeHiddenCalendarIds(props.scope, next);
      return next;
    });
  };

  return (
    <div
      className="@container/calendar relative flex min-h-0 min-w-0 flex-1 overflow-y-auto"
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
          onPrevious={() => setNavigation((current) => selectCalendarDate(current.selectedDate.subtract({ months: 1 })))}
          onNext={() => setNavigation((current) => selectCalendarDate(current.selectedDate.add({ months: 1 })))}
        />
        </div>
        <Button type="button" variant="outline" size="sm" className="justify-start" disabled={!online || !props.writeEnabled} onClick={() => setCreateCalendarOpen(true)} data-testid="calendar-add-calendar">
          <Plus className="size-4" aria-hidden="true" />
          {t("calendar.add_calendar")}
        </Button>
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
          <CalendarFilterList calendars={calendars.map((calendar) => {
            const resource = resourcesById.get(calendar.id);
            return {
              calendar: calendar.id === authoritativeDefaultCalendarId && currentUserDisplayName
                ? { ...calendar, name: currentUserDisplayName }
                : calendar,
              managed: !resource || resource.kind === "personal" || resource.capabilities.canManage,
              onManageMembers: props.writeEnabled && resource?.kind === "team" && resource.capabilities.canManage ? () => {
                const doc = focusableDocument();
                if (isFocusableElement(doc?.activeElement)) membersDialogOpener.current = doc.activeElement;
                setMembersCalendarId(resource.id);
              } : undefined,
            };
          })} hiddenIds={hiddenIds} onToggle={toggleCalendar} />
        </div>
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
      </aside>
      <section className="order-1 flex min-h-[26rem] min-w-0 flex-1 flex-col gap-3 @5xl/calendar:order-none @5xl/calendar:min-h-0" aria-label={t(`calendar.${view}_view`)} data-testid="calendar-view-region">
        <CalendarViewToolbar
          view={view}
          selectedDate={navigation.selectedDate}
          days={visibleDays}
          locale={locale}
          onPrevious={() => setNavigation((current) => selectCalendarDate(navigateCalendarView(current.selectedDate, view, -1)))}
          onNext={() => setNavigation((current) => selectCalendarDate(navigateCalendarView(current.selectedDate, view, 1)))}
          onToday={() => setNavigation(selectCalendarDate(today))}
          onViewChange={setView}
        />
        {!online ? <CalendarOfflineBanner view={offlineView} locale={locale} /> : null}
        {online && bootstrapQuery.isError ? (
          <p className="text-sm text-dls-secondary" role="alert" data-testid="calendar-events-error">{t("calendar.events_unavailable")}</p>
        ) : null}
        {online && teamSnapshotsQuery.isError ? (
          <p className="text-sm text-dls-secondary" role="alert" data-testid="calendar-team-events-error">{t("calendar.events_unavailable")}</p>
        ) : null}
        {online && schedulingQuery.isError ? (
          <p className="text-sm text-dls-secondary" role="alert" data-testid="calendar-scheduling-events-error">{t("calendar.scheduling_events_unavailable")}</p>
        ) : null}
        {view === "month" ? (
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
        ) : (
          <CalendarTimeView
            view={view}
            days={visibleDays}
            events={sourceEvents ?? []}
            visibleCalendarIds={visibleIds}
            calendarsById={calendarsById}
            displayTimeZone={timeZone}
            locale={locale}
            today={today}
            now={props.clock.now}
            selectedDate={navigation.selectedDate}
            onSelectDate={(date) => setNavigation(selectCalendarDate(date))}
            onOpenEvent={openEvent}
          />
        )}
      </section>
      {createDialogOpen && editor ? (
        <CalendarEventEditor
          key={`editor:${editor.instance}`}
          presentation="dialog"
          client={cloud.client}
          scope={props.scope}
          calendars={editorCalendars}
          teamCalendarIds={teamCalendarIds}
          timeZone={timeZone}
          initial={editor.form ?? defaultCalendarEventForm({ date: navigation.selectedDate, calendarId: defaultCalendarId, timeZone })}
          online={online}
          onSaveDraft={saveEditorDraft}
          restoredFromDraft={Boolean(editor.draftId)}
          onDiscardDraft={editor.draftId ? () => {
            const draftId = editor.draftId!;
            void eventDrafts.discard(draftId);
            setEditor(null);
          } : undefined}
          onSaved={(event) => { void closeEditorAfterAuthoritativeSave(editor.draftId); setEditor(null); setSelectedEventId(event.id); }}
          onDeleted={() => undefined}
          onCancel={() => setEditor(null)}
        />
      ) : null}
      {sidePanelOpen ? (
        <aside className={cn("absolute inset-y-3 right-3 z-20 flex flex-col gap-3 overflow-auto rounded-xl border border-dls-border bg-dls-surface p-3 shadow-xl @3xl/calendar:inset-y-4 @3xl/calendar:right-4", editor?.mode === "edit" ? "w-[min(70rem,calc(100%-1.5rem))]" : "w-[min(26rem,calc(100%-1.5rem))]")} aria-label={t("calendar.event_panel")} data-testid="calendar-event-panel">
        {editor?.mode === "edit" && canOpenEditor && editingEvent && editingEventAllowed ? (
          <CalendarEventEditor
            key={`editor:${editor.instance}`}
            client={cloud.client}
            scope={props.scope}
            calendars={editorCalendars.filter((calendar) => teamCalendarIds.has(editingEvent.calendarId) ? calendar.id === editingEvent.calendarId : !teamCalendarIds.has(calendar.id))}
            teamCalendarIds={teamCalendarIds}
            timeZone={timeZone}
            event={editingEvent}
            initial={editor.form ?? calendarEventToForm(editingEvent)}
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
            recurringOccurrence={schedulingOccurrenceIds.has(selectedEvent.id)}
            schedulingEditUnavailable={!online && "attendees" in selectedEvent
              ? "offline"
              : online && !teamCalendarIds.has(selectedEvent.calendarId) && !schedulingMetadataReady
                ? schedulingQuery.isError ? "error" : "loading"
                : undefined}
            onClose={() => setSelectedEventId(null)}
            onEdit={!schedulingOccurrenceIds.has(selectedEvent.id) && (online ? teamCalendarIds.has(selectedEvent.calendarId) || schedulingMetadataReady : !("attendees" in selectedEvent)) && canOpenEditor && writableCalendars.some((calendar) => calendar.id === selectedEvent.calendarId) ? () => setEditor({ mode: "edit", instance: nextEditorInstance(), eventId: selectedEvent.id }) : undefined}
          />
        ) : null}
        </aside>
      ) : null}
      <CalendarCreateDialog open={createCalendarOpen} client={cloud.client} scope={props.scope} collaborationEnabled={props.collaborationEnabled} online={online} writeEnabled={props.writeEnabled} onOpenChange={setCreateCalendarOpen} />
      {membersCalendar && membersCalendar.capabilities.canManage && props.writeEnabled ? <CalendarMembersDialog open calendar={membersCalendar} client={cloud.client} scope={props.scope} onOpenChange={(open) => {
        if (open) return;
        closeMembersDialog();
      }} /> : null}
    </div>
    </div>
  );
}

/** Focus restoration is a progressive enhancement: skip it when no usable DOM is present. */
function focusableDocument(): Document | null {
  if (typeof document === "undefined") return null;
  return typeof document.querySelector === "function" ? document : null;
}

function isFocusableElement(value: unknown): value is HTMLElement {
  return typeof value === "object" && value !== null && "focus" in value && typeof (value as { focus?: unknown }).focus === "function";
}

function createCalendarDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? `draft-${crypto.randomUUID()}` : `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function schedulingOccurrenceId(eventId: string, occurrenceIndex: number): string {
  return `scheduling:${encodeURIComponent(eventId)}:${occurrenceIndex}`;
}

function preserveAuthoritativeSchedulingAttendees(form: CalendarEventFormValues, event: DenCalendarEvent): CalendarEventFormValues {
  if (!isSchedulingAggregate(event) || form.attendeeMemberIds.length > 0) return form;
  return { ...form, attendeeMemberIds: event.attendees.map((attendee) => attendee.memberId) };
}

function isSchedulingAggregate(event: DenCalendarEvent): event is DenCalendarSchedulingEvent {
  return "attendees" in event && Array.isArray(event.attendees);
}

function CalendarCenteredState(props: { testId: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid={props.testId}>
      {props.children}
    </div>
  );
}
