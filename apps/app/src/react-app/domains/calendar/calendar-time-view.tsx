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
const CREATE_SLOT_WIDTH = 28;

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
  currentMemberId: string;
  onSelectDate: (date: Temporal.PlainDate) => void;
  onOpenEvent: (eventId: string, date: Temporal.PlainDate, click: React.MouseEvent<HTMLButtonElement>) => void;
  onCreateAt?: (slot: { date: Temporal.PlainDate; startMinute: number; durationMinutes?: number; snapToHalfHour?: boolean; clientX: number; clientY: number }) => void;
  quickCreatePreview?: { title: string; calendarColor: string; startDate: string; startTime: string; endDate: string; endTime: string };
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
          <div className={cn("border-r border-dls-border text-dls-secondary", weekView && "flex items-end justify-center pb-3 text-[10px] leading-4")}>
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
                  weekView ? "min-h-[4.5rem] px-3 py-2 text-left" : "px-3 py-2 text-center",
                  !weekView && selected && "bg-dls-active/45",
                  weekView && isToday && "bg-[rgba(var(--dls-accent-rgb),0.07)] text-dls-accent dark:bg-[color:color-mix(in_oklab,color-mix(in_oklab,var(--dls-accent)_65%,white)_18%,transparent)] dark:text-[color:color-mix(in_oklab,var(--dls-accent)_42%,white)]",
                )}
                data-today={isToday ? "true" : undefined}
                data-testid={`calendar-time-day-${day.toString()}`}
              >
                <span className={cn("block", weekView ? "text-xs leading-4" : "text-xs text-dls-secondary", weekView && !isToday && "text-dls-secondary")}>{day.toLocaleString(props.locale, { weekday: "short" })}</span>
                <span className={cn(
                  weekView ? "mt-1 flex size-8 items-center justify-center rounded-full text-xl font-semibold leading-none" : "mt-0.5 inline-flex size-7 items-center justify-center rounded-full text-sm font-semibold text-dls-text",
                  !weekView && isToday && "bg-dls-accent text-white",
                  weekView && isToday && "bg-dls-accent text-[var(--dls-accent-fg)] shadow-[0_0_0_3px_rgba(var(--dls-accent-rgb),0.12)] dark:bg-[color:color-mix(in_oklab,var(--dls-accent)_58%,white_42%)] dark:text-black dark:shadow-[0_0_0_3px_rgba(255,255,255,0.12)]",
                  weekView && !isToday && "text-dls-text",
                )}>{day.day}</span>
              </button>
            );
          })}
        </div>
        {allDayRows > 0 ? (
          <div className="grid min-w-max border-t border-dls-border" style={{ gridTemplateColumns, gridTemplateRows: `repeat(${allDayRows}, minmax(1.75rem, auto))` }} aria-label={t("calendar.all_day_region")} data-testid="calendar-all-day-region">
            <div className="row-span-full border-r border-dls-border px-2 py-1 text-right text-[11px] text-dls-secondary">{t("calendar.all_day")}</div>
            {props.days.map((day, index) => {
              const isToday = day.equals(props.today);
              return <div key={day.toString()} className={cn("border-r border-dls-border", weekView && isToday && "bg-[rgba(var(--dls-accent-rgb),0.045)] dark:bg-[color:color-mix(in_oklab,color-mix(in_oklab,var(--dls-accent)_65%,white)_12%,transparent)]")} style={{ gridColumn: index + 2, gridRow: `1 / span ${allDayRows}` }} data-today={isToday ? "true" : undefined} data-testid={`calendar-all-day-column-${day.toString()}`} />;
            })}
            {layout.allDaySpans.map((span) => {
              const calendar = props.calendarsById.get(span.event.calendarId);
              const responseStatus = currentAttendeeResponse(span.event, props.currentMemberId);
              const declined = responseStatus === "declined";
              const tentative = responseStatus === "tentative";
              return (
                <button
                  key={span.event.id}
                  type="button"
                  className={cn("z-[1] m-0.5 truncate rounded px-2 py-1 text-left text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/50", declined && "bg-[#e5e6e8] text-[#8f959e] line-through dark:bg-white/[0.07] dark:text-white/25", tentative && "opacity-80")}
                  style={{ gridColumn: `${span.startIndex + 2} / ${span.endIndexExclusive + 2}`, gridRow: span.row + 1, backgroundColor: declined ? undefined : calendar?.color ?? "var(--dls-accent)" }}
                  onClick={(click) => props.onOpenEvent(span.event.id, props.days[span.startIndex]!, click)}
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
              <span key={hour} className={cn("absolute right-2 text-[10px] leading-4 text-dls-secondary", hour === 0 ? "translate-y-1" : "-translate-y-1/2")} style={{ top: hour * HOUR_HEIGHT }} data-testid={`calendar-time-hour-${hour}`}>
                {hourLabel(hour)}
              </span>
            ))}
          </div>
          {props.days.map((day, index) => {
            const segments = layout.timedByDate.get(day.toString()) ?? [];
            const isToday = day.equals(props.today);
            return (
              <div key={day.toString()} className={cn("relative border-r border-dls-border", weekView && isToday && "bg-[rgba(var(--dls-accent-rgb),0.045)] dark:bg-[color:color-mix(in_oklab,color-mix(in_oklab,var(--dls-accent)_65%,white)_12%,transparent)]")} style={{ gridColumn: index + 2 }} data-today={isToday ? "true" : undefined} data-testid={`calendar-time-column-${day.toString()}`}>
                {props.onCreateAt ? <button
                  type="button"
                  className="absolute inset-0 z-0 cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dls-accent/45"
                  aria-label={`${t("calendar.create_event")} · ${day.toLocaleString(props.locale, { dateStyle: "full" })}`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const clientY = event.detail === 0 ? rect.top + 9 * HOUR_HEIGHT : event.clientY;
                    props.onCreateAt?.({ date: day, startMinute: calendarSlotMinute(clientY, rect), clientX: event.detail === 0 ? rect.left + Math.min(rect.width / 2, 80) : event.clientX, clientY });
                  }}
                  data-testid={`calendar-time-create-${day.toString()}`}
                /> : null}
                {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="pointer-events-none absolute inset-x-0 border-t border-dls-border/70" style={{ top: hour * HOUR_HEIGHT }} />)}
                {quickCreateLayout(props.quickCreatePreview, day) ? (() => {
                  const preview = quickCreateLayout(props.quickCreatePreview, day)!;
                  const compact = preview.durationMinutes < 45;
                  return <div
                    className={cn("pointer-events-none absolute inset-x-0 z-[3] mx-0.5 overflow-hidden rounded-md border border-dls-accent/70 bg-[color:color-mix(in_srgb,var(--quick-calendar-color)_24%,var(--dls-surface))] px-2 text-left text-xs text-dls-accent shadow-sm dark:border-[color:color-mix(in_oklab,var(--quick-calendar-color)_65%,white)] dark:bg-[color:color-mix(in_srgb,var(--quick-calendar-color)_34%,var(--dls-surface))] dark:text-[color:color-mix(in_oklab,var(--quick-calendar-color)_42%,white)]", compact ? "flex items-center gap-1.5 py-0 leading-none" : "py-1")}
                    style={{ top: preview.startMinute / 60 * HOUR_HEIGHT, height: Math.max(preview.durationMinutes / 60 * HOUR_HEIGHT, 24), "--quick-calendar-color": props.quickCreatePreview!.calendarColor } as React.CSSProperties}
                    data-compact={compact ? "true" : undefined}
                    data-testid={`calendar-quick-create-preview-${day.toString()}`}
                  >
                    <span className={cn("min-w-0 truncate font-semibold", compact ? "shrink" : "block")}>{props.quickCreatePreview!.title.trim() || t("calendar.create_event")}</span>
                    <span className={cn("truncate text-[10px] opacity-80", compact ? "min-w-0 shrink tabular-nums" : "block")}>{compact ? "· " : ""}{props.quickCreatePreview!.startTime} – {props.quickCreatePreview!.endTime}</span>
                  </div>;
                })() : null}
                {props.onCreateAt ? calendarCreateSlots(segments).map((slot) => {
                  const startMinute = Math.floor(slot.startMinute);
                  const endMinute = Math.floor(slot.endMinute);
                  return <button
                    key={`${slot.startMinute}:${slot.endMinute}:${slot.laneCount}`}
                    type="button"
                    className="absolute z-[1] cursor-crosshair rounded-sm bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dls-accent/60 hover:bg-dls-active/25"
                    style={{
                      top: slot.startMinute / 60 * HOUR_HEIGHT,
                      height: Math.max((slot.endMinute - slot.startMinute) / 60 * HOUR_HEIGHT, 24),
                      left: `calc(100% - ${CREATE_SLOT_WIDTH - 2}px)`,
                      width: CREATE_SLOT_WIDTH - 4,
                    }}
                    aria-label={`${t("calendar.create_event")} · ${segmentLabel(slot.source, props.locale, props.displayTimeZone)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      props.onCreateAt?.({
                        date: day,
                        startMinute,
                        durationMinutes: Math.max(endMinute - startMinute, 1),
                        snapToHalfHour: false,
                        clientX: event.detail === 0 ? rect.left + Math.min(rect.width / 2, 80) : event.clientX,
                        clientY: event.detail === 0 ? rect.top + Math.min(rect.height / 2, 16) : event.clientY,
                      });
                    }}
                    data-testid={`calendar-time-create-alongside-${day.toString()}-${startMinute}-${endMinute}`}
                  />;
                }) : null}
                {segments.map((segment) => {
                  const calendar = props.calendarsById.get(segment.event.calendarId);
                  const laneOffsetRatio = segment.lane / segment.laneCount;
                  const laneWidthRatio = segment.laneSpan / segment.laneCount;
                  const reservedWidth = props.onCreateAt ? CREATE_SLOT_WIDTH : 0;
                  const color = calendar?.color ?? "var(--dls-accent)";
                  const responseStatus = currentAttendeeResponse(segment.event, props.currentMemberId);
                  const declined = responseStatus === "declined";
                  const tentative = responseStatus === "tentative";
                  const compact = segment.endMinute - segment.startMinute < 45;
                  return (
                    <button
                      key={`${segment.event.id}:${day.toString()}`}
                      type="button"
                      className={cn("absolute z-[2] overflow-hidden rounded-md border-l-[3px] px-2 text-left text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent", compact ? "flex items-center gap-1.5 py-0 leading-none" : "py-1", declined && "border-l-[#8f959e] bg-[#f2f3f5] text-[#8f959e] line-through dark:border-l-white/15 dark:bg-white/[0.07] dark:text-white/25", tentative && "border-l-[5px]")}
                      style={{
                        top: segment.startMinute / 60 * HOUR_HEIGHT,
                        height: Math.max((segment.endMinute - segment.startMinute) / 60 * HOUR_HEIGHT, 24),
                        left: `calc(${laneOffsetRatio * 100}% - ${reservedWidth * laneOffsetRatio}px + 2px)`,
                        width: `calc(${laneWidthRatio * 100}% - ${reservedWidth * laneWidthRatio}px - 4px)`,
                        borderLeftColor: declined ? undefined : color,
                        backgroundColor: declined ? undefined : `color-mix(in srgb, ${color} ${tentative ? 8 : 14}%, var(--dls-surface))`,
                        color: declined ? undefined : color,
                      }}
                      onClick={(click) => props.onOpenEvent(segment.event.id, day, click)}
                      data-compact={compact ? "true" : undefined}
                      data-testid={`calendar-time-event-${day.toString()}-${segment.event.id}`}
                    >
                      <span className={cn("min-w-0 truncate font-semibold", compact ? "shrink" : "block")}>{segment.event.title}</span>
                      <span className={cn("truncate text-[10px] opacity-75", compact ? "min-w-0 shrink tabular-nums" : "block")}>{compact ? "· " : ""}{segmentLabel(segment, props.locale, props.displayTimeZone)}</span>
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

export function calendarSlotMinute(clientY: number, rect: Pick<DOMRect, "top" | "height">): number {
  const localY = Math.min(Math.max(clientY - rect.top, 0), Math.max(rect.height - Number.EPSILON, 0));
  const rawMinute = rect.height > 0 ? localY / rect.height * 24 * 60 : 0;
  return Math.min(23 * 60 + 30, Math.max(0, Math.floor(rawMinute / 30) * 30));
}

function quickCreateLayout(preview: { startDate: string; startTime: string; endDate: string; endTime: string } | undefined, day: Temporal.PlainDate): { startMinute: number; durationMinutes: number } | null {
  if (!preview || preview.startDate !== day.toString()) return null;
  try {
    const start = Temporal.PlainDateTime.from(`${preview.startDate}T${preview.startTime}`);
    const end = Temporal.PlainDateTime.from(`${preview.endDate}T${preview.endTime}`);
    const durationMinutes = start.until(end).total({ unit: "minutes" });
    if (!(durationMinutes > 0)) return null;
    return { startMinute: start.hour * 60 + start.minute, durationMinutes };
  } catch {
    return null;
  }
}

function calendarCreateSlots(segments: readonly CalendarTimedSegment[]): Array<{ startMinute: number; endMinute: number; laneCount: number; source: CalendarTimedSegment }> {
  const slots = new Map<string, { startMinute: number; endMinute: number; laneCount: number; source: CalendarTimedSegment }>();
  for (const segment of segments) {
    const key = `${segment.startMinute}:${segment.endMinute}:${segment.laneCount}`;
    if (!slots.has(key)) slots.set(key, { startMinute: segment.startMinute, endMinute: segment.endMinute, laneCount: segment.laneCount, source: segment });
  }
  return [...slots.values()];
}

function currentAttendeeResponse(event: DenCalendarEvent, memberId: string): "needs-action" | "accepted" | "declined" | "tentative" | undefined {
  if (!("attendees" in event) || !Array.isArray(event.attendees)) return undefined;
  return event.attendees.find((attendee) => attendee.memberId === memberId)?.responseStatus;
}
