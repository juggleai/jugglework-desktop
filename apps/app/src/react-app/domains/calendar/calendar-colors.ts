import type { DenCalendar } from "@/app/lib/den";

/** Shared selectable and default-assignment palette. The first calendar starts blue. */
export const CALENDAR_COLOR_PALETTE = [
  "#3370ff", "#d84fa3", "#2fbd50", "#ff7a1a", "#7a36e8", "#2fc9b7",
  "#f54a45", "#fbbd0b", "#3dbbed", "#4d55e7", "#bd35b5", "#8d949e",
] as const;

export function nextCalendarColor(colors: readonly (string | null | undefined)[], cycleIndex = colors.length): string {
  const used = new Set(colors.filter((color): color is string => Boolean(color)).map((color) => color.toLowerCase()));
  return CALENDAR_COLOR_PALETTE.find((color) => !used.has(color))
    ?? CALENDAR_COLOR_PALETTE[cycleIndex % CALENDAR_COLOR_PALETTE.length]!;
}

/** Gives legacy null-color calendars deterministic palette colors without changing explicit colors. */
export function withDefaultCalendarColors<T extends DenCalendar>(calendars: readonly T[]): T[] {
  const assignedColors = calendars.map((calendar) => calendar.color).filter((color): color is string => Boolean(color));
  const defaults = new Map<string, string>();
  let cycleIndex = 0;
  for (const calendar of calendars.filter((calendar) => !calendar.color).toSorted((left, right) => left.id.localeCompare(right.id))) {
    const color = nextCalendarColor(assignedColors, cycleIndex);
    if (assignedColors.some((assigned) => assigned.toLowerCase() === color)) cycleIndex += 1;
    else assignedColors.push(color);
    defaults.set(calendar.id, color);
  }
  return calendars.map((calendar) => calendar.color ? calendar : { ...calendar, color: defaults.get(calendar.id)! });
}
