/** @jsxImportSource react */
import * as React from "react";
import { Temporal } from "@js-temporal/polyfill";
import { X } from "lucide-react";

import type { DenCalendar, DenCalendarEvent } from "@/app/lib/den";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { formatCalendarEntryStart, splitCalendarDayOverflow, type CalendarDayEntry } from "./calendar-event-layout";

/**
 * Event chips inside one month cell. Titles render as plain text only.
 * When the day exceeds capacity, a "+N more" entry opens the full agenda for that date.
 */
export function CalendarDayEvents(props: {
  date: string;
  entries: readonly CalendarDayEntry[];
  calendarsById: ReadonlyMap<string, DenCalendar>;
  locale: string;
  currentMemberId: string;
  onOpenEvent?: (eventId: string, click: React.MouseEvent<HTMLButtonElement>) => void;
  onShowMore: () => void;
  /** Only the roving-focus day exposes its chips to Tab, so Tab moves cell → chips → next region. */
  focusable?: boolean;
  quickCreatePreview?: { title: string; calendarColor: string; startTime?: string };
}) {
  const tabIndex = props.focusable ? 0 : -1;
  const { shown, hiddenCount } = splitCalendarDayOverflow(props.entries);
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  const date = Temporal.PlainDate.from(props.date);
  const openEvent = (eventId: string, event: React.MouseEvent<HTMLButtonElement>) => {
    setOverflowOpen(false);
    props.onOpenEvent?.(eventId, event);
  };
  return (
    <ul className="flex min-h-0 min-w-0 flex-col gap-0.5" data-testid={`calendar-day-events-${props.date}`}>
      {props.quickCreatePreview ? <li className="min-w-0">
        <div
          className="flex w-full min-w-0 items-center gap-1 truncate rounded px-1 py-px text-left text-[11px] leading-4 text-white shadow-sm"
          style={{ backgroundColor: props.quickCreatePreview.calendarColor }}
          data-testid={`calendar-month-quick-create-preview-${props.date}`}
        >
          {props.quickCreatePreview.startTime ? <span className="shrink-0 opacity-80">{props.quickCreatePreview.startTime}</span> : null}
          <span className="min-w-0 truncate">{props.quickCreatePreview.title.trim() || t("calendar.create_event")}</span>
        </div>
      </li> : null}
      {shown.map((entry) => {
        const calendar = props.calendarsById.get(entry.event.calendarId);
        const start = formatCalendarEntryStart(entry, props.locale);
        const allDay = entry.interval.kind === "allDay";
        const responseStatus = currentAttendeeResponse(entry.event, props.currentMemberId);
        const declined = responseStatus === "declined";
        const tentative = responseStatus === "tentative";
        return (
          <li key={entry.event.id} className="min-w-0">
            <button
              type="button"
              tabIndex={tabIndex}
              onClick={(event) => openEvent(entry.event.id, event)}
              className={cn(
                "flex w-full min-w-0 items-center gap-1 truncate px-1 py-px text-left text-[11px] leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent focus-visible:ring-offset-1 focus-visible:ring-offset-dls-surface",
                allDay ? "text-white" : "text-dls-text hover:bg-dls-hover",
                declined && "text-[#b8bdc5] line-through hover:bg-dls-hover/55 dark:text-white/30",
                tentative && !allDay && "bg-dls-hover",
                allDay && !entry.continuesFromPrevious && "rounded-l",
                allDay && !entry.continuesToNext && "rounded-r",
                !allDay && "rounded",
              )}
              style={allDay && !declined ? { backgroundColor: calendar?.color ?? "var(--dls-accent)" } : undefined}
              aria-label={start ? `${start} ${entry.event.title}` : entry.event.title}
              data-testid={`calendar-day-event-${props.date}-${entry.event.id}`}
              data-continues-from-previous={entry.continuesFromPrevious ? "true" : undefined}
              data-continues-to-next={entry.continuesToNext ? "true" : undefined}
            >
              {!allDay || declined ? (
                <span className={cn("size-1.5 shrink-0", declined ? "rounded-[2px] border-2 border-[#b8bdc5] bg-transparent dark:border-white/30" : "rounded-full", tentative && "ring-1 ring-offset-1 ring-offset-dls-surface")} style={declined ? undefined : { backgroundColor: calendar?.color ?? "var(--dls-accent)" }} aria-hidden="true" data-testid={declined ? `calendar-day-declined-marker-${props.date}-${entry.event.id}` : undefined} />
              ) : null}
              {start ? <span className="shrink-0 text-dls-secondary">{start}</span> : null}
              <span className="min-w-0 truncate">{entry.event.title}</span>
            </button>
          </li>
        );
      })}
      {hiddenCount > 0 ? (
        <li>
          <Popover open={overflowOpen} onOpenChange={(open) => {
            setOverflowOpen(open);
            if (open) props.onShowMore();
          }}>
            <PopoverTrigger
              render={<button
                type="button"
                tabIndex={tabIndex}
                aria-label={t("calendar.more_events_label", { count: hiddenCount })}
                aria-expanded={overflowOpen}
                className="w-full truncate rounded px-1 py-px text-left text-[11px] font-medium text-dls-secondary hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35"
                data-testid={`calendar-day-more-${props.date}`}
              />}
            >
              {t("calendar.more_events", { count: hiddenCount })}
            </PopoverTrigger>
            {overflowOpen ? (
              <PopoverContent
                align="start"
                side="bottom"
                sideOffset={6}
                role="dialog"
                aria-label={date.toLocaleString(props.locale, { dateStyle: "full" })}
                className="max-h-[min(32rem,calc(100vh-2rem))] w-[min(22rem,calc(100vw-2rem))] gap-0 overflow-hidden rounded-2xl border border-dls-border bg-dls-surface p-0 text-dls-text shadow-[0_18px_48px_rgba(15,23,42,0.2)] dark:shadow-[0_20px_56px_rgba(0,0,0,0.5)]"
                data-testid={`calendar-day-overflow-${props.date}`}
              >
                <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-4">
                  <div>
                    <p className="text-sm font-medium text-dls-text">{date.toLocaleString(props.locale, { weekday: "long" })}</p>
                    <p className="mt-0.5 text-4xl font-medium leading-none tracking-tight text-dls-text">{date.day}</p>
                  </div>
                  <button type="button" className="flex size-8 items-center justify-center rounded-lg text-dls-secondary hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35" aria-label={t("common.close")} onClick={() => setOverflowOpen(false)} data-testid={`calendar-day-overflow-close-${props.date}`}>
                    <X className="size-5" aria-hidden="true" />
                  </button>
                </div>
                <ol className="subtle-scrollbar min-h-0 overflow-y-auto px-3 pb-4" data-testid={`calendar-day-overflow-list-${props.date}`}>
                  {props.entries.map((entry) => {
                    const calendar = props.calendarsById.get(entry.event.calendarId);
                    const allDay = entry.interval.kind === "allDay";
                    const responseStatus = currentAttendeeResponse(entry.event, props.currentMemberId);
                    const declined = responseStatus === "declined";
                    const tentative = responseStatus === "tentative";
                    const start = overflowEntryStart(entry, props.locale);
                    return (
                      <li key={entry.event.id}>
                        <button
                          type="button"
                          onClick={(event) => openEvent(entry.event.id, event)}
                          className={cn(
                            "grid w-full grid-cols-[8px_4.75rem_minmax(0,1fr)] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-dls-text hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35",
                            declined && "text-dls-secondary line-through",
                            tentative && "opacity-80",
                          )}
                          data-testid={`calendar-day-overflow-event-${props.date}-${entry.event.id}`}
                        >
                          <span className={cn("size-2 rounded-[3px]", declined ? "border-2 border-[#b8bdc5] bg-transparent dark:border-white/30" : allDay && "ring-1 ring-white/25")} style={declined ? undefined : { backgroundColor: calendar?.color ?? "var(--dls-accent)" }} aria-hidden="true" />
                          <span className="truncate tabular-nums text-dls-secondary">{start}</span>
                          <span className="truncate font-medium">{entry.event.title}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </PopoverContent>
            ) : null}
          </Popover>
        </li>
      ) : null}
    </ul>
  );
}

function overflowEntryStart(entry: CalendarDayEntry, locale: string): string {
  if (entry.interval.kind === "allDay") return t("calendar.all_day");
  return entry.interval.startInstant.toZonedDateTimeISO(entry.interval.timeZone).toLocaleString(locale, { hour: "numeric", minute: "2-digit" });
}

function currentAttendeeResponse(event: DenCalendarEvent, memberId: string): "needs-action" | "accepted" | "declined" | "tentative" | undefined {
  if (!("attendees" in event) || !Array.isArray(event.attendees)) return undefined;
  return event.attendees.find((attendee) => attendee.memberId === memberId)?.responseStatus;
}
