/** @jsxImportSource react */
import * as React from "react";
import { Temporal } from "@js-temporal/polyfill";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";

export const calendarEditorControl = "h-8 rounded-md border border-transparent bg-transparent px-2 text-sm text-dls-text outline-none transition-colors hover:bg-dls-hover focus-visible:border-dls-text/40 disabled:opacity-50";

function plainDate(value: string) {
  try { return Temporal.PlainDate.from(value); } catch { return Temporal.Now.plainDateISO(); }
}

/** A compact date field shared by the event form and the availability navigator. */
export function CalendarEditorDatePicker(props: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  testId: string;
  disabled?: boolean;
  compact?: boolean;
  timeZone?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = plainDate(props.value);
  const [month, setMonth] = React.useState(() => selected.with({ day: 1 }));
  const [focusedDate, setFocusedDate] = React.useState(props.value);
  const grid = React.useRef<HTMLDivElement>(null);
  const locale = currentLocale();
  const today = Temporal.Now.plainDateISO(props.timeZone);
  const first = month.subtract({ days: month.dayOfWeek - 1 });
  const days = Array.from({ length: 42 }, (_, i) => first.add({ days: i }));
  const changeOpen = (next: boolean) => {
    if (next) { setMonth(selected.with({ day: 1 })); setFocusedDate(props.value); }
    setOpen(next);
  };
  const moveMonth = (offset: number) => {
    const next = month.add({ months: offset });
    setMonth(next);
    setFocusedDate(next.toString());
  };
  const choose = (date: Temporal.PlainDate) => { props.onChange(date.toString()); setOpen(false); };
  const moveFocus = (date: Temporal.PlainDate) => {
    setMonth(date.with({ day: 1 }));
    setFocusedDate(date.toString());
    requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)?.focus());
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger render={<button type="button" disabled={props.disabled} className={cn(calendarEditorControl, "shrink-0 whitespace-nowrap px-1", props.compact ? "inline-flex min-w-0 items-center gap-1 font-medium" : "min-w-[114px]")} aria-label={props.label} data-testid={props.testId} />}>
        {locale === "zh" ? `${props.compact ? "" : `${selected.year}年`}${selected.month}月${selected.day}日` : selected.toLocaleString(locale, props.compact ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" })}
        {props.compact ? <><span>{selected.equals(today) ? t("calendar.today") : ""}</span><ChevronDown className="size-4 text-dls-secondary" /></> : null}
      </PopoverTrigger>
      {open ? <PopoverContent align="start" initialFocus={() => grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDate}"]`) ?? false} className="w-[280px] gap-2 rounded-md border border-dls-border bg-dls-surface p-3 text-dls-text shadow-xl" aria-label={props.label} data-testid={`${props.testId}-menu`} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      }}>
        <div className="flex items-center justify-between">
          <button type="button" className={calendarEditorControl} aria-label={t("calendar.previous_month")} onClick={() => moveMonth(-1)}><ChevronLeft className="size-4" /></button>
          <span className="text-sm font-medium" aria-live="polite">{locale === "zh" ? `${month.year}年${month.month}月` : month.toLocaleString(locale, { year: "numeric", month: "long" })}</span>
          <button type="button" className={calendarEditorControl} aria-label={t("calendar.next_month")} onClick={() => moveMonth(1)}><ChevronRight className="size-4" /></button>
        </div>
        <div className="grid grid-cols-7 text-center text-xs text-dls-secondary">{days.slice(0, 7).map(date => <span key={date.dayOfWeek} className="py-1">{date.toLocaleString(locale, { weekday: "narrow" })}</span>)}</div>
        <div ref={grid} className="grid grid-cols-7" role="grid" aria-label={props.label}>
          {Array.from({ length: 6 }, (_, row) => <div key={row} role="row" className="contents">{days.slice(row * 7, row * 7 + 7).map(date => <div key={date.toString()} role="gridcell" aria-selected={date.equals(selected)}>
            <button type="button" data-date={date.toString()} data-testid={`${props.testId}-day-${date}`} tabIndex={date.toString() === focusedDate ? 0 : -1} aria-label={date.toLocaleString(locale, { dateStyle: "full" })} aria-current={date.equals(today) ? "date" : undefined} className={cn("flex size-9 items-center justify-center rounded-md text-sm outline-none hover:bg-dls-hover focus-visible:ring-1 focus-visible:ring-dls-text", date.month !== month.month && "text-dls-secondary/50", date.equals(today) && "font-semibold", date.equals(selected) && "bg-dls-text text-dls-surface hover:bg-dls-text/90")} onClick={() => choose(date)} onKeyDown={(event) => {
              const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
              if (offset !== undefined) { event.preventDefault(); moveFocus(date.add({ days: offset })); }
              if (event.key === "PageUp" || event.key === "PageDown") { event.preventDefault(); moveFocus(date.add({ months: event.key === "PageUp" ? -1 : 1 })); }
              if (event.key === "Home" || event.key === "End") { event.preventDefault(); moveFocus(date.add({ days: (event.key === "Home" ? 1 : 7) - date.dayOfWeek })); }
            }}>{date.day}</button>
          </div>)}</div>)}
        </div>
        <button type="button" className={cn(calendarEditorControl, "w-full border-t border-dls-border")} onClick={() => choose(today)}>{t("calendar.today")}</button>
      </PopoverContent> : null}
    </Popover>
  );
}
