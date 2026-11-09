/** @jsxImportSource react */
import * as React from "react";

import type { DenCalendar } from "@/app/lib/den";
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
  onOpenEvent?: (eventId: string) => void;
  onShowMore: () => void;
}) {
  const { shown, hiddenCount } = splitCalendarDayOverflow(props.entries);
  return (
    <ul className="flex min-h-0 min-w-0 flex-col gap-0.5" data-testid={`calendar-day-events-${props.date}`}>
      {shown.map((entry) => {
        const calendar = props.calendarsById.get(entry.event.calendarId);
        const start = formatCalendarEntryStart(entry, props.locale);
        const allDay = entry.interval.kind === "allDay";
        return (
          <li key={entry.event.id} className="min-w-0">
            <button
              type="button"
              tabIndex={-1}
              onClick={() => props.onOpenEvent?.(entry.event.id)}
              className={cn(
                "flex w-full min-w-0 items-center gap-1 truncate px-1 py-px text-left text-[11px] leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35",
                allDay ? "text-white" : "text-dls-text hover:bg-dls-hover",
                allDay && !entry.continuesFromPrevious && "rounded-l",
                allDay && !entry.continuesToNext && "rounded-r",
                !allDay && "rounded",
              )}
              style={allDay ? { backgroundColor: calendar?.color ?? "var(--dls-accent)" } : undefined}
              aria-label={start ? `${start} ${entry.event.title}` : entry.event.title}
              data-testid={`calendar-day-event-${props.date}-${entry.event.id}`}
              data-continues-from-previous={entry.continuesFromPrevious ? "true" : undefined}
              data-continues-to-next={entry.continuesToNext ? "true" : undefined}
            >
              {!allDay ? (
                <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: calendar?.color ?? "var(--dls-accent)" }} aria-hidden="true" />
              ) : null}
              {start ? <span className="shrink-0 text-dls-secondary">{start}</span> : null}
              <span className="min-w-0 truncate">{entry.event.title}</span>
            </button>
          </li>
        );
      })}
      {hiddenCount > 0 ? (
        <li>
          <button
            type="button"
            tabIndex={-1}
            onClick={props.onShowMore}
            className="w-full truncate rounded px-1 py-px text-left text-[11px] font-medium text-dls-secondary hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35"
            data-testid={`calendar-day-more-${props.date}`}
          >
            {t("calendar.more_events", { count: hiddenCount })}
          </button>
        </li>
      ) : null}
    </ul>
  );
}
