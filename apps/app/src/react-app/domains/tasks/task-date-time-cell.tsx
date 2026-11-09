import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bell, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";

import type { DenProductTask, DenProductTaskReminder } from "@/app/lib/den";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";

export type TaskTimeField = "startAt" | "dueAt";
export type TaskReminderDraft = { mode: "due_relative"; dueOffsetSeconds: number } | { mode: "absolute"; scheduledAt: string } | null;

type ReminderKey = "before_5m" | "before_15m" | "before_30m" | "before_1h" | "before_2h" | "before_1d" | "same_day_18" | "before_1d_9" | "before_2d_9";
type DateParts = { date: string; specific: boolean; hour: number; minute: number };
const timedReminderOptions: Array<[ReminderKey, number]> = [["before_5m", -300], ["before_15m", -900], ["before_30m", -1800], ["before_1h", -3600], ["before_2h", -7200], ["before_1d", -86400]];
const dateReminderOptions: ReminderKey[] = ["same_day_18", "before_1d_9", "before_2d_9"];
const timeOptions = Array.from({ length: 48 }, (_, index) => ({ hour: Math.floor(index / 2), minute: index % 2 * 30 }));

const pad = (value: number) => String(value).padStart(2, "0");
const timeLabel = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
const localDateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseDateKey = (value: string) => { const [year, month, day] = value.split("-").map(Number); return new Date(year!, month! - 1, day!); };
const shiftDate = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
const shiftMonth = (date: Date, months: number) => new Date(date.getFullYear(), date.getMonth() + months, 1);
const monthDays = (cursor: Date) => { const first = monthStart(cursor); const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay()); return Array.from({ length: 42 }, (_, index) => shiftDate(start, index)); };

function valueParts(value: string | null): DateParts {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return { date: "", specific: false, hour: 9, minute: 0 };
  const roundedMinutes = date.getMinutes() < 15 ? 0 : date.getMinutes() < 45 ? 30 : 0;
  const hour = date.getMinutes() >= 45 ? (date.getHours() + 1) % 24 : date.getHours();
  return { date: localDateKey(date), specific: date.getHours() !== 0 || date.getMinutes() !== 0, hour, minute: roundedMinutes };
}

function isoValue(parts: DateParts) {
  if (!parts.date) return null;
  const date = parseDateKey(parts.date);
  date.setHours(parts.specific ? parts.hour : 0, parts.specific ? parts.minute : 0, 0, 0);
  return date.toISOString();
}

function displayValue(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const specific = date.getHours() !== 0 || date.getMinutes() !== 0;
  return new Intl.DateTimeFormat(undefined, specific ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false } : { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function reminderDraft(key: ReminderKey, dueAt: string): TaskReminderDraft {
  const relative = timedReminderOptions.find(([value]) => value === key);
  if (relative) return { mode: "due_relative", dueOffsetSeconds: relative[1] };
  const due = new Date(dueAt);
  const scheduled = shiftDate(due, key === "same_day_18" ? 0 : key === "before_1d_9" ? -1 : -2);
  scheduled.setHours(key === "same_day_18" ? 18 : 9, 0, 0, 0);
  return { mode: "absolute", scheduledAt: scheduled.toISOString() };
}

function reminderKey(reminder: DenProductTaskReminder | null, dueAt: string | null): ReminderKey | null {
  if (!reminder || !dueAt) return null;
  if (reminder.mode === "due_relative") return timedReminderOptions.find(([, seconds]) => seconds === reminder.dueOffsetSeconds)?.[0] ?? null;
  const due = new Date(dueAt);
  const scheduled = new Date(reminder.scheduledAt);
  const difference = Math.round((new Date(scheduled.getFullYear(), scheduled.getMonth(), scheduled.getDate()).getTime() - new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime()) / 86_400_000);
  if (difference === 0 && scheduled.getHours() === 18) return "same_day_18";
  if (difference === -1 && scheduled.getHours() === 9) return "before_1d_9";
  if (difference === -2 && scheduled.getHours() === 9) return "before_2d_9";
  return null;
}

function DateTimeRow(props: { taskId: string; field: TaskTimeField; parts: DateParts; active: boolean; specific: boolean; pending: boolean; onActivate: () => void; onTimeChange: (hour: number, minute: number) => void }) {
  const dateLabel = props.parts.date ? props.parts.date.replaceAll("-", "/") : t(props.field === "startAt" ? "tasks.start_date_optional" : "tasks.due_date");
  return <div className={`mt-2 grid overflow-hidden rounded-lg border text-sm ${props.active ? "border-blue-8 ring-1 ring-blue-8/20" : "border-dls-border"} ${props.specific ? "grid-cols-[1fr_1px_1fr]" : "grid-cols-1"}`}>
    <button type="button" data-testid={`task-time-date-input-${props.taskId}-${props.field}`} disabled={props.pending} onClick={props.onActivate} className={`h-10 truncate px-3 text-left ${props.parts.date ? "text-dls-text" : "text-dls-secondary"}`}>{dateLabel}</button>
    {props.specific ? <><div className="my-2 bg-dls-border" /><DropdownMenu><DropdownMenuTrigger render={<button type="button" data-testid={`task-time-menu-trigger-${props.taskId}-${props.field}`} disabled={!props.parts.date || props.pending} onClick={props.onActivate} className="flex h-10 items-center justify-between px-3 text-left text-dls-text disabled:text-dls-secondary" />}><span>{props.parts.date ? timeLabel(props.parts.hour, props.parts.minute) : t(props.field === "startAt" ? "tasks.start_time" : "tasks.due_time")}</span><ChevronDown className="size-3.5 text-dls-secondary" /></DropdownMenuTrigger><DropdownMenuContent align="start" side="bottom" sideOffset={4} className="max-h-72 w-36 min-w-36 overflow-y-auto rounded-xl p-1.5">{timeOptions.map(({ hour, minute }) => { const selected = props.parts.hour === hour && props.parts.minute === minute; return <DropdownMenuItem key={`${hour}:${minute}`} data-testid={`task-time-option-${props.taskId}-${props.field}-${pad(hour)}-${pad(minute)}`} onClick={() => props.onTimeChange(hour, minute)} className={`rounded-lg px-3 py-2.5 ${selected ? "bg-dls-hover text-blue-10" : ""}`}><span className="flex-1">{timeLabel(hour, minute)}</span>{selected ? <Check className="size-4 text-blue-10" /> : null}</DropdownMenuItem>; })}</DropdownMenuContent></DropdownMenu></> : null}
  </div>;
}

export function TaskDateTimeCell(props: { task: DenProductTask; field: TaskTimeField; triggerContent?: ReactNode; triggerClassName?: string; onChange?: (task: DenProductTask, field: TaskTimeField, value: string | null) => Promise<boolean>; onLoadReminders?: (task: DenProductTask) => Promise<DenProductTaskReminder[]>; onReminderChange?: (task: DenProductTask, reminder: TaskReminderDraft) => Promise<boolean> }) {
  const original = { startAt: props.task.startAt, dueAt: props.task.dueAt };
  const [saved, setSaved] = useState(original);
  const [drafts, setDrafts] = useState<Record<TaskTimeField, DateParts>>({ startAt: valueParts(original.startAt), dueAt: valueParts(original.dueAt) });
  const [activeField, setActiveField] = useState<TaskTimeField>(props.field);
  const [specific, setSpecific] = useState(() => valueParts(original.startAt).specific || valueParts(original.dueAt).specific);
  const [cursor, setCursor] = useState(() => monthStart(original[props.field] ? new Date(original[props.field]!) : new Date()));
  const [pending, setPending] = useState(false);
  const [selectedReminder, setSelectedReminder] = useState<ReminderKey | null>(null);
  useEffect(() => { const next = { startAt: props.task.startAt, dueAt: props.task.dueAt }; setSaved(next); setDrafts({ startAt: valueParts(next.startAt), dueAt: valueParts(next.dueAt) }); }, [props.task.startAt, props.task.dueAt]);

  const persist = async (field: TaskTimeField, parts: DateParts) => {
    if (!props.onChange) return false;
    const value = isoValue(parts);
    const success = await props.onChange(props.task, field, value);
    if (!success) return false;
    setSaved((current) => ({ ...current, [field]: value }));
    setDrafts((current) => ({ ...current, [field]: parts }));
    if (field === "dueAt" && props.onReminderChange && selectedReminder) {
      const valid = (parts.specific ? timedReminderOptions.map(([key]) => key) : dateReminderOptions).includes(selectedReminder);
      if (value && valid) await props.onReminderChange(props.task, reminderDraft(selectedReminder, value));
      else { await props.onReminderChange(props.task, null); setSelectedReminder(null); }
    }
    return true;
  };
  const commit = async (field: TaskTimeField, parts: DateParts) => { if (pending) return; setPending(true); const success = await persist(field, parts); if (!success) setDrafts((current) => ({ ...current, [field]: valueParts(saved[field]) })); setPending(false); };
  const setReminder = async (key: ReminderKey) => { const dueAt = isoValue(drafts.dueAt); if (!props.onReminderChange || !dueAt || pending) return; setPending(true); const success = await props.onReminderChange(props.task, reminderDraft(key, dueAt)); setPending(false); if (success) setSelectedReminder(key); };
  const toggleSpecific = async (enabled: boolean) => {
    if (pending) return;
    setSpecific(enabled); setPending(true);
    for (const field of ["startAt", "dueAt"] as const) {
      const current = drafts[field];
      if (!current.date) continue;
      const next = { ...current, specific: enabled, hour: enabled && !current.specific ? 9 : current.hour, minute: enabled ? current.minute : 0 };
      await persist(field, next);
    }
    setPending(false);
  };
  const clearAll = async () => { if (pending) return; setPending(true); for (const field of ["startAt", "dueAt"] as const) if (drafts[field].date) await persist(field, { ...drafts[field], date: "", specific: false }); if (selectedReminder && props.onReminderChange) await props.onReminderChange(props.task, null); setSelectedReminder(null); setSpecific(false); setPending(false); };
  const days = useMemo(() => monthDays(cursor), [cursor]);
  const reminderOptions = specific ? timedReminderOptions.map(([key]) => key) : dateReminderOptions;
  const triggerValue = saved[props.field];
  const triggerLabel = displayValue(triggerValue);

  return <Popover onOpenChange={(open) => { if (!open) return; const next = { startAt: valueParts(saved.startAt), dueAt: valueParts(saved.dueAt) }; setDrafts(next); setActiveField(props.field); setSpecific(next.startAt.specific || next.dueAt.specific); setCursor(monthStart(saved[props.field] ? new Date(saved[props.field]!) : new Date())); if (props.onLoadReminders) void props.onLoadReminders(props.task).then((items) => setSelectedReminder(reminderKey(items.find((item) => item.state === "scheduled") ?? null, saved.dueAt))); }}>
    <PopoverTrigger render={<button type="button" data-testid={`task-time-trigger-${props.task.id}-${props.field}`} disabled={!props.onChange} className={props.triggerClassName ?? "flex min-h-8 min-w-24 items-center rounded-md px-1 text-left outline-none transition-colors hover:bg-dls-hover data-popup-open:ring-1 data-popup-open:ring-blue-8 disabled:cursor-default"} />}>{props.triggerContent ?? (triggerLabel ? <span>{triggerLabel}</span> : <CalendarDays className="size-[18px] text-dls-secondary/45" aria-label={t(props.field === "startAt" ? "tasks.field_start" : "tasks.field_due")} />)}</PopoverTrigger>
    <PopoverContent align="start" side="bottom" sideOffset={5} data-testid={`task-time-picker-${props.task.id}-${props.field}`} className="w-[360px] gap-0 rounded-xl border border-dls-border bg-dls-surface p-0 shadow-xl">
      <div className="p-4"><div className="mb-3 flex items-center justify-between"><button type="button" className="font-semibold text-dls-text" onClick={() => setCursor(monthStart(new Date()))}>{new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long" }).format(cursor)}</button><div className="flex items-center gap-1"><button type="button" aria-label={t("tasks.previous_month")} className="flex size-8 items-center justify-center rounded-md hover:bg-dls-hover" onClick={() => setCursor((value) => shiftMonth(value, -1))}><ChevronLeft className="size-4" /></button><button type="button" aria-label={t("tasks.next_month")} className="flex size-8 items-center justify-center rounded-md hover:bg-dls-hover" onClick={() => setCursor((value) => shiftMonth(value, 1))}><ChevronRight className="size-4" /></button></div></div>
        <div className="grid grid-cols-7 text-center text-xs text-dls-secondary">{Array.from({ length: 7 }, (_, day) => <span key={day} className="py-2">{new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(new Date(2026, 10, 1 + day))}</span>)}</div>
        <div className="grid grid-cols-7 gap-y-1">{days.map((day) => { const key = localDateKey(day); const active = key === drafts[activeField].date; const currentMonth = day.getMonth() === cursor.getMonth(); return <button key={key} type="button" data-testid={`task-time-day-${props.task.id}-${props.field}-${key}`} disabled={pending} onClick={() => void commit(activeField, { ...drafts[activeField], date: key, specific })} className={`mx-auto flex size-9 items-center justify-center rounded-full text-sm ${active ? "bg-blue-9 text-white" : currentMonth ? "text-dls-text hover:bg-dls-hover" : "text-dls-secondary/55 hover:bg-dls-hover"}`}>{day.getDate()}</button>; })}</div>
        <div className="mt-4"><DateTimeRow taskId={props.task.id} field="startAt" parts={drafts.startAt} active={activeField === "startAt"} specific={specific} pending={pending} onActivate={() => setActiveField("startAt")} onTimeChange={(hour, minute) => void commit("startAt", { ...drafts.startAt, specific: true, hour, minute })} /><DateTimeRow taskId={props.task.id} field="dueAt" parts={drafts.dueAt} active={activeField === "dueAt"} specific={specific} pending={pending} onActivate={() => setActiveField("dueAt")} onTimeChange={(hour, minute) => void commit("dueAt", { ...drafts.dueAt, specific: true, hour, minute })} /></div>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-dls-text"><input type="checkbox" data-testid={`task-time-specific-${props.task.id}-${props.field}`} checked={specific} disabled={pending} onChange={(event) => void toggleSpecific(event.target.checked)} className="size-4 accent-blue-9" />{t("tasks.specific_time")}</label>
      </div>
      <div className="border-t border-dls-border p-3"><DropdownMenu><DropdownMenuTrigger render={<button type="button" data-testid={`task-reminder-trigger-${props.task.id}`} disabled={!drafts.dueAt.date || pending} className="flex h-10 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:text-dls-secondary" />}><Bell className="size-4" /><span className="min-w-0 flex-1 truncate">{selectedReminder ? t(`tasks.reminder_${selectedReminder}`) : t("tasks.due_reminder")}</span><ChevronDown className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-72 rounded-xl p-1.5">{reminderOptions.map((key) => <DropdownMenuItem key={key} data-testid={`task-reminder-option-${props.task.id}-${key}`} onClick={() => void setReminder(key)} className={`rounded-lg px-3 py-2.5 ${selectedReminder === key ? "bg-dls-hover text-blue-10" : ""}`}><span className="flex-1">{t(`tasks.reminder_${key}`)}</span>{selectedReminder === key ? <Check className="size-4 text-blue-10" /> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>
      <div className="flex items-center justify-between border-t border-dls-border px-4 py-3"><RotateCcw className="size-4 text-dls-secondary" /><button type="button" data-testid={`task-time-clear-${props.task.id}-${props.field}`} disabled={pending || (!drafts.startAt.date && !drafts.dueAt.date)} onClick={() => void clearAll()} className="text-sm text-dls-secondary hover:text-dls-text disabled:opacity-40">{t("tasks.clear_all")}</button></div>
    </PopoverContent>
  </Popover>;
}
