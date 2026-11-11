/** @jsxImportSource react */
import * as React from "react";
import { Temporal } from "@js-temporal/polyfill";
import { CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { formatCalendarMonth } from "./calendar-month-view";
import type { CalendarViewMode } from "./calendar-view-model";

function visibleTitle(view: CalendarViewMode, selectedDate: Temporal.PlainDate, days: readonly Temporal.PlainDate[], locale: string): string {
  if (view === "month") return formatCalendarMonth(selectedDate.toPlainYearMonth(), locale);
  if (view === "day") return selectedDate.toLocaleString(locale, { dateStyle: "full" });
  const start = days[0]!;
  const end = days[days.length - 1]!;
  const startLabel = start.toLocaleString(locale, { month: "short", day: "numeric" });
  const endLabel = end.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric" });
  return `${startLabel} – ${endLabel}`;
}

export function CalendarViewToolbar(props: {
  view: CalendarViewMode;
  selectedDate: Temporal.PlainDate;
  days: readonly Temporal.PlainDate[];
  locale: string;
  canCreate: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onViewChange: (view: CalendarViewMode) => void;
  onCreate: () => void;
}) {
  const previousTestId = `calendar-previous-${props.view}`;
  const nextTestId = `calendar-next-${props.view}`;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="calendar-view-toolbar">
      <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} onClick={props.onToday} data-testid="calendar-today">
        {t("calendar.today")}
      </button>
      <button type="button" className={buttonVariants({ variant: "ghost", size: "icon-sm" })} aria-label={t("calendar.previous_period")} onClick={props.onPrevious} data-testid={previousTestId}>
        <ChevronLeft className="size-4" aria-hidden="true" />
      </button>
      <button type="button" className={buttonVariants({ variant: "ghost", size: "icon-sm" })} aria-label={t("calendar.next_period")} onClick={props.onNext} data-testid={nextTestId}>
        <ChevronRight className="size-4" aria-hidden="true" />
      </button>
      <h3 className="ml-1 min-w-0 flex-1 text-[15px] font-semibold text-dls-text" aria-live="polite" data-testid={props.view === "month" ? "calendar-visible-month" : "calendar-visible-range"}>
        {visibleTitle(props.view, props.selectedDate, props.days, props.locale)}
      </h3>
      {props.canCreate ? (
        <button type="button" className={buttonVariants({ size: "sm" })} onClick={props.onCreate} data-testid="calendar-create-event">
          <CalendarPlus className="size-4" aria-hidden="true" />
          {t("calendar.create_event")}
        </button>
      ) : null}
      <div className="flex rounded-lg border border-dls-border bg-dls-sidebar p-0.5" role="group" aria-label={t("calendar.view_switcher")} data-testid="calendar-view-switcher">
        {(["day", "week", "month"] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-pressed={props.view === view}
            onClick={() => props.onViewChange(view)}
            className={cn(
              "min-w-12 rounded-md px-3 py-1 text-xs font-medium text-dls-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35",
              props.view === view && "bg-dls-surface text-dls-accent shadow-sm",
            )}
            data-testid={`calendar-view-${view}`}
          >
            {t(`calendar.${view}_view`)}
          </button>
        ))}
      </div>
    </div>
  );
}
