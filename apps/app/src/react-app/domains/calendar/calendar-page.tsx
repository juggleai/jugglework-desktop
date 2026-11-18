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
import { meetingAPI } from "@/react-app/domains/meeting/api";
import { calendarScopeIdentity, type CalendarScope } from "./calendar-scope";
import { resolveCalendarPageGate, type CalendarPageGate } from "./calendar-page-gate";
import { useCalendarBootstrapQuery, useCalendarCollaborationQuery, useCalendarOrganizationMembersQuery, useCalendarsQuery, useCalendarSchedulingEventsQuery, useTeamCalendarSnapshotsQuery } from "./calendar-queries";
import {
  calendarToday,
  calendarWeekStart,
  moveCalendarSelection,
  readCalendarColorOverrides,
  readHiddenCalendarIds,
  reconcileCalendarColorOverrides,
  reconcileHiddenCalendarIds,
  selectCalendarDate,
  visibleCalendarIds,
  writeCalendarColorOverrides,
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
import { nextCalendarColor, withDefaultCalendarColors } from "./calendar-colors";
import { CalendarMembersDialog } from "./calendar-members-dialog";
import { useCalendarSchedulingEventMutations, useDeleteCalendarEventMutation, useTeamCalendarEventMutations, type CalendarSchedulingOccurrenceIdentity } from "./calendar-mutations";
import { calendarViewDays, calendarViewRange, navigateCalendarView, readCalendarViewMode, writeCalendarViewMode, type CalendarViewMode } from "./calendar-view-model";
import { calendarEventFormForTimeSlot, calendarEventFormWithNextHalfHour, calendarEventToForm, defaultCalendarEventForm, type CalendarEventFormValues } from "./calendar-event-form-model";
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
  const navigate = useNavigate();
  const setHeaderAction = React.useContext(CalendarPageHeaderActionContext);
  const [offlineRuntime] = React.useState(() => props.offlineRuntime ?? defaultCalendarOfflineRuntime());
  const online = useCalendarOnline(offlineRuntime.online);
  const locale = currentLocale();
  const timeZone = React.useMemo(() => props.clock.timeZone(), [props.clock]);
  const today = React.useMemo(() => calendarToday(timeZone, props.clock.now()), [props.clock, timeZone]);
  const weekStart = React.useMemo(() => calendarWeekStart(locale), [locale]);
  const [navigation, setNavigation] = React.useState(() => selectCalendarDate(today));
  const [view, setView] = React.useState<CalendarViewMode>(() => readCalendarViewMode(props.scope));
  const [hiddenIds, setHiddenIds] = React.useState(() => readHiddenCalendarIds(props.scope));
  const [colorOverrides, setColorOverrides] = React.useState(() => readCalendarColorOverrides(props.scope));
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
  const sourceCalendars = online
    ? props.collaborationEnabled ? collaborationResources.map(denCalendarFromCollaborationResource) : calendarsQuery.data ?? []
    : offlineView.state === "offline-covered" || offlineView.state === "offline-uncovered" ? offlineView.calendars : [];
  const calendars = withDefaultCalendarColors(sourceCalendars.map((calendar) => colorOverrides[calendar.id] ? { ...calendar, color: colorOverrides[calendar.id]! } : calendar));
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
  const schedulingIdentityByDisplayId = React.useMemo(() => new Map(schedulingOccurrences.map((occurrence) => {
    const displayId = occurrence.event.recurrence ? schedulingOccurrenceId(occurrence.event.id, occurrence.occurrenceIndex) : occurrence.event.id;
    return [displayId, schedulingOccurrenceIdentity(occurrence.event.id, occurrence.occurrenceIndex, occurrence.time)] as const;
  })), [schedulingOccurrences]);
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
  React.useEffect(() => {
    if (!online || !(props.collaborationEnabled ? collaborationQuery.data : calendarsQuery.data)) return;
    setColorOverrides((current) => {
      const next = reconcileCalendarColorOverrides(current, activeIds);
      const nextEntries = Object.entries(next);
      if (nextEntries.length === Object.keys(current).length && nextEntries.every(([id, color]) => current[id] === color)) return current;
      writeCalendarColorOverrides(props.scope, next);
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
  const [detailAnchor, setDetailAnchor] = React.useState<DetailAnchor | null>(null);
  const eventsById = React.useMemo(
    () => new Map((sourceEvents ?? []).map((event) => [event.id, event])),
    [sourceEvents],
  );
  const selectedEvent = selectedEventId ? eventsById.get(selectedEventId) ?? null : null;
  React.useEffect(() => { if (!selectedEventId) setDetailAnchor(null); }, [selectedEventId]);
  const selectedSchedulingIdentity = selectedEventId ? schedulingIdentityByDisplayId.get(selectedEventId) : undefined;
  const selectedEventVisible = selectedEvent ? visibleIds.includes(selectedEvent.calendarId) : false;
  // Once fresh data no longer contains the open event (deleted elsewhere, or its calendar removed), close it.
  React.useEffect(() => {
    if (!selectedEventId || !sourceEvents || (online && bootstrapQuery.isFetching)) return;
    if (!selectedEvent || !selectedEventVisible) setSelectedEventId(null);
  }, [bootstrapQuery.isFetching, online, selectedEvent, selectedEventId, selectedEventVisible, sourceEvents]);
  const [editor, setEditor] = React.useState<
    | { mode: "create"; instance: number; draftId?: string; form?: CalendarEventFormValues; presentation?: "dialog" | "quick"; anchor?: { x: number; y: number } }
    | { mode: "edit"; instance: number; eventId: string; draftId?: string; form?: CalendarEventFormValues; draftBaseVersion?: number }
    | null
  >(null);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [createCalendarOpen, setCreateCalendarOpen] = React.useState(false);
  const [membersCalendarId, setMembersCalendarId] = React.useState<string | null>(null);
  const [meetingPending, setMeetingPending] = React.useState(false);
  const [meetingError, setMeetingError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const schedulingMutations = useCalendarSchedulingEventMutations(cloud.client, props.scope);
  const deleteMutation = useDeleteCalendarEventMutation(cloud.client, props.scope);
  const teamMutations = useTeamCalendarEventMutations(cloud.client, props.scope);
  const membersDialogOpener = React.useRef<HTMLElement | null>(null);
  const panelOpener = React.useRef<HTMLElement | null>(null);
  const editorDialogOpen = editor !== null;
  const detailCardOpen = selectedEvent !== null && selectedEventVisible && editor === null;
  const detailMembersQuery = useCalendarOrganizationMembersQuery({ client: cloud.client, scope: props.scope, active: online && detailCardOpen });
  const detailMembersById = React.useMemo(() => new Map((detailMembersQuery.data ?? []).map((member) => [member.id, member])), [detailMembersQuery.data]);
  const interactionSurfaceOpen = editorDialogOpen || detailCardOpen;
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
  const openEvent = (eventId: string, date: Temporal.PlainDate, click: React.MouseEvent<HTMLButtonElement>) => {
    if (!interactionSurfaceOpen) rememberOpener();
    setNavigation(selectCalendarDate(date));
    setEditor(null);
    setMeetingError("");
    setActionError("");
    setDetailAnchor(click?.currentTarget?.getBoundingClientRect?.() ?? null);
    setSelectedEventId(eventId);
  };
  const deleteSelectedEvent = async (scope: "this" | "this-and-following") => {
    if (!selectedEvent || !online || actionPending) return;
    setActionError("");
    try {
      if (selectedSchedulingIdentity) {
        await schedulingMutations.remove.mutateAsync({ ...selectedSchedulingIdentity, expectedVersion: selectedEvent.version, scope });
      } else if (teamCalendarIds.has(selectedEvent.calendarId)) {
        await teamMutations.remove.mutateAsync({ calendarId: selectedEvent.calendarId, eventId: selectedEvent.id, expectedVersion: selectedEvent.version });
      } else {
        await deleteMutation.mutateAsync({ eventId: selectedEvent.id, expectedVersion: selectedEvent.version });
      }
      setSelectedEventId(null);
    } catch {
      setActionError(t("calendar.action_failed"));
    }
  };
  const rsvpSelectedEvent = async (responseStatus: "accepted" | "declined" | "tentative", scope: "this" | "all") => {
    if (!selectedEvent || !selectedSchedulingIdentity || !online || !props.writeEnabled || actionPending) return;
    setActionError("");
    try {
      await schedulingMutations.rsvp.mutateAsync({ ...selectedSchedulingIdentity, expectedVersion: selectedEvent.version, scope, responseStatus });
    } catch {
      setActionError(t("calendar.action_failed"));
    }
  };
  const actionPending = schedulingMutations.remove.isPending || schedulingMutations.rsvp.isPending || deleteMutation.isPending || teamMutations.remove.isPending;
  const startEventMeeting = async (event: DenCalendarEvent) => {
    if (meetingPending || !event.videoConferenceEnabled) return;
    setMeetingPending(true);
    setMeetingError("");
    try {
      const readiness = await meetingAPI.settings();
      if (!readiness.ready) throw new Error(t("calendar.meeting_unavailable"));
      const attendeeMemberIds = "attendees" in event && Array.isArray(event.attendees) ? event.attendees.map((attendee) => attendee.memberId) : [event.ownerMemberId];
      const missing = attendeeMemberIds.filter((memberId) => !detailMembersById.has(memberId));
      if (missing.length > 0) throw new Error(t("calendar.meeting_attendees_unavailable"));
      const organizerUserId = detailMembersById.get(props.scope.memberId)?.userId;
      const invitees = [...new Set(attendeeMemberIds.map((memberId) => detailMembersById.get(memberId)!.userId).filter((userId) => userId && userId !== organizerUserId))];
      const startAt = props.clock.now();
      const endAt = startAt.add({ minutes: 30 });
      const { meeting } = await meetingAPI.create({ title: event.title.slice(0, 120), description: event.description.slice(0, 4000), immediate: true, startAt: startAt.toString(), endAt: endAt.toString(), timezone: timeZone, invitees }, crypto.randomUUID());
      await meetingAPI.notify(meeting.id);
      navigate("/meetings");
      window.dispatchEvent(new CustomEvent("meeting:open", { detail: { meetingId: meeting.id } }));
    } catch (error) {
      setMeetingError(error instanceof Error ? error.message : t("calendar.meeting_failed"));
    } finally {
      setMeetingPending(false);
    }
  };
  const startCreate = () => {
    if (!interactionSurfaceOpen) rememberOpener();
    setSelectedEventId(null);
    const now = props.clock.now();
    const date = now.toZonedDateTimeISO(timeZone).toPlainDate();
    const allDay = defaultCalendarEventForm({
      date,
      calendarId: defaultCalendarId,
      timeZone,
      creatorMemberId: teamCalendarIds.has(defaultCalendarId) ? undefined : props.scope.memberId,
    });
    setEditor({
      mode: "create",
      instance: nextEditorInstance(),
      presentation: "dialog",
      form: calendarEventFormWithNextHalfHour(allDay, now, timeZone),
    });
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
  const startQuickCreate = (slot: { date: Temporal.PlainDate; startMinute: number; durationMinutes?: number; snapToHalfHour?: boolean; clientX: number; clientY: number }) => {
    if (!canCreateEvent) return;
    if (!interactionSurfaceOpen) rememberOpener();
    setNavigation(selectCalendarDate(slot.date));
    setSelectedEventId(null);
    setEditor({
      mode: "create",
      instance: nextEditorInstance(),
      presentation: "quick",
      anchor: { x: slot.clientX, y: slot.clientY },
      form: calendarEventFormForTimeSlot({
        date: slot.date,
        startMinute: slot.startMinute,
        durationMinutes: slot.durationMinutes,
        snapToHalfHour: slot.snapToHalfHour,
        calendarId: defaultCalendarId,
        timeZone,
        creatorMemberId: teamCalendarIds.has(defaultCalendarId) ? undefined : props.scope.memberId,
      }),
    });
  };
  const startMonthQuickCreate = (input: { date: Temporal.PlainDate; clientX: number; clientY: number }) => {
    if (!canCreateEvent) return;
    if (!interactionSurfaceOpen) rememberOpener();
    setNavigation(selectCalendarDate(input.date));
    setSelectedEventId(null);
    setEditor({
      mode: "create",
      instance: nextEditorInstance(),
      presentation: "quick",
      anchor: { x: input.clientX, y: input.clientY },
      form: defaultCalendarEventForm({
        date: input.date,
        calendarId: defaultCalendarId,
        timeZone,
        creatorMemberId: teamCalendarIds.has(defaultCalendarId) ? undefined : props.scope.memberId,
      }),
    });
  };
  const updateQuickCreateForm = React.useCallback((form: CalendarEventFormValues) => {
    setEditor((current) => current?.mode === "create" && current.presentation === "quick" && current.form !== form ? { ...current, form } : current);
  }, []);
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
  const showOnlyCalendar = (calendarId: string) => {
    const next = activeIds.filter((id) => id !== calendarId);
    writeHiddenCalendarIds(props.scope, next);
    setHiddenIds(next);
  };
  const changeCalendarColor = (calendarId: string, color: string) => {
    setColorOverrides((current) => {
      const next = { ...current, [calendarId]: color };
      writeCalendarColorOverrides(props.scope, next);
      return next;
    });
  };

  return (
    <>
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
      <aside className="order-2 flex shrink-0 flex-col gap-3 bg-[var(--app-secondary-sidebar-bg)] @5xl/calendar:order-none @5xl/calendar:w-56 @5xl/calendar:gap-5" aria-label={t("calendar.sidebar")} data-testid="calendar-sidebar">
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
          })} hiddenIds={hiddenIds} onToggle={toggleCalendar} onShowOnly={showOnlyCalendar} onColorChange={changeCalendarColor} />
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
           onViewChange={(nextView) => {
             setView(nextView);
             writeCalendarViewMode(props.scope, nextView);
           }}
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
            onCreateDate={canCreateEvent ? startMonthQuickCreate : undefined}
            onMoveSelection={(days) => setNavigation((current) => moveCalendarSelection(current, days))}
            renderDayContent={(date, selected) => {
              const key = date.toString();
              const entries = dayEntries.get(key) ?? [];
              const quickPreview = editor?.mode === "create" && editor.presentation === "quick" && editor.form?.time.startDate === key ? {
                title: editor.form.title,
                calendarColor: calendarsById.get(editor.form.calendarId)?.color ?? "var(--dls-accent)",
                startTime: editor.form.time.kind === "timed" ? editor.form.time.startTime : undefined,
              } : undefined;
              if (entries.length === 0 && !quickPreview) return null;
              return (
                <CalendarDayEvents
                  date={key}
                  entries={entries}
                  calendarsById={calendarsById}
                  locale={locale}
                  currentMemberId={props.scope.memberId}
                  onOpenEvent={(eventId, click) => openEvent(eventId, date, click)}
                  onShowMore={() => setNavigation(selectCalendarDate(date))}
                  focusable={selected}
                  quickCreatePreview={quickPreview}
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
            currentMemberId={props.scope.memberId}
            onSelectDate={(date) => setNavigation(selectCalendarDate(date))}
            onOpenEvent={openEvent}
            onCreateAt={canCreateEvent ? startQuickCreate : undefined}
            quickCreatePreview={editor?.mode === "create" && editor.presentation === "quick" && editor.form?.time.kind === "timed" ? {
              title: editor.form.title,
              calendarColor: calendarsById.get(editor.form.calendarId)?.color ?? "var(--dls-accent)",
              startDate: editor.form.time.startDate,
              startTime: editor.form.time.startTime,
              endDate: editor.form.time.endDate,
              endTime: editor.form.time.endTime,
            } : undefined}
          />
        )}
      </section>
      {editor ? (
        <>
        {editor.mode === "create" && editor.presentation === "quick" && editor.anchor ? <button type="button" className="fixed inset-0 z-30 cursor-default bg-transparent" aria-label={t("calendar.cancel")} onClick={() => setEditor(null)} data-testid="calendar-quick-create-dismiss" /> : null}
        <div className={editor.mode === "create" && editor.presentation === "quick" && editor.anchor ? "fixed z-40 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl" : undefined} style={editor.mode === "create" && editor.presentation === "quick" && editor.anchor ? quickCreateStyle(editor.anchor) : undefined} data-testid={editor.mode === "create" && editor.presentation === "quick" ? "calendar-quick-create-positioner" : undefined}>
        <CalendarEventEditor
          key={`editor:${editor.instance}`}
          presentation={editor.mode === "create" ? editor.presentation ?? "dialog" : "dialog"}
          client={cloud.client}
          scope={props.scope}
          calendars={editorCalendars}
          teamCalendarIds={teamCalendarIds}
          timeZone={timeZone}
          now={props.clock.now}
          event={editor.mode === "edit" ? editingEvent : undefined}
          initial={editor.form ?? (editor.mode === "edit" && editingEvent ? calendarEventToForm(editingEvent) : defaultCalendarEventForm({ date: navigation.selectedDate, calendarId: defaultCalendarId, timeZone, kind: "timed", creatorMemberId: teamCalendarIds.has(defaultCalendarId) ? undefined : props.scope.memberId }))}
          online={online}
          writeEnabled={props.writeEnabled}
          onSaveDraft={saveEditorDraft}
          restoredFromDraft={Boolean(editor.draftId)}
          staleDraftBase={editor.mode === "edit" && editor.draftBaseVersion !== undefined && editingEvent !== undefined && editor.draftBaseVersion !== editingEvent.version}
          onDiscardDraft={editor.draftId ? () => {
            const draftId = editor.draftId!;
            void eventDrafts.discard(draftId);
            setEditor(null);
          } : undefined}
          onMoreOptions={editor.mode === "create" ? (form) => setEditor({ mode: "create", instance: nextEditorInstance(), draftId: editor.draftId, form, presentation: "dialog" }) : undefined}
          onFormChange={editor.mode === "create" && editor.presentation === "quick" ? updateQuickCreateForm : undefined}
          onSaved={(event) => {
            void closeEditorAfterAuthoritativeSave(editor.draftId);
            setEditor(null);
            setSelectedEventId(editor.mode === "edit" ? event.id : null);
          }}
          onDeleted={() => { void closeEditorAfterAuthoritativeSave(editor.draftId); setEditor(null); setSelectedEventId(null); }}
          onCancel={() => setEditor(null)}
        />
        </div>
        </>
      ) : null}
    </div>
    </div>
      {detailCardOpen && selectedEvent ? (
        <>
        <button type="button" className="fixed inset-0 z-30 cursor-default bg-transparent" aria-label={t("calendar.close_detail")} onClick={() => { setSelectedEventId(null); setDetailAnchor(null); }} data-testid="calendar-event-detail-dismiss-layer" />
        <aside className={cn("fixed z-40 flex flex-col overflow-y-auto rounded-lg border border-black/[0.035] bg-dls-surface shadow-[0_18px_48px_rgba(15,23,42,0.18)] dark:border-white/10 dark:shadow-[0_20px_56px_rgba(0,0,0,0.46)]", !detailAnchor && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2")} style={detailPanelStyle(detailAnchor)} aria-label={t("calendar.event_panel")} data-detail-anchored={detailAnchor ? "true" : undefined} data-detail-layout="uniform" data-testid="calendar-event-panel">
          <CalendarEventDetail
            event={selectedEvent}
            calendar={calendarsById.get(selectedEvent.calendarId)}
            locale={locale}
            membersById={detailMembersById}
            currentMemberId={props.scope.memberId}
            currentUserLabel={cloud.user?.name?.trim() || cloud.user?.account?.trim() || cloud.user?.email?.trim() || undefined}
            meetingPending={meetingPending}
            meetingError={meetingError}
            onStartMeeting={selectedEvent.videoConferenceEnabled && online ? () => void startEventMeeting(selectedEvent) : undefined}
            recurringOccurrence={schedulingOccurrenceIds.has(selectedEvent.id)}
            schedulingEditUnavailable={!online && "attendees" in selectedEvent
              ? "offline"
              : online && !teamCalendarIds.has(selectedEvent.calendarId) && !schedulingMetadataReady
                ? schedulingQuery.isError ? "error" : "loading"
                : undefined}
            onDelete={online && props.writeEnabled && !teamCalendarIds.has(selectedEvent.calendarId) && schedulingMetadataReady && selectedEvent.ownerMemberId === props.scope.memberId && (!isSchedulingAggregate(selectedEvent) || selectedSchedulingIdentity) ? (scope) => void deleteSelectedEvent(scope) : online && props.writeEnabled && teamCalendarIds.has(selectedEvent.calendarId) && writableCalendars.some((calendar) => calendar.id === selectedEvent.calendarId) ? (scope) => void deleteSelectedEvent(scope) : undefined}
            onRsvp={online && props.writeEnabled && isSchedulingAggregate(selectedEvent) && selectedSchedulingIdentity && selectedEvent.attendees.some((attendee) => attendee.memberId === props.scope.memberId) ? (responseStatus, scope) => void rsvpSelectedEvent(responseStatus, scope) : undefined}
            actionPending={actionPending}
            actionError={actionError}
            onClose={() => { setSelectedEventId(null); setDetailAnchor(null); }}
            onEdit={!schedulingOccurrenceIds.has(selectedEvent.id) && (online ? teamCalendarIds.has(selectedEvent.calendarId) || schedulingMetadataReady : !("attendees" in selectedEvent)) && canOpenEditor && writableCalendars.some((calendar) => calendar.id === selectedEvent.calendarId) ? () => { setEditor({ mode: "edit", instance: nextEditorInstance(), eventId: selectedEvent.id }); setSelectedEventId(null); } : undefined}
          />
        </aside>
        </>
      ) : null}
      <CalendarCreateDialog open={createCalendarOpen} client={cloud.client} scope={props.scope} collaborationEnabled={props.collaborationEnabled} online={online} writeEnabled={props.writeEnabled} defaultColor={nextCalendarColor(calendars.map((calendar) => calendar.color))} onOpenChange={setCreateCalendarOpen} />
      {membersCalendar && membersCalendar.capabilities.canManage && props.writeEnabled ? <CalendarMembersDialog open calendar={membersCalendar} client={cloud.client} scope={props.scope} onOpenChange={(open) => {
        if (open) return;
        closeMembersDialog();
      }} /> : null}
    </>
  );
}

/** Focus restoration is a progressive enhancement: skip it when no usable DOM is present. */
function focusableDocument(): Document | null {
  if (typeof document === "undefined") return null;
  return typeof document.querySelector === "function" ? document : null;
}

type DetailAnchor = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

function detailPanelStyle(anchor: DetailAnchor | null): CSSProperties {
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const margin = 16;
  const gap = 6;
  const width = Math.min(350, viewportWidth - margin * 2);
  const maxHeight = Math.min(576, viewportHeight - margin * 2);
  if (!anchor) return { width, maxHeight };

  const right = anchor.right + gap;
  const left = anchor.left - gap - width;
  if (right + width <= viewportWidth - margin || left >= margin) {
    const top = Math.max(margin, anchor.top);
    // 100% is the rendered card height. Shift up only by the actual overflow.
    const transform = `translateY(min(0px, calc(${viewportHeight - margin - top}px - 100%)))`;
    return { left: right + width <= viewportWidth - margin ? right : left, top, transform, width, maxHeight };
  }

  // Wide day-view events can span the grid. Use the larger vertical gap.
  const below = viewportHeight - margin - anchor.bottom - gap;
  const above = anchor.top - gap - margin;
  const alignedLeft = Math.max(margin, Math.min(anchor.left, viewportWidth - margin - width));
  if (below >= maxHeight || below >= above) {
    const height = Math.min(maxHeight, Math.max(160, below));
    return { left: alignedLeft, top: Math.min(anchor.bottom + gap, viewportHeight - margin - height), width, maxHeight: height };
  }
  const height = Math.min(maxHeight, Math.max(160, above));
  return { left: alignedLeft, bottom: Math.min(viewportHeight - anchor.top + gap, viewportHeight - margin - height), width, maxHeight: height };
}

function quickCreateStyle(anchor: { x: number; y: number }): CSSProperties {
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const margin = 16;
  const gap = 12;
  const width = Math.min(460, Math.max(300, viewportWidth - margin * 2));
  const estimatedHeight = 560;
  const preferredLeft = anchor.x + gap + width <= viewportWidth - margin ? anchor.x + gap : anchor.x - width - gap;
  const left = Math.min(Math.max(preferredLeft, margin), Math.max(margin, viewportWidth - width - margin));
  const top = Math.min(Math.max(anchor.y - 32, margin), Math.max(margin, viewportHeight - estimatedHeight - margin));
  return { left, top, width, maxWidth: `calc(100vw - ${margin * 2}px)` };
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

function schedulingOccurrenceIdentity(eventId: string, occurrenceIndex: number, time: DenCalendarEvent["time"]): CalendarSchedulingOccurrenceIdentity {
  return {
    eventId,
    occurrenceIndex,
    occurrence: time.kind === "allDay"
      ? { occurrenceIndex, startDate: time.startDate }
      : { occurrenceIndex, startInstant: time.startInstant },
  };
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
