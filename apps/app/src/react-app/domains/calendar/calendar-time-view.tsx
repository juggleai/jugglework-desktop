/** @jsxImportSource react */
import * as React from "react";
import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendar, DenCalendarEvent } from "@/app/lib/den";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { layoutCalendarTimeView, type CalendarTimedSegment } from "./calendar-time-layout";
import type { CalendarViewMode } from "./calendar-view-model";

const HOUR_HEIGHT = 48;
const DAY_HEIGHT = HOUR_HEIGHT * 24;

function timeZoneLabel(value: Temporal.ZonedDateTime): string {
  const sign = value.offset.startsWith("-") ? "-" : "+";
  const [hours = "00", minutes = "00"] = value.offset.slice(1).split(":");
  const absolute = String(Number(hours));
  return `GMT${sign}${absolute}${minutes === "00" ? "" : `:${minutes}`}`;
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function segmentLabel(segment: CalendarTimedSegment, locale: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const start = segment.event.time.kind === "timed"
    ? Temporal.Instant.from(segment.event.time.startInstant).toZonedDateTimeISO(timeZone).toLocaleString(locale, options)
    : "";
  const end = segment.event.time.kind === "timed"
    ? Temporal.Instant.from(segment.event.time.endInstantExclusive).toZonedDateTimeISO(timeZone).toLocaleString(locale, options)
    : "";
  return `${start} – ${end}`;
}

export function CalendarTimeView(props: {
  view: Exclude<CalendarViewMode, "month">;
  days: readonly Temporal.PlainDate[];
  events: readonly DenCalendarEvent[];
  visibleCalendarIds: readonly string[];
  calendarsById: ReadonlyMap<string, DenCalendar>;
  displayTimeZone: string;
  locale: string;
  today: Temporal.PlainDate;
  now: () => Temporal.Instant;
  selectedDate: Temporal.PlainDate;
  onSelectDate: (date: Temporal.PlainDate) => void;
  onOpenEvent: (eventId: string, date: Temporal.PlainDate) => void;
}) {
  const layout = React.useMemo(() => layoutCalendarTimeView({
    events: props.events,
    days: props.days,
    visibleCalendarIds: props.visibleCalendarIds,
    displayTimeZone: props.displayTimeZone,
  }), [props.days, props.displayTimeZone, props.events, props.visibleCalendarIds]);
  const [now, setNow] = React.useState(() => props.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(props.now()), 60_000);
    return () => clearInterval(timer);
  }, [props.now]);
  const current = now.toZonedDateTimeISO(props.displayTimeZone);
  const gridTemplateColumns = `3.5rem repeat(${props.days.length}, minmax(${props.view === "week" ? "7rem" : "14rem"}, 1fr))`;
  const allDayRows = layout.allDayRowCount;
  const currentDayIndex = props.days.findIndex((day) => day.equals(current.toPlainDate()));
  const currentMinute = current.hour * 60 + current.minute + current.second / 60;
  const currentTimeLabel = current.toPlainTime().toString().slice(0, 5);
  const weekView = props.view === "week";
  const timeGridRef = React.useRef<HTMLDivElement>(null);
  const didSetInitialScroll = React.useRef(false);
  React.useEffect(() => {
    if (didSetInitialScroll.current || !timeGridRef.current) return;
    didSetInitialScroll.current = true;
    timeGridRef.current.scrollTop = Math.max(0, (current.hour - 6) * HOUR_HEIGHT);
  }, [current.hour]);

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", weekView ? "border-y border-dls-border" : "rounded-lg border border-dls-border")} data-testid={`calendar-${props.view}-view`}>
      <div className="shrink-0 overflow-x-auto border-b border-dls-border bg-dls-surface">
        <div className="grid min-w-max" style={{ gridTemplateColumns }}>
          <div className={cn("border-r border-dls-border text-dls-secondary", weekView && "flex items-end justify-center pb-4 text-[11px]")}>
            {weekView ? timeZoneLabel(current) : null}
          </div>
          {props.days.map((day) => {
            const selected = day.equals(props.selectedDate);
            const isToday = day.equals(props.today);
            return (
              <button
                key={day.toString()}
                type="button"
                aria-current={day.equals(props.today) ? "date" : undefined}
                aria-pressed={selected}
                data-calendar-selected-day={selected ? "true" : undefined}
                onClick={() => props.onSelectDate(day)}
                className={cn(
                  "border-r border-dls-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dls-accent",
                  weekView ? "min-h-[5.75rem] px-4 py-3 text-left" : "px-3 py-2 text-center",
                  !weekView && selected && "bg-dls-active/45",
                  weekView && isToday && "text-dls-accent",
                )}
                data-testid={`calendar-time-day-${day.toString()}`}
              >
                <span className={cn("block", weekView ? "text-sm" : "text-xs text-dls-secondary", weekView && !isToday && "text-dls-secondary")}>{day.toLocaleString(props.locale, { weekday: "short" })}</span>
                <span className={cn(
                  weekView ? "mt-2 block text-2xl font-semibold" : "mt-0.5 inline-flex size-7 items-center justify-center rounded-full text-sm font-semibold text-dls-text",
                  !weekView && isToday && "bg-dls-accent text-white",
                  weekView && !isToday && "text-dls-text",
                )}>{day.day}</span>
              </button>
            );
          })}
        </div>
        {allDayRows > 0 ? (
          <div className="grid min-w-max border-t border-dls-border" style={{ gridTemplateColumns, gridTemplateRows: `repeat(${allDayRows}, minmax(1.75rem, auto))` }} aria-label={t("calendar.all_day_region")} data-testid="calendar-all-day-region">
            <div className="row-span-full border-r border-dls-border px-2 py-1 text-right text-[11px] text-dls-secondary">{t("calendar.all_day")}</div>
            {props.days.map((day, index) => <div key={day.toString()} className="border-r border-dls-border" style={{ gridColumn: index + 2, gridRow: `1 / span ${allDayRows}` }} />)}
            {layout.allDaySpans.map((span) => {
              const calendar = props.calendarsById.get(span.event.calendarId);
              return (
                <button
                  key={span.event.id}
                  type="button"
                  className="z-[1] m-0.5 truncate rounded px-2 py-1 text-left text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/50"
                  style={{ gridColumn: `${span.startIndex + 2} / ${span.endIndexExclusive + 2}`, gridRow: span.row + 1, backgroundColor: calendar?.color ?? "var(--dls-accent)" }}
                  onClick={() => props.onOpenEvent(span.event.id, props.days[span.startIndex]!)}
                  data-testid={`calendar-all-day-event-${span.event.id}`}
                >
                  {span.event.title}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div ref={timeGridRef} className="min-h-0 flex-1 overflow-auto" aria-label={t("calendar.time_grid")} data-testid="calendar-time-grid">
        <div className="relative grid min-w-max" style={{ gridTemplateColumns, height: DAY_HEIGHT }}>
          <div className="relative border-r border-dls-border">
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="absolute right-2 -translate-y-1/2 text-[10px] text-dls-secondary" style={{ top: hour * HOUR_HEIGHT }} data-testid={`calendar-time-hour-${hour}`}>
                {hourLabel(hour)}
              </span>
            ))}
          </div>
          {props.days.map((day, index) => {
            const segments = layout.timedByDate.get(day.toString()) ?? [];
            return (
              <div key={day.toString()} className="relative border-r border-dls-border" style={{ gridColumn: index + 2 }} data-testid={`calendar-time-column-${day.toString()}`}>
                {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="absolute inset-x-0 border-t border-dls-border/70" style={{ top: hour * HOUR_HEIGHT }} />)}
                {segments.map((segment) => {
                  const calendar = props.calendarsById.get(segment.event.calendarId);
                  const laneWidth = 100 / segment.laneCount;
                  const color = calendar?.color ?? "var(--dls-accent)";
                  return (
                    <button
                      key={`${segment.event.id}:${day.toString()}`}
                      type="button"
                      className="absolute z-[2] overflow-hidden rounded-md border-l-[3px] px-2 py-1 text-left text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent"
                      style={{
                        top: segment.startMinute / 60 * HOUR_HEIGHT,
                        height: Math.max((segment.endMinute - segment.startMinute) / 60 * HOUR_HEIGHT, 24),
                        left: `calc(${segment.lane * laneWidth}% + 2px)`,
                        width: `calc(${laneWidth * segment.laneSpan}% - 4px)`,
                        borderLeftColor: color,
                        backgroundColor: `color-mix(in srgb, ${color} 14%, var(--dls-surface))`,
                        color,
                      }}
                      onClick={() => props.onOpenEvent(segment.event.id, day)}
                      data-testid={`calendar-time-event-${day.toString()}-${segment.event.id}`}
                    >
                      <span className="block truncate font-semibold">{segment.event.title}</span>
                      <span className="block truncate text-[10px] opacity-75">{segmentLabel(segment, props.locale, props.displayTimeZone)}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {currentDayIndex >= 0 ? (
            <div
              className="pointer-events-none absolute inset-x-0 z-[4] grid -translate-y-1/2"
              style={{ top: currentMinute / 60 * HOUR_HEIGHT, gridTemplateColumns, gridTemplateRows: "1rem" }}
              role="img"
              aria-label={t("calendar.current_time")}
              data-testid="calendar-current-time"
              data-current-day-index={currentDayIndex}
            >
              <span className="bg-dls-surface pr-2 text-right text-[11px] font-medium leading-4" style={{ color: "#f54a45", gridColumn: 1, gridRow: 1 }} data-testid="calendar-current-time-label">{currentTimeLabel}</span>
              <span className="relative self-center" style={{ gridColumn: "2 / -1", gridRow: 1, height: 1, backgroundColor: "#f54a45" }} aria-hidden="true">
                <span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${currentDayIndex / props.days.length * 100}%`, backgroundColor: "#f54a45" }} />
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
