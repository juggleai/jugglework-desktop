/** @jsxImportSource react */
import * as React from "react";
import { Temporal } from "@js-temporal/polyfill";
import { Check, ChevronLeft, ChevronRight, MoreHorizontal, Users } from "lucide-react";

import type { DenCalendar } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import {
  calendarMonthGrid,
  calendarWeekdayOrder,
  type CalendarMonthNavigation,
  type CalendarWeekday,
} from "./calendar-month-model";

const WEEKDAY_REFERENCE: Record<CalendarWeekday, string> = {
  1: "2026-11-02", 2: "2026-11-03", 3: "2026-11-04", 4: "2026-11-05", 5: "2026-11-06", 6: "2026-11-07", 7: "2026-11-08",
};

export const CALENDAR_COLOR_PALETTE = [
  "#d84fa3", "#f54a45", "#ff7a1a", "#fbbd0b", "#2fbd50", "#2fc9b7",
  "#3370ff", "#3dbbed", "#4d55e7", "#7a36e8", "#bd35b5", "#8d949e",
] as const;

function weekdayLabel(weekday: CalendarWeekday, locale: string, style: "short" | "narrow" | "long"): string {
  return Temporal.PlainDate.from(WEEKDAY_REFERENCE[weekday]).toLocaleString(locale, { weekday: style });
}

export function formatCalendarMonth(month: Temporal.PlainYearMonth, locale: string): string {
  return month.toPlainDate({ day: 1 }).toLocaleString(locale, { year: "numeric", month: "long" });
}

function fullDateLabel(date: Temporal.PlainDate, locale: string): string {
  return date.toLocaleString(locale, { dateStyle: "full" });
}

export function CalendarMonthToolbar(props: {
  state: CalendarMonthNavigation;
  locale: string;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  return (
    <div className="flex items-center gap-2" data-testid="calendar-month-toolbar">
      <Button type="button" variant="outline" size="sm" onClick={props.onToday} data-testid="calendar-today">
        {t("calendar.today")}
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("calendar.previous_month")} onClick={props.onPrevious} data-testid="calendar-previous-month">
        <ChevronLeft className="size-4" aria-hidden="true" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("calendar.next_month")} onClick={props.onNext} data-testid="calendar-next-month">
        <ChevronRight className="size-4" aria-hidden="true" />
      </Button>
      <h3 className="ml-1 text-[15px] font-semibold text-dls-text" aria-live="polite" data-testid="calendar-visible-month">
        {formatCalendarMonth(props.state.month, props.locale)}
      </h3>
    </div>
  );
}

export function CalendarFilterList(props: {
  calendars: ReadonlyArray<{ calendar: DenCalendar; managed: boolean; onManageMembers?: () => void }>;
  hiddenIds: readonly string[];
  onToggle: (calendarId: string, visible: boolean) => void;
  onShowOnly: (calendarId: string) => void;
  onColorChange: (calendarId: string, color: string) => void;
}) {
  const hidden = new Set(props.hiddenIds);
  const managed = props.calendars.filter((item) => item.managed);
  const subscribed = props.calendars.filter((item) => !item.managed);
  return (
    <section aria-label={t("calendar.filter_title")} data-testid="calendar-filter-list">
      {props.calendars.length === 0 ? (
        <p className="px-1 text-sm text-dls-secondary" data-testid="calendar-filter-empty">{t("calendar.no_calendars")}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <CalendarFilterGroup id="managed" title={t("calendar.managed_calendars")} items={managed} hidden={hidden} onToggle={props.onToggle} onShowOnly={props.onShowOnly} onColorChange={props.onColorChange} />
          <CalendarFilterGroup id="subscribed" title={t("calendar.subscribed_calendars")} items={subscribed} hidden={hidden} onToggle={props.onToggle} onShowOnly={props.onShowOnly} onColorChange={props.onColorChange} emptyLabel={t("calendar.no_subscribed_calendars")} />
        </div>
      )}
    </section>
  );
}

function CalendarFilterGroup(props: {
  id: "managed" | "subscribed";
  title: string;
  items: ReadonlyArray<{ calendar: DenCalendar; onManageMembers?: () => void }>;
  hidden: ReadonlySet<string>;
  onToggle: (calendarId: string, visible: boolean) => void;
  onShowOnly: (calendarId: string) => void;
  onColorChange: (calendarId: string, color: string) => void;
  emptyLabel?: string;
}) {
  const [open, setOpen] = React.useState(true);
  const regionId = `calendar-filter-${props.id}-region`;
  return (
    <section data-testid={`calendar-filter-group-${props.id}`}>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-lg px-1 py-1 text-xs font-medium text-dls-secondary hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35"
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={`${open ? t("calendar.collapse") : t("calendar.expand")} ${props.title}`}
        onClick={() => setOpen((current) => !current)}
        data-testid={`calendar-filter-group-${props.id}-toggle`}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
        {props.title}
      </button>
      <div id={regionId} hidden={!open} data-testid={`calendar-filter-group-${props.id}-region`}>
        {props.items.length === 0 ? (
          props.emptyLabel ? <p className="px-5 py-1 text-xs text-dls-secondary">{props.emptyLabel}</p> : null
        ) : (
          <ul className="flex flex-col gap-0.5">
            {props.items.map(({ calendar, onManageMembers }) => {
              const visible = !props.hidden.has(calendar.id);
              return (
                <li key={calendar.id}>
                  <div className="group/calendar-row flex items-center rounded-lg px-5 py-0.5 hover:bg-dls-hover focus-within:bg-dls-hover">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 text-sm text-dls-text focus-within:ring-2 focus-within:ring-dls-accent/35">
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={visible}
                        onChange={(event) => props.onToggle(calendar.id, event.target.checked)}
                        data-testid={`calendar-filter-${calendar.id}`}
                      />
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-[3px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-dls-accent/40 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-dls-surface",
                          visible ? "text-white" : "bg-dls-surface dark:bg-dls-sidebar",
                        )}
                        style={{
                          backgroundColor: visible ? calendar.color ?? "var(--dls-accent)" : undefined,
                          borderColor: calendar.color ?? "var(--dls-border)",
                        }}
                        aria-hidden="true"
                        data-testid={`calendar-filter-check-${calendar.id}`}
                      >
                        {visible ? <Check className="size-3 stroke-[3.5] text-white" aria-hidden="true" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
                    </label>
                    {onManageMembers ? (
                      <button type="button" className="ml-1 rounded-md p-1 text-dls-secondary hover:bg-dls-surface hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35" aria-label={t("calendar.manage_members_label", { name: calendar.name })} aria-haspopup="dialog" onClick={onManageMembers} data-testid={`calendar-manage-members-${calendar.id}`}>
                        <Users className="size-4" aria-hidden="true" />
                      </button>
                    ) : null}
                    <CalendarColorMenu calendar={calendar} onShowOnly={() => props.onShowOnly(calendar.id)} onColorChange={(color) => props.onColorChange(calendar.id, color)} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function CalendarColorMenu(props: { calendar: DenCalendar; onShowOnly: () => void; onColorChange: (color: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-dls-secondary opacity-0 transition-opacity hover:bg-dls-surface hover:text-dls-text focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 group-hover/calendar-row:opacity-100 data-popup-open:opacity-100" aria-label={t("calendar.more_actions", { name: props.calendar.name })} data-testid={`calendar-more-${props.calendar.id}`} />}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-44 rounded-lg border border-dls-border bg-dls-surface p-1 text-dls-text shadow-xl before:hidden dark:bg-dls-surface">
        <DropdownMenuItem className="h-9 rounded-md px-3 font-normal focus:bg-dls-hover focus:text-dls-text" onClick={props.onShowOnly} data-testid={`calendar-show-only-${props.calendar.id}`}>
          {t("calendar.show_only_this")}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-9 rounded-md px-3 font-normal focus:bg-dls-hover focus:text-dls-text data-popup-open:bg-dls-hover data-popup-open:text-dls-text" data-testid={`calendar-change-color-${props.calendar.id}`}>
            {t("calendar.change_color")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent sideOffset={6} className="min-w-0 rounded-lg border border-dls-border bg-dls-surface p-3 text-dls-text shadow-xl before:hidden dark:bg-dls-surface" data-testid={`calendar-color-palette-${props.calendar.id}`}>
            <div className="grid grid-cols-6 gap-2" role="group" aria-label={t("calendar.change_color")}>
              {CALENDAR_COLOR_PALETTE.map((color) => {
                const selected = props.calendar.color?.toLowerCase() === color;
                return (
                  <button
                    key={color}
                    type="button"
                    className="flex size-8 items-center justify-center rounded-md outline-none ring-offset-2 ring-offset-dls-surface transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-dls-text"
                    style={{ backgroundColor: color }}
                    aria-label={t("calendar.choose_color", { color })}
                    aria-pressed={selected}
                    onClick={() => props.onColorChange(color)}
                    data-testid={`calendar-color-${props.calendar.id}-${color.slice(1)}`}
                  >
                    {selected ? <span className="flex size-6 items-center justify-center rounded-md border-2 border-white text-white"><Check className="size-4 stroke-[3]" aria-hidden="true" /></span> : null}
                  </button>
                );
              })}
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type GridProps = {
  state: CalendarMonthNavigation;
  today: Temporal.PlainDate;
  weekStart: CalendarWeekday;
  locale: string;
  onSelectDate: (date: Temporal.PlainDate) => void;
  onMoveSelection?: (days: number) => void;
  /** `selected` lets the cell expose its event chips to Tab only for the roving-focus day. */
  renderDayContent?: (date: Temporal.PlainDate, selected: boolean) => React.ReactNode;
};

function keyDelta(key: string): number | null {
  switch (key) {
    case "ArrowLeft": return -1;
    case "ArrowRight": return 1;
    case "ArrowUp": return -7;
    case "ArrowDown": return 7;
    default: return null;
  }
}

export function CalendarMiniMonth(props: GridProps & { onPrevious: () => void; onNext: () => void }) {
  const days = calendarMonthGrid(props.state.month, props.weekStart);
  const weekdays = calendarWeekdayOrder(props.weekStart);
  return (
    <section aria-label={t("calendar.mini_month")} data-testid="calendar-mini-month">
      <div className="mb-2 flex items-center gap-1 px-1">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-dls-text" aria-live="polite">{formatCalendarMonth(props.state.month, props.locale)}</p>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("calendar.previous_month")} onClick={props.onPrevious} data-testid="calendar-mini-previous-month">
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("calendar.next_month")} onClick={props.onNext} data-testid="calendar-mini-next-month">
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center" role="grid" aria-label={formatCalendarMonth(props.state.month, props.locale)}>
        <div role="row" className="contents">
          {weekdays.map((weekday) => (
            <span key={weekday} role="columnheader" className="py-1 text-[11px] text-dls-secondary" aria-label={weekdayLabel(weekday, props.locale, "long")}>
              {weekdayLabel(weekday, props.locale, "narrow")}
            </span>
          ))}
        </div>
        {chunkWeeks(days).map((week) => (
          <div key={week[0]!.toString()} role="row" className="contents">
            {week.map((day) => {
              const selected = day.equals(props.state.selectedDate);
              const outside = day.month !== props.state.month.month || day.year !== props.state.month.year;
              return (
                <button
                  key={day.toString()}
                  type="button"
                  role="gridcell"
                  aria-selected={selected}
                  aria-label={fullDateLabel(day, props.locale)}
                  aria-current={day.equals(props.today) ? "date" : undefined}
                  tabIndex={-1}
                  onClick={() => props.onSelectDate(day)}
                  className={cn(
                    "mx-auto flex size-7 items-center justify-center rounded-full text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35",
                    outside ? "text-dls-secondary/60" : "text-dls-text",
                    day.equals(props.today) && !selected && "font-semibold text-dls-accent",
                    selected ? "bg-dls-accent text-white" : "hover:bg-dls-hover",
                  )}
                  data-testid={`calendar-mini-day-${day.toString()}`}
                >
                  {day.day}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

export function CalendarMonthGrid(props: GridProps) {
  const days = calendarMonthGrid(props.state.month, props.weekStart);
  const weekdays = calendarWeekdayOrder(props.weekStart);
  const selectedRef = React.useRef<HTMLButtonElement | null>(null);
  const focusAfterMove = React.useRef(false);
  React.useEffect(() => {
    if (focusAfterMove.current) {
      focusAfterMove.current = false;
      selectedRef.current?.focus();
    }
  });
  const onKeyDown = (event: React.KeyboardEvent) => {
    const delta = keyDelta(event.key);
    if (delta === null || !props.onMoveSelection) return;
    event.preventDefault();
    focusAfterMove.current = true;
    props.onMoveSelection(delta);
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="calendar-month-grid">
      <div
        className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[auto_repeat(6,minmax(0,1fr))] border-l border-t border-dls-border"
        role="grid"
        aria-label={formatCalendarMonth(props.state.month, props.locale)}
        onKeyDown={onKeyDown}
      >
        <div role="row" className="contents">
          {weekdays.map((weekday) => (
            <span key={weekday} role="columnheader" className="border-b border-r border-dls-border px-2 py-1.5 text-xs font-medium text-dls-secondary" aria-label={weekdayLabel(weekday, props.locale, "long")}>
              {weekdayLabel(weekday, props.locale, "short")}
            </span>
          ))}
        </div>
        {chunkWeeks(days).map((week) => (
          <div key={week[0]!.toString()} role="row" className="contents">
            {week.map((day) => {
              const selected = day.equals(props.state.selectedDate);
              const outside = day.month !== props.state.month.month || day.year !== props.state.month.year;
              const isToday = day.equals(props.today);
              return (
                <div
                  key={day.toString()}
                  role="gridcell"
                  aria-selected={selected}
                  className={cn("flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-b border-r border-dls-border p-1", outside && "bg-dls-sidebar/40", selected && "bg-dls-active/40")}
                  data-testid={`calendar-day-${day.toString()}`}
                  data-outside-month={outside ? "true" : undefined}
                >
                  <button
                    ref={selected ? selectedRef : undefined}
                    type="button"
                    tabIndex={selected ? 0 : -1}
                    aria-label={fullDateLabel(day, props.locale)}
                    aria-current={isToday ? "date" : undefined}
                    data-calendar-selected-day={selected ? "true" : undefined}
                    onClick={() => props.onSelectDate(day)}
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center self-start rounded-full text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent focus-visible:ring-offset-1 focus-visible:ring-offset-dls-surface",
                      outside ? "text-dls-secondary/70" : "text-dls-text",
                      isToday ? "bg-dls-accent font-semibold text-white" : selected ? "font-semibold" : "hover:bg-dls-hover",
                    )}
                    data-testid={`calendar-day-button-${day.toString()}`}
                  >
                    {day.day}
                  </button>
                  {props.renderDayContent?.(day, selected)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function chunkWeeks(days: Temporal.PlainDate[]): Temporal.PlainDate[][] {
  const weeks: Temporal.PlainDate[][] = [];
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));
  return weeks;
}
