/** @jsxImportSource react */
import * as React from "react";
import type { Temporal } from "@js-temporal/polyfill";
import { Bell, CalendarPlus, Clock3, FileText, LoaderCircle, Pencil, UserRound, Users, Video, X } from "lucide-react";

import type { DenCalendar, DenCalendarEvent, DenCalendarSchedulingEvent, DenOrganizationMember } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { CalendarDayEntry } from "./calendar-event-layout";
import { formatCalendarTime, parseCalendarEventTime } from "./calendar-time-adapter";

function entryTimeLabel(entry: CalendarDayEntry, locale: string): string {
  if (entry.interval.kind === "allDay") return t("calendar.all_day");
  const zone = entry.interval.timeZone;
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const start = entry.interval.startInstant.toZonedDateTimeISO(zone).toLocaleString(locale, options);
  const end = entry.interval.endInstantExclusive.toZonedDateTimeISO(zone).toLocaleString(locale, options);
  return `${start} – ${end}`;
}

export function CalendarAgenda(props: {
  date: Temporal.PlainDate;
  entries: readonly CalendarDayEntry[];
  calendarsById: ReadonlyMap<string, DenCalendar>;
  locale: string;
  selectedEventId: string | null;
  canCreate: boolean;
  onOpenEvent: (eventId: string) => void;
  onCreate?: () => void;
}) {
  const heading = props.date.toLocaleString(props.locale, { dateStyle: "full" });
  return (
    <section aria-labelledby="calendar-agenda-heading" className="flex min-h-0 min-w-0 flex-col gap-2" data-testid="calendar-agenda">
      <h3 id="calendar-agenda-heading" className="text-sm font-semibold text-dls-text" data-testid="calendar-agenda-date">{heading}</h3>
      {props.entries.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-dls-border p-3" data-testid="calendar-agenda-empty">
          <p className="text-sm text-dls-secondary">{t("calendar.agenda_empty")}</p>
          {props.canCreate && props.onCreate ? (
            <Button type="button" variant="outline" size="sm" onClick={props.onCreate} data-testid="calendar-agenda-create">
              <CalendarPlus className="size-4" aria-hidden="true" />
              {t("calendar.create_event")}
            </Button>
          ) : null}
        </div>
      ) : (
        <ol className="flex flex-col gap-1" data-testid="calendar-agenda-list">
          {props.entries.map((entry) => {
            const calendar = props.calendarsById.get(entry.event.calendarId);
            const selected = entry.event.id === props.selectedEventId;
            return (
              <li key={entry.event.id}>
                <button
                  type="button"
                  onClick={() => props.onOpenEvent(entry.event.id)}
                  aria-current={selected ? "true" : undefined}
                  className="flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 aria-[current=true]:bg-dls-active"
                  data-testid={`calendar-agenda-item-${entry.event.id}`}
                >
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: calendar?.color ?? "var(--dls-accent)" }} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-dls-text">{entry.event.title}</span>
                    <span className="block truncate text-xs text-dls-secondary">{entryTimeLabel(entry, props.locale)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function CalendarEventDetail(props: {
  event: DenCalendarEvent;
  calendar: DenCalendar | undefined;
  locale: string;
  onClose: () => void;
  onEdit?: () => void;
  onStartMeeting?: () => void;
  meetingPending?: boolean;
  meetingError?: string;
  membersById?: ReadonlyMap<string, DenOrganizationMember>;
  recurringOccurrence?: boolean;
  schedulingEditUnavailable?: "loading" | "error" | "offline";
}) {
  const sectionRef = React.useRef<HTMLElement | null>(null);
  // Move focus to the detail when it opens or switches events, so screen readers announce it.
  React.useEffect(() => { sectionRef.current?.focus(); }, [props.event.id]);
  const interval = React.useMemo(() => {
    try { return parseCalendarEventTime(props.event.time); } catch { return null; }
  }, [props.event.time]);
  const scheduling = isSchedulingEvent(props.event) ? props.event : null;
  const owner = props.membersById?.get(props.event.ownerMemberId);
  const displayName = (memberId: string) => {
    const member = props.membersById?.get(memberId);
    return member?.user.name?.trim() || member?.user.account?.trim() || member?.user.email?.trim() || memberId;
  };
  const recurrenceLabel = scheduling?.recurrence
    ? t(`calendar.recurrence_${scheduling.recurrence.frequency}`)
    : null;
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="calendar-event-detail-title"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl bg-dls-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35"
      data-testid="calendar-event-detail"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="flex h-14 items-center justify-end gap-1 border-b border-dls-border px-3">
        {props.onEdit ? <Button type="button" variant="ghost" size="icon-sm" aria-label={t("calendar.edit_event")} title={t("calendar.edit_event")} onClick={props.onEdit} data-testid="calendar-event-detail-edit"><Pencil className="size-4" aria-hidden="true" /></Button> : null}
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("calendar.close_detail")} onClick={props.onClose} data-testid="calendar-event-detail-close">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto px-5 py-5">
        <div className="flex items-start gap-3">
          <span className="mt-1.5 size-4 shrink-0 rounded" style={{ backgroundColor: props.calendar?.color ?? "var(--dls-accent)" }} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h3 id="calendar-event-detail-title" className="break-words text-xl font-semibold text-dls-accent" data-testid="calendar-event-detail-title">{props.event.title}</h3>
            <p className="mt-2 text-sm text-dls-accent" data-testid="calendar-event-detail-time">
              {interval ? formatCalendarTime(interval, props.locale) : "—"}
              {interval?.kind === "allDay" ? <span className="ml-1">({t("calendar.all_day")})</span> : null}
              {interval?.kind === "timed" ? <span className="ml-1">(<span data-testid="calendar-event-detail-zone">{interval.timeZone}</span>)</span> : null}
            </p>
            {recurrenceLabel ? <p className="mt-1 text-sm text-dls-accent">{recurrenceLabel}</p> : null}
            <p className="sr-only" data-testid="calendar-event-detail-calendar">{props.calendar?.name ?? "—"}</p>
            <p className="sr-only" data-testid="calendar-event-detail-status">{t("calendar.status_saved")}</p>
          </div>
        </div>

        <div className="mt-6 space-y-5 text-sm">
          {props.event.videoConferenceEnabled && props.onStartMeeting ? (
            <div className="flex items-start gap-3">
              <Video className="mt-2 size-5 shrink-0 text-dls-secondary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <Button type="button" variant="outline" disabled={props.meetingPending} onClick={props.onStartMeeting} data-testid="calendar-event-start-meeting">
                  {props.meetingPending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Video className="size-4" aria-hidden="true" />}
                  {props.meetingPending ? t("calendar.meeting_starting") : t("calendar.meeting_start")}
                </Button>
                {props.meetingError ? <p className="mt-2 text-xs text-red-600" role="alert" data-testid="calendar-event-meeting-error">{props.meetingError}</p> : null}
              </div>
            </div>
          ) : null}
          <div className="flex items-center gap-3"><UserRound className="size-5 shrink-0 text-dls-secondary" aria-hidden="true" /><span className="text-dls-text">{owner ? displayName(owner.id) : displayName(props.event.ownerMemberId)}</span><span className="rounded bg-dls-accent/10 px-1.5 py-0.5 text-xs text-dls-accent">{t("calendar.attendee_creator")}</span></div>
          {scheduling ? (
            <div className="flex items-start gap-3">
              <Users className="mt-0.5 size-5 shrink-0 text-dls-secondary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-dls-text">{t("calendar.attendees_count", { count: scheduling.attendees.length })}</p>
                <p className="mt-1 text-xs text-dls-secondary">{t("calendar.attendee_response_summary", { accepted: scheduling.attendees.filter((item) => item.responseStatus === "accepted").length, pending: scheduling.attendees.filter((item) => item.responseStatus === "needs-action").length })}</p>
                <div className="mt-3 space-y-2" data-testid="calendar-event-detail-attendees">
                  {scheduling.attendees.map((attendee) => <div key={attendee.memberId} className="flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-full bg-dls-text/10 text-xs font-medium">{displayName(attendee.memberId).slice(0, 1).toLocaleUpperCase()}</span><span className="truncate text-dls-text">{displayName(attendee.memberId)}</span></div>)}
                </div>
              </div>
            </div>
          ) : null}
          {props.event.description ? <div className="flex items-start gap-3"><FileText className="mt-0.5 size-5 shrink-0 text-dls-secondary" aria-hidden="true" /><p className="whitespace-pre-wrap break-words text-dls-text" data-testid="calendar-event-detail-description">{props.event.description}</p></div> : null}
          <div className="flex items-center gap-3"><Bell className="size-5 shrink-0 text-dls-secondary" aria-hidden="true" /><span className="text-dls-text">{t("calendar.reminder_minutes_before", { count: 5 })}</span></div>
          <div className="flex items-center gap-3"><Clock3 className="size-5 shrink-0 text-dls-secondary" aria-hidden="true" /><span className="text-dls-secondary">{props.calendar?.name ?? "—"}</span></div>
        </div>
        {props.recurringOccurrence ? <p className="mt-5 rounded-lg bg-dls-hover px-3 py-2 text-xs text-dls-secondary" role="note" data-testid="calendar-occurrence-read-only">{t("calendar.occurrence_read_only")}</p> : null}
        {props.schedulingEditUnavailable ? <p className="mt-5 rounded-lg bg-dls-hover px-3 py-2 text-xs text-dls-secondary" role="note" data-testid={`calendar-scheduling-edit-${props.schedulingEditUnavailable}`}>{t(props.schedulingEditUnavailable === "loading" ? "calendar.scheduling_edit_loading" : props.schedulingEditUnavailable === "offline" ? "calendar.scheduling_edit_offline" : "calendar.scheduling_edit_unavailable")}</p> : null}
      </div>
    </section>
  );
}

function isSchedulingEvent(event: DenCalendarEvent): event is DenCalendarSchedulingEvent {
  return "attendees" in event && Array.isArray(event.attendees) && "recurrence" in event;
}
