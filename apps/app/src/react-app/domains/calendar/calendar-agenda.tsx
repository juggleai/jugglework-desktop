/** @jsxImportSource react */
import * as React from "react";
import type { Temporal } from "@js-temporal/polyfill";
import { CalendarPlus, X } from "lucide-react";

import type { DenCalendar, DenCalendarEvent } from "@/app/lib/den";
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
  recurringOccurrence?: boolean;
  schedulingEditUnavailable?: "loading" | "error" | "offline";
}) {
  const sectionRef = React.useRef<HTMLElement | null>(null);
  // Move focus to the detail when it opens or switches events, so screen readers announce it.
  React.useEffect(() => { sectionRef.current?.focus(); }, [props.event.id]);
  const interval = React.useMemo(() => {
    try { return parseCalendarEventTime(props.event.time); } catch { return null; }
  }, [props.event.time]);
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="calendar-event-detail-title"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-dls-border p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35"
      data-testid="calendar-event-detail"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <h3 id="calendar-event-detail-title" className="min-w-0 flex-1 break-words text-base font-semibold text-dls-text" data-testid="calendar-event-detail-title">
          {props.event.title}
        </h3>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("calendar.close_detail")} onClick={props.onClose} data-testid="calendar-event-detail-close">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-dls-secondary">{t("calendar.detail_calendar")}</dt>
        <dd className="min-w-0 truncate text-dls-text" data-testid="calendar-event-detail-calendar">{props.calendar?.name ?? "—"}</dd>
        <dt className="text-dls-secondary">{t("calendar.detail_time")}</dt>
        <dd className="min-w-0 text-dls-text" data-testid="calendar-event-detail-time">
          {interval ? formatCalendarTime(interval, props.locale) : "—"}
          {interval?.kind === "allDay" ? <span className="ml-1 text-dls-secondary">({t("calendar.all_day")})</span> : null}
        </dd>
        {interval?.kind === "timed" ? (
          <>
            <dt className="text-dls-secondary">{t("calendar.detail_time_zone")}</dt>
            <dd className="min-w-0 truncate text-dls-text" data-testid="calendar-event-detail-zone">{interval.timeZone}</dd>
          </>
        ) : null}
        <dt className="text-dls-secondary">{t("calendar.detail_status")}</dt>
        <dd className="text-dls-text" data-testid="calendar-event-detail-status">{t("calendar.status_saved")}</dd>
      </dl>
      {props.event.description ? (
        <p className="whitespace-pre-wrap break-words text-sm text-dls-text" data-testid="calendar-event-detail-description">{props.event.description}</p>
      ) : null}
      {props.recurringOccurrence ? <p className="rounded-lg bg-dls-hover px-3 py-2 text-xs text-dls-secondary" role="note" data-testid="calendar-occurrence-read-only">{t("calendar.occurrence_read_only")}</p> : null}
      {props.schedulingEditUnavailable ? <p className="rounded-lg bg-dls-hover px-3 py-2 text-xs text-dls-secondary" role="note" data-testid={`calendar-scheduling-edit-${props.schedulingEditUnavailable}`}>{t(props.schedulingEditUnavailable === "loading" ? "calendar.scheduling_edit_loading" : props.schedulingEditUnavailable === "offline" ? "calendar.scheduling_edit_offline" : "calendar.scheduling_edit_unavailable")}</p> : null}
      {props.onEdit ? (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={props.onEdit} data-testid="calendar-event-detail-edit">{t("calendar.edit_event")}</Button>
        </div>
      ) : null}
    </section>
  );
}
