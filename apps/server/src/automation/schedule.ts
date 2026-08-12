import type { AutomationActiveRange, AutomationSchedule } from "@jugglework/types/automation";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SEARCH_YEARS = 12;

export type AutomationSchedulePreview = {
  nextRunAt: number | null;
  summary: string;
};

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/**
 * 计算指定时刻之后的首次有效触发时间。
 * @param schedule 版本化任务频率
 * @param activeRange 可选的闭区间生效日期
 * @param afterEpochMs 计算边界，结果必须严格晚于该时刻
 */
export function nextAutomationOccurrence(
  schedule: AutomationSchedule,
  activeRange: AutomationActiveRange | undefined,
  afterEpochMs: number,
): number | null {
  if (schedule.kind === "once") {
    if (!dateInRange(schedule.localDate, activeRange)) return null;
    const instant = zonedLocalToEpoch(`${schedule.localDate}T${schedule.localTime}`, schedule.timezone);
    return instant > afterEpochMs ? instant : null;
  }

  if (schedule.kind === "interval") {
    const anchor = zonedLocalToEpoch(`${schedule.anchorLocalDate}T${schedule.anchorLocalTime}`, schedule.timezone);
    const duration = schedule.every * intervalUnitMs(schedule.unit);
    const steps = Math.max(0, Math.floor((afterEpochMs - anchor) / duration) + 1);
    let candidate = anchor + steps * duration;
    if (candidate <= afterEpochMs) candidate += duration;
    const end = activeRange ? endOfLocalDate(activeRange.endDate, schedule.timezone) : Number.POSITIVE_INFINITY;
    // TIPS:无生效区间且星期限制排除了所有候选时，必须用固定上限收敛；一周内必然出现允许的星期。
    const guard = activeRange ? Number.POSITIVE_INFINITY : candidate + 8 * DAY_MS + duration;
    while (candidate <= end && candidate <= guard) {
      const localDate = localDateAt(candidate, schedule.timezone);
      if (dateInRange(localDate, activeRange) && intervalWeekdayMatches(schedule, localDate)) return candidate;
      candidate += duration;
    }
    return null;
  }

  const afterLocal = localParts(afterEpochMs, schedule.timezone);
  let cursor = utcDate(afterLocal.year, afterLocal.month, afterLocal.day);
  const rangeStart = activeRange ? parseDate(activeRange.startDate) : null;
  if (rangeStart && cursor < rangeStart) cursor = rangeStart;
  const rangeEnd = activeRange ? parseDate(activeRange.endDate) : addUtcYears(cursor, SEARCH_YEARS);
  const hardEnd = activeRange ? rangeEnd : addUtcYears(cursor, SEARCH_YEARS);

  for (; cursor <= hardEnd; cursor += DAY_MS) {
    const date = utcDateString(cursor);
    if (!dateInRange(date, activeRange) || !calendarMatches(schedule, cursor)) continue;
    const candidate = zonedLocalToEpoch(`${date}T${schedule.localTime}`, schedule.timezone);
    if (candidate > afterEpochMs) return candidate;
  }
  return null;
}

/** 返回不晚于指定时刻的最近一次有效触发，用于休眠/重启后的 latest-only 补偿。 */
export function latestAutomationOccurrenceAtOrBefore(
  schedule: AutomationSchedule,
  activeRange: AutomationActiveRange | undefined,
  atEpochMs: number,
): number | null {
  if (schedule.kind === "once") {
    if (!dateInRange(schedule.localDate, activeRange)) return null;
    const instant = zonedLocalToEpoch(`${schedule.localDate}T${schedule.localTime}`, schedule.timezone);
    return instant <= atEpochMs ? instant : null;
  }
  if (schedule.kind === "interval") {
    const anchor = zonedLocalToEpoch(`${schedule.anchorLocalDate}T${schedule.anchorLocalTime}`, schedule.timezone);
    if (anchor > atEpochMs) return null;
    const duration = schedule.every * intervalUnitMs(schedule.unit);
    let candidate = anchor + Math.floor((atEpochMs - anchor) / duration) * duration;
    const start = activeRange ? zonedLocalToEpoch(`${activeRange.startDate}T00:00`, schedule.timezone) : Number.NEGATIVE_INFINITY;
    const floor = Math.max(start, anchor, candidate - 8 * DAY_MS - duration);
    while (candidate >= floor) {
      const localDate = localDateAt(candidate, schedule.timezone);
      if (dateInRange(localDate, activeRange) && intervalWeekdayMatches(schedule, localDate)) return candidate;
      candidate -= duration;
    }
    return null;
  }

  const atLocal = localParts(atEpochMs, schedule.timezone);
  let cursor = utcDate(atLocal.year, atLocal.month, atLocal.day);
  const rangeStart = activeRange ? parseDate(activeRange.startDate) : addUtcYears(cursor, -SEARCH_YEARS);
  if (activeRange && cursor > parseDate(activeRange.endDate)) cursor = parseDate(activeRange.endDate);
  for (; cursor >= rangeStart; cursor -= DAY_MS) {
    const date = utcDateString(cursor);
    if (!dateInRange(date, activeRange) || !calendarMatches(schedule, cursor)) continue;
    const candidate = zonedLocalToEpoch(`${date}T${schedule.localTime}`, schedule.timezone);
    if (candidate <= atEpochMs) return candidate;
  }
  return null;
}

/** 返回可直接展示在创建页和列表中的本地化频率摘要。 */
export function automationScheduleSummary(schedule: AutomationSchedule, locale = "zh-CN"): string {
  const timeZone = schedule.timezone;
  if (schedule.kind === "once") return `${schedule.localDate} ${schedule.localTime} · ${timeZone}`;
  if (schedule.kind === "interval") {
    const units = locale.startsWith("zh")
      ? { minute: "分钟", hour: "小时", day: "天" }
      : { minute: "minute(s)", hour: "hour(s)", day: "day(s)" };
    const weekdays = schedule.weekdays?.length && schedule.weekdays.length < 7 ? schedule.weekdays : null;
    if (locale.startsWith("zh")) {
      const zh = ["一", "二", "三", "四", "五", "六", "日"];
      const days = weekdays ? `（${weekdays.map((day) => `周${zh[day - 1]}`).join("、")}）` : "";
      return `每 ${schedule.every} ${units[schedule.unit]}${days} · ${timeZone}`;
    }
    const days = weekdays ? ` (${weekdays.join(", ")})` : "";
    return `Every ${schedule.every} ${units[schedule.unit]}${days} · ${timeZone}`;
  }
  if (schedule.frequency === "daily") return locale.startsWith("zh")
    ? `每天 ${schedule.localTime} · ${timeZone}`
    : `Daily at ${schedule.localTime} · ${timeZone}`;
  if (schedule.frequency === "weekly") {
    const zh = ["一", "二", "三", "四", "五", "六", "日"];
    const days = locale.startsWith("zh")
      ? schedule.weekdays.map((day) => `周${zh[day - 1]}`).join("、")
      : schedule.weekdays.join(", ");
    return locale.startsWith("zh")
      ? `每周 ${days} ${schedule.localTime} · ${timeZone}`
      : `Weekly on ${days} at ${schedule.localTime} · ${timeZone}`;
  }
  if (schedule.frequency === "monthly") return locale.startsWith("zh")
    ? `每月 ${schedule.dayOfMonth} 日 ${schedule.localTime} · ${timeZone}`
    : `Monthly on day ${schedule.dayOfMonth} at ${schedule.localTime} · ${timeZone}`;
  return locale.startsWith("zh")
    ? `每年 ${schedule.month} 月 ${schedule.dayOfMonth} 日 ${schedule.localTime} · ${timeZone}`
    : `Yearly on ${schedule.month}/${schedule.dayOfMonth} at ${schedule.localTime} · ${timeZone}`;
}

/** 同时返回摘要和精确的下一次触发时间。 */
export function previewAutomationSchedule(
  schedule: AutomationSchedule,
  activeRange: AutomationActiveRange | undefined,
  afterEpochMs: number,
  locale = "zh-CN",
): AutomationSchedulePreview {
  return {
    nextRunAt: nextAutomationOccurrence(schedule, activeRange, afterEpochMs),
    summary: automationScheduleSummary(schedule, locale),
  };
}

/**
 * 将无时区本地日期时间转换为 UTC 毫秒。
 * TIPS: 先用相邻日期采样时区偏移解决绝大多数日期，再按分钟扫描兜底；重叠取较早时刻，
 * DST 缺口取当天请求时间之后的首个有效本地分钟，规则不依赖宿主系统时区。
 */
export function zonedLocalToEpoch(localDateTime: string, timeZone: string): number {
  const target = parseLocalDateTime(localDateTime);
  const naive = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = naive + hours * 60 * MINUTE_MS;
    offsets.add(localAsUtc(sample, timeZone) - sample);
  }
  const exact = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) => sameLocalMinute(localParts(candidate, timeZone), target))
    .sort((a, b) => a - b);
  if (exact.length) return exact[0];

  const start = naive - 16 * 60 * MINUTE_MS;
  const end = naive + 16 * 60 * MINUTE_MS;
  for (let candidate = start; candidate <= end; candidate += MINUTE_MS) {
    const local = localParts(candidate, timeZone);
    if (sameLocalDate(local, target) && compareLocal(local, target) > 0) return candidate;
  }
  throw new RangeError(`Local date/time cannot be resolved in ${timeZone}: ${localDateTime}`);
}

function calendarMatches(schedule: Extract<AutomationSchedule, { kind: "calendar" }>, date: number): boolean {
  const value = new Date(date);
  if (schedule.frequency === "daily") return true;
  if (schedule.frequency === "weekly") {
    const weekday = value.getUTCDay() || 7;
    return schedule.weekdays.includes(weekday);
  }
  if (schedule.frequency === "monthly") return value.getUTCDate() === schedule.dayOfMonth;
  return value.getUTCMonth() + 1 === schedule.month && value.getUTCDate() === schedule.dayOfMonth;
}

/** 判断本地日期是否落在按间隔任务允许的星期内；未配置或配置为空表示不限制。 */
function intervalWeekdayMatches(
  schedule: Extract<AutomationSchedule, { kind: "interval" }>,
  localDate: string,
): boolean {
  const weekdays = schedule.weekdays;
  if (!weekdays?.length) return true;
  return weekdays.includes(new Date(parseDate(localDate)).getUTCDay() || 7);
}

function intervalUnitMs(unit: Extract<AutomationSchedule, { kind: "interval" }>["unit"]): number {
  if (unit === "minute") return MINUTE_MS;
  if (unit === "hour") return 60 * MINUTE_MS;
  return DAY_MS;
}

function endOfLocalDate(date: string, timeZone: string): number {
  const next = new Date(parseDate(date) + DAY_MS);
  return zonedLocalToEpoch(`${utcDateString(next.getTime())}T00:00`, timeZone) - 1;
}

function dateInRange(date: string, range: AutomationActiveRange | undefined): boolean {
  return !range || (date >= range.startDate && date <= range.endDate);
}

function localDateAt(epoch: number, timeZone: string): string {
  const value = localParts(epoch, timeZone);
  return `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}`;
}

function localParts(epoch: number, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(epoch);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute") };
}

function localAsUtc(epoch: number, timeZone: string): number {
  const local = localParts(epoch, timeZone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
}

function parseLocalDateTime(value: string): LocalDateTime {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Invalid local date/time: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]) };
}

function compareLocal(left: LocalDateTime, right: LocalDateTime): number {
  return Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute)
    - Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute);
}

function sameLocalMinute(left: LocalDateTime, right: LocalDateTime): boolean {
  return compareLocal(left, right) === 0;
}

function sameLocalDate(left: LocalDateTime, right: LocalDateTime): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function parseDate(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return utcDate(year, month, day);
}

function utcDate(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

function utcDateString(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

function addUtcYears(epoch: number, years: number): number {
  const date = new Date(epoch);
  return Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate());
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}
