/** @jsxImportSource react */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlignLeft, Bell, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Eye, EyeOff, LoaderCircle, Search, Trash2, Users, Video, X } from "lucide-react";
import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendar, DenCalendarAvailabilityInput, DenCalendarEvent, DenCalendarSchedulingEvent, DenOrganizationMember } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { CalendarEditorSelect } from "./calendar-editor-select";
import { CalendarEditorDatePicker, calendarEditorControl } from "./calendar-editor-date-picker";
import type { CalendarScope } from "./calendar-scope";
import {
  calendarMutationConflict,
  useCalendarSchedulingEventMutations,
  useCreateCalendarEventMutation,
  useDeleteCalendarEventMutation,
  useTeamCalendarEventMutations,
  useUpdateCalendarEventMutation,
  type CalendarMutationClient,
  type CalendarSchedulingMutationClient,
  type TeamCalendarEventMutationClient,
} from "./calendar-mutations";
import { setCanonicalCalendarEvent, useCalendarAvailabilityQuery, useCalendarOrganizationMembersQuery, type CalendarCollaborationQueryClient, type CalendarSchedulingQueryClient } from "./calendar-queries";
import { getAllGroupMembers, getChatGroupsForContacts } from "../jugglechat/api";
import type { OrganizationChatGroup } from "../jugglechat/types";
import {
  calendarEventToForm,
  calendarEventUpdatePatch,
  CALENDAR_EVENT_ATTENDEE_MAX,
  classifyCalendarSaveFailure,
  defaultCalendarRecurrence,
  switchCalendarFormTimeKind,
  validateCalendarEventForm,
  type CalendarEventFormErrors,
  type CalendarEventFormValues,
  type CalendarSaveFailure,
} from "./calendar-event-form-model";

type EditorStatus =
  | { kind: "editing" }
  | { kind: "pending" }
  | { kind: "validation"; errors: CalendarEventFormErrors }
  | { kind: "failed"; failure: CalendarSaveFailure }
  | { kind: "conflict"; current: DenCalendarEvent | null; operation: "save" | "delete" }
  | { kind: "draft-saved" }
  | { kind: "draft-failed" };

export type CalendarEventEditorProps = {
  client: CalendarMutationClient & TeamCalendarEventMutationClient & CalendarSchedulingMutationClient & CalendarSchedulingQueryClient & CalendarCollaborationQueryClient;
  scope: CalendarScope;
  calendars: readonly DenCalendar[];
  teamCalendarIds?: ReadonlySet<string>;
  timeZone: string;
  /** Existing event for edit mode; omitted for create. */
  event?: DenCalendarEvent;
  initial: CalendarEventFormValues;
  onSaved: (event: DenCalendarEvent) => void;
  onDeleted: (eventId: string) => void;
  onCancel: () => void;
  /** false while offline: authoritative save/delete are unavailable; only a local draft may be kept. */
  online?: boolean;
  /** Present when local draft storage is available. */
  onSaveDraft?: (form: CalendarEventFormValues, base: DenCalendarEvent | undefined) => Promise<void>;
  /** Shown when the form was restored from an unsynced local draft. */
  restoredFromDraft?: boolean;
  /** A restored edit draft based on an older version: require explicit resolution before saving. */
  staleDraftBase?: boolean;
  onDiscardDraft?: () => void;
  /** Create flows use a large modal; edit flows remain in the event side panel. */
  presentation?: "panel" | "dialog";
};

const inputClass = "h-8 w-full min-w-0 rounded-lg border border-dls-border bg-dls-surface px-2 text-sm text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 aria-[invalid=true]:border-red-500";
const timeOptions = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`);
const reminderOptions = [0, 5, 15, 30, 60, 120, 1440, 2880] as const;
const MAX_SCHEDULING_MEMBERS = CALENDAR_EVENT_ATTENDEE_MAX;

function reminderLabel(minutes: number): string {
  if (minutes === 0) return t("calendar.reminder_at_start");
  if (minutes < 60) return t("calendar.reminder_minutes_before", { count: minutes });
  if (minutes < 1440) return t("calendar.reminder_hours_before", { count: minutes / 60 });
  return t("calendar.reminder_days_before", { count: minutes / 1440 });
}

function memberName(member: DenOrganizationMember): string {
  return member.user.name?.trim() || member.user.account?.trim() || member.user.email?.trim() || member.userId;
}

function CalendarMemberAvatar({ member, name }: { member?: DenOrganizationMember; name: string }) {
  const [failedSource, setFailedSource] = React.useState<string | null>(null);
  const source = member?.user.avatar;
  return <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-dls-text/10 text-sm font-medium text-dls-text" aria-hidden="true">
    {source && source !== failedSource ? <img src={source} alt="" className="size-full object-cover" onError={() => setFailedSource(source)} /> : name.slice(0, 1).toLocaleUpperCase()}
  </span>;
}

function groupMemberRoster(result: unknown): unknown[] {
  const envelope = result && typeof result === "object" && "data" in result ? (result as { data: unknown }).data : result;
  if (!envelope || typeof envelope !== "object") return Array.isArray(envelope) ? envelope : [];
  const value = envelope as Record<string, unknown>;
  return Array.isArray(value.items) ? value.items : Array.isArray(value.members) ? value.members : [];
}

function availabilityRange(form: CalendarEventFormValues, memberIds: readonly string[], timeZone: string, date = form.time.startDate): DenCalendarAvailabilityInput | null {
  try {
    const startDate = Temporal.PlainDate.from(date);
    const endDate = startDate.add({ days: 1 });
    return {
      memberIds: [...new Set(memberIds)].sort(),
      startInstant: startDate.toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from("00:00") }).toInstant().toString(),
      endInstantExclusive: endDate.toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from("00:00") }).toInstant().toString(),
      timeZone,
    };
  } catch {
    return null;
  }
}

function CalendarTimePicker(props: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  testId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const selectedOption = React.useRef<HTMLButtonElement>(null);
  const menuId = React.useId();
  React.useEffect(() => { if (open) selectedOption.current?.scrollIntoView?.({ block: "nearest" }); }, [open, props.value]);
  return (
    <Popover open={open} onOpenChange={(next, details) => {
      // Focusing an editable trigger and pressing it must not immediately toggle it closed.
      if (!next && details.reason === "trigger-press") return;
      setOpen(next);
    }} onOpenChangeComplete={(isOpen) => { if (isOpen) selectedOption.current?.scrollIntoView?.({ block: "center" }); }}>
      <PopoverTrigger
        nativeButton={false}
        render={(
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            className="h-8 w-14 rounded-md border border-transparent bg-transparent px-1 text-center text-sm text-dls-text outline-none transition-colors hover:bg-dls-hover focus:border-dls-text/40 focus:bg-dls-surface"
            aria-label={props.label}
            value={props.value}
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.target.value)}
            role="combobox"
            aria-haspopup="listbox"
            aria-controls={open ? menuId : undefined}
            aria-activedescendant={open && timeOptions.includes(props.value) ? `${menuId}-${props.value}` : undefined}
            aria-expanded={open}
            onKeyDown={(event) => {
              if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
              if (event.key === "Enter" && open) { event.preventDefault(); setOpen(false); }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = timeOptions.indexOf(props.value);
                props.onChange(timeOptions[(Math.max(0, index) + (event.key === "ArrowDown" ? 1 : -1) + timeOptions.length) % timeOptions.length]!);
                setOpen(true);
              }
              if (event.key === "Tab") setOpen(false);
            }}
            data-testid={props.testId}
          />
        )}
      />
      {open ? (
        <PopoverContent
          align="start"
          className="max-h-[244px] w-40 gap-0 overflow-y-auto rounded-md border border-dls-border bg-dls-surface p-1 shadow-xl"
          id={menuId}
          role="listbox"
          initialFocus={false}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}
          aria-label={props.label}
          data-testid={`${props.testId}-menu`}
        >
          {timeOptions.map((value) => (
            <button
              key={value}
              ref={value === props.value ? selectedOption : undefined}
              id={`${menuId}-${value}`}
              role="option"
              aria-selected={value === props.value}
              type="button"
              className={cn(
                "flex h-8 w-full shrink-0 items-center justify-between rounded px-2 text-left text-sm text-dls-text outline-none hover:bg-dls-hover focus-visible:bg-dls-hover",
                value === props.value && "bg-dls-hover font-medium",
              )}
              onClick={() => { props.onChange(value); setOpen(false); }}
              data-testid={`${props.testId}-option-${value.replace(":", "")}`}
            >
              <span>{value}</span>
              {value === props.value ? <Check className="size-4" aria-hidden="true" /> : null}
            </button>
          ))}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function CalendarAvailabilityPanel(props: {
  date: string;
  onDateChange: (date: string) => void;
  dialog: boolean;
  form: CalendarEventFormValues;
  memberIds: readonly string[];
  membersById: Map<string, DenOrganizationMember>;
  availabilityByMemberId: Map<string, { memberId: string; busy: Array<{ startInstant: string; endInstantExclusive: string }> } | { memberId: string; unknown: true }>;
  error: boolean;
  online: boolean;
  timeZone: string;
}) {
  const date = props.date;
  const scrollArea = React.useRef<HTMLDivElement>(null);
  const [now, setNow] = React.useState(() => Temporal.Now.zonedDateTimeISO(props.timeZone));
  React.useEffect(() => {
    setNow(Temporal.Now.zonedDateTimeISO(props.timeZone));
    const timer = setInterval(() => setNow(Temporal.Now.zonedDateTimeISO(props.timeZone)), 60_000);
    return () => clearInterval(timer);
  }, [props.timeZone]);
  const today = now.toPlainDate().toString();
  React.useEffect(() => {
    const hour = date === today
      ? now.hour
      : props.form.time.kind === "timed" ? Number(props.form.time.startTime.split(":")[0]) : 8;
    if (scrollArea.current) scrollArea.current.scrollTop = Math.max(0, hour - 1) * 48;
  }, [date, today, props.form.time.kind === "timed" ? props.form.time.startTime : null]);
  const moveDay = (days: number) => {
    try { props.onDateChange(Temporal.PlainDate.from(date).add({ days }).toString()); } catch { /* Incomplete date input. */ }
  };
  const dayBounds = React.useMemo(() => {
    try {
      const startDate = Temporal.PlainDate.from(date);
      const start = startDate.toZonedDateTime({ timeZone: props.timeZone, plainTime: Temporal.PlainTime.from("00:00") }).toInstant();
      const end = startDate.add({ days: 1 }).toZonedDateTime({ timeZone: props.timeZone, plainTime: Temporal.PlainTime.from("00:00") }).toInstant();
      return { start: start.epochMilliseconds, duration: end.epochMilliseconds - start.epochMilliseconds };
    } catch {
      return null;
    }
  }, [date, props.timeZone]);
  const intervalPosition = (instant: string) => {
    try {
      if (!dayBounds) return 0;
      const value = Temporal.Instant.from(instant).epochMilliseconds;
      return Math.max(0, Math.min(100, ((value - dayBounds.start) / dayBounds.duration) * 100));
    } catch {
      return 0;
    }
  };
  const attendeeIds = props.memberIds;
  const timelineColumns = `3.5rem repeat(${Math.max(1, attendeeIds.length)}, minmax(6.5rem, 1fr))`;
  const zoneOffset = React.useMemo(() => {
    try {
      return Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: props.timeZone, plainTime: Temporal.PlainTime.from("12:00") }).offset;
    } catch {
      return "";
    }
  }, [date, props.timeZone]);
  const selection = React.useMemo(() => {
    try {
      const time = props.form.time;
      if (time.kind === "allDay") {
        return date >= time.startDate && date < time.endDateExclusive ? { top: 0, bottom: 100 } : null;
      }
      const start = Temporal.PlainDate.from(time.startDate).toZonedDateTime({ timeZone: props.timeZone, plainTime: Temporal.PlainTime.from(time.startTime) }).toInstant();
      const end = Temporal.PlainDate.from(time.endDate).toZonedDateTime({ timeZone: props.timeZone, plainTime: Temporal.PlainTime.from(time.endTime) }).toInstant();
      const top = intervalPosition(start.toString());
      const bottom = intervalPosition(end.toString());
      return bottom > top ? { top, bottom } : null;
    } catch { return null; }
  }, [props.form.time, dayBounds]);
  return (
    <aside className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-dls-surface", props.dialog && "hidden min-[850px]:flex")} aria-label={t("calendar.availability")} data-testid="calendar-availability-panel">
      <div className="flex h-[68px] shrink-0 items-center gap-2 border-b border-dls-border px-5" data-testid="calendar-availability-date">
        <button type="button" className={cn(calendarEditorControl, "border-dls-border px-3")} onClick={() => props.onDateChange(today)} data-testid="calendar-availability-today">{t("calendar.today")}</button>
        <button type="button" className={cn(calendarEditorControl, "w-6 px-0")} aria-label={t("calendar.previous_period")} onClick={() => moveDay(-1)} data-testid="calendar-availability-previous"><ChevronLeft className="size-5" /></button>
        <button type="button" className={cn(calendarEditorControl, "w-6 px-0")} aria-label={t("calendar.next_period")} onClick={() => moveDay(1)} data-testid="calendar-availability-next"><ChevronRight className="size-5" /></button>
        <CalendarEditorDatePicker timeZone={props.timeZone} compact value={date} onChange={props.onDateChange} label={t("calendar.availability")} testId="calendar-availability-date-picker" />
      </div>
      {!props.online ? <p className="m-4 rounded-lg bg-dls-hover p-3 text-xs text-dls-secondary" data-testid="calendar-availability-offline">{t("calendar.availability_offline")}</p> : null}
      {props.online && attendeeIds.length === 0 ? <p className="m-4 rounded-lg bg-dls-hover p-3 text-xs text-dls-secondary">{t("calendar.availability_empty")}</p> : null}
      {props.online && props.error ? <p className="sr-only" role="alert">{t("calendar.availability_failed")}</p> : null}
      {attendeeIds.length > 0 ? (
        <div ref={scrollArea} className="min-h-0 flex-1 overflow-auto" data-testid="calendar-availability-vertical-timeline">
          <div className="sticky top-0 z-20 grid min-w-max border-b border-dls-border bg-dls-surface" style={{ gridTemplateColumns: timelineColumns }}>
            <div className="flex h-[88px] items-end border-r border-dls-border px-2 pb-2 text-[10px] text-dls-secondary">GMT{zoneOffset.replace(/([+-])0?(\d+):00/, "$1$2")}</div>
            {attendeeIds.map((memberId) => {
              const member = props.membersById.get(memberId);
              const name = member ? memberName(member) : memberId;
              return (
                <div key={memberId} className="flex h-[88px] min-w-0 flex-col items-start justify-center gap-2 border-r border-dls-border px-2" data-testid={`calendar-availability-member-${memberId}`}>
                  <CalendarMemberAvatar member={member} name={name} />
                  <span className="max-w-full truncate text-xs text-dls-text">{name}</span>
                </div>
              );
            })}
          </div>
          <div className="relative grid h-[1152px] min-w-max" style={{ gridTemplateColumns: timelineColumns }} aria-label={t("calendar.availability_busy_free")}>
            <div className="relative border-r border-dls-border">
              {Array.from({ length: 23 }, (_, index) => index + 1).map((hour) => (
                <span key={hour} className="absolute right-2 -translate-y-1/2 text-[10px] text-dls-secondary" style={{ top: `${(hour / 24) * 100}%` }}>{String(hour).padStart(2, "0")}:00</span>
              ))}
            </div>
            {attendeeIds.map((memberId) => {
              const availability = props.availabilityByMemberId.get(memberId);
              const unknown = !availability || "unknown" in availability;
              return (
                <div key={memberId} className="relative border-r border-dls-border">
                  {Array.from({ length: 25 }, (_, hour) => <span key={hour} className="absolute inset-x-0 h-px bg-dls-border" style={{ top: `${(hour / 24) * 100}%` }} />)}
                  {unknown ? <span className="absolute inset-x-2 top-3 rounded-md border border-dashed border-dls-border px-2 py-1 text-center text-[10px] text-dls-secondary">{t("calendar.availability_unknown")}</span> : null}
                  {!unknown && "busy" in availability ? availability.busy.map((busy, index) => {
                    const top = intervalPosition(busy.startInstant);
                    const bottom = intervalPosition(busy.endInstantExclusive);
                    return <span key={`${busy.startInstant}:${index}`} className="absolute inset-x-1 rounded border-l-2 border-dls-text/60 bg-dls-text/15" style={{ top: `${top}%`, height: `${Math.max(0.5, bottom - top)}%` }} data-testid={`calendar-busy-${memberId}-${index}`} />;
                  }) : null}
                </div>
              );
            })}
            {selection ? <div className="pointer-events-none absolute right-0 left-14 border-y border-dls-text/20 bg-dls-text/15" style={{ top: `${selection.top}%`, height: `${selection.bottom - selection.top}%` }} data-testid="calendar-availability-selection" /> : null}
            {date === today ? <div className="pointer-events-none absolute inset-x-0 z-30 flex -translate-y-1/2 items-center" style={{ top: `${intervalPosition(now.toInstant().toString())}%` }} data-testid="calendar-availability-now"><span className="w-14 shrink-0 bg-dls-surface pr-2 text-right text-[11px] font-medium text-red-500">{now.toPlainTime().toString().slice(0, 5)}</span><span className="relative h-0.5 flex-1 bg-red-500 shadow-[0_0_0_1px_rgba(255,255,255,0.7)]"><span className="absolute -left-1 top-1/2 size-2 -translate-y-1/2 rounded-full bg-red-500" /></span></div> : null}
          </div>
        </div>
      ) : null}
      <p className="sr-only">{t("calendar.availability_privacy")}</p>
    </aside>
  );
}

export function CalendarEventEditor(props: CalendarEventEditorProps) {
  const queryClient = useQueryClient();
  const createMutation = useCreateCalendarEventMutation(props.client, props.scope);
  const updateMutation = useUpdateCalendarEventMutation(props.client, props.scope);
  const deleteMutation = useDeleteCalendarEventMutation(props.client, props.scope);
  const teamMutations = useTeamCalendarEventMutations(props.client, props.scope);
  const schedulingMutations = useCalendarSchedulingEventMutations(props.client, props.scope);
  const creatorMemberId = props.event?.ownerMemberId ?? props.scope.memberId;
  const [form, setForm] = React.useState(() => ensureRequiredCreatorAttendee(
    props.initial,
    creatorMemberId,
    props.teamCalendarIds,
  ));
  const [availabilityDate, setAvailabilityDate] = React.useState(props.initial.time.startDate);
  React.useEffect(() => { setAvailabilityDate(form.time.startDate); }, [form.time.startDate]);
  const [hiddenAvailabilityMemberIds, setHiddenAvailabilityMemberIds] = React.useState<Set<string>>(() => new Set());
  const [reminders, setReminders] = React.useState(() => [{ id: 0, minutes: 5 }]);
  const nextReminderId = React.useRef(1);
  const [openReminderId, setOpenReminderId] = React.useState<number | null>(null);
  const [zoneOpen, setZoneOpen] = React.useState(false);
  const descriptionInput = React.useRef<HTMLTextAreaElement | null>(null);
  const [peopleOpen, setPeopleOpen] = React.useState(false);
  const [peopleSearch, setPeopleSearch] = React.useState("");
  const [groups, setGroups] = React.useState<OrganizationChatGroup[]>([]);
  const [groupsError, setGroupsError] = React.useState<string | null>(null);
  const [groupFeedback, setGroupFeedback] = React.useState<string | null>(null);
  const [loadingGroupId, setLoadingGroupId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<EditorStatus>(() =>
    props.staleDraftBase && props.event ? { kind: "conflict", current: props.event, operation: "save" } : { kind: "editing" });
  // The version the form was based on; moves forward only when the user explicitly resolves a conflict.
  const [base, setBase] = React.useState<DenCalendarEvent | undefined>(props.event);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const lastSubmitted = React.useRef<string | null>(null);
  const appliedSchedulingAuthority = React.useRef<string | null>(null);
  const formId = React.useId();
  const titleInput = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => { titleInput.current?.focus(); }, []);
  const isEdit = Boolean(props.event);
  const dialogPresentation = props.presentation === "dialog";
  const online = props.online ?? true;
  const pending = status.kind === "pending";
  const errors = status.kind === "validation" ? status.errors : {};
  const activeIds = props.calendars.map((calendar) => calendar.id);
  const teamSelected = props.teamCalendarIds?.has(form.calendarId) === true;
  const advancedScheduling = form.attendeeMemberIds.some((memberId) => memberId !== creatorMemberId) || form.recurrence.frequency !== "none";
  const membersQuery = useCalendarOrganizationMembersQuery({ client: props.client, scope: props.scope, active: online });
  const members = membersQuery.data ?? [];
  const membersById = React.useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const memberIdByUserId = React.useMemo(() => new Map(members.map((member) => [member.userId, member.id])), [members]);
  const invitedAttendeeMemberIds = React.useMemo(
    () => form.attendeeMemberIds.filter((memberId) => memberId !== creatorMemberId),
    [creatorMemberId, form.attendeeMemberIds],
  );
  const visibleAvailabilityMemberIds = React.useMemo(
    () => form.attendeeMemberIds.filter((memberId) => !hiddenAvailabilityMemberIds.has(memberId)),
    [form.attendeeMemberIds, hiddenAvailabilityMemberIds],
  );
  React.useEffect(() => {
    setHiddenAvailabilityMemberIds((current) => {
      const next = new Set([...current].filter((memberId) => form.attendeeMemberIds.includes(memberId)));
      return next.size === current.size ? current : next;
    });
  }, [form.attendeeMemberIds]);
  const [debouncedAvailability, setDebouncedAvailability] = React.useState<DenCalendarAvailabilityInput | null>(null);
  const nextAvailability = React.useMemo(() => availabilityRange(form, visibleAvailabilityMemberIds, props.timeZone, availabilityDate), [form.time, props.timeZone, visibleAvailabilityMemberIds, availabilityDate]);
  React.useEffect(() => {
    if (!online || !nextAvailability?.memberIds.length) {
      setDebouncedAvailability(null);
      return;
    }
    const timeout = setTimeout(() => setDebouncedAvailability(nextAvailability), 300);
    return () => clearTimeout(timeout);
  }, [nextAvailability, online]);
  const availabilityQuery = useCalendarAvailabilityQuery({ client: props.client, scope: props.scope, request: debouncedAvailability, active: online });
  const availabilityCurrent = nextAvailability !== null && debouncedAvailability !== null &&
    JSON.stringify(nextAvailability.memberIds) === JSON.stringify(debouncedAvailability.memberIds) &&
    nextAvailability.startInstant === debouncedAvailability.startInstant && nextAvailability.endInstantExclusive === debouncedAvailability.endInstantExclusive;
  const retainedAvailability = React.useRef(new Map<string, { memberId: string; busy: Array<{ startInstant: string; endInstantExclusive: string }> } | { memberId: string; unknown: true }>());
  if (availabilityCurrent && availabilityQuery.data) {
    for (const member of availabilityQuery.data.members) retainedAvailability.current.set(member.memberId, member);
  }
  const availabilityByMemberId = React.useMemo(() => new Map(
    visibleAvailabilityMemberIds.flatMap((memberId) => {
      const fresh = availabilityCurrent ? availabilityQuery.data?.members.find((member) => member.memberId === memberId) : undefined;
      const retained = fresh ?? retainedAvailability.current.get(memberId);
      return retained ? [[memberId, retained] as const] : [];
    }),
  ), [availabilityCurrent, availabilityQuery.data, visibleAvailabilityMemberIds]);

  React.useEffect(() => {
    if (!props.event || !isSchedulingAggregate(props.event)) return;
    const authority = `${props.event.id}:${props.event.version}`;
    if (appliedSchedulingAuthority.current === authority) return;
    appliedSchedulingAuthority.current = authority;
    if (base && props.event.version !== base.version) {
      // A refetch must not silently move the optimistic-concurrency base while
      // retaining edits made against an older version. Let the user choose the
      // same explicit resolution used for a 409 response.
      setStatus((current) => current.kind === "pending" ? current : { kind: "conflict", current: props.event!, operation: "save" });
      return;
    }
    const attendeeMemberIds = [...new Set([creatorMemberId, ...props.event.attendees.map((attendee) => attendee.memberId)])];
    setBase(props.event);
    setForm((current) => current.attendeeMemberIds.length > 0 ? current : { ...current, attendeeMemberIds });
  }, [base, props.event]);

  React.useEffect(() => {
    if (!peopleOpen || groups.length > 0 || groupsError) return;
    let cancelled = false;
    void getChatGroupsForContacts().then((result) => { if (!cancelled) setGroups(Array.isArray(result) ? result : []); }).catch(() => { if (!cancelled) setGroupsError(t("calendar.groups_unavailable")); });
    return () => { cancelled = true; };
  }, [groups.length, groupsError, peopleOpen]);

  const toggleMember = (memberId: string) => {
    if (!teamSelected && memberId === creatorMemberId) return;
    if (!form.attendeeMemberIds.includes(memberId) && form.attendeeMemberIds.length >= MAX_SCHEDULING_MEMBERS) {
      setGroupFeedback(t("calendar.attendees_limit", { count: MAX_SCHEDULING_MEMBERS }));
      return;
    }
    update({ attendeeMemberIds: form.attendeeMemberIds.includes(memberId) ? form.attendeeMemberIds.filter((id) => id !== memberId) : [...form.attendeeMemberIds, memberId] });
  };
  const toggleAvailabilityMember = (memberId: string) => {
    setHiddenAvailabilityMemberIds((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  };
  const resizeDescription = React.useCallback(() => {
    const node = descriptionInput.current;
    if (!node?.style) return;
    node.style.height = "0px";
    node.style.height = `${Math.max(32, Math.min(node.scrollHeight, 160))}px`;
  }, []);
  React.useLayoutEffect(resizeDescription, [form.description, resizeDescription]);
  const addGroup = async (group: OrganizationChatGroup) => {
    if (loadingGroupId || !membersQuery.isSuccess) return;
    setLoadingGroupId(group.id);
    setGroupFeedback(null);
    try {
      const selected = new Set(form.attendeeMemberIds);
      const added: string[] = [];
      let skipped = 0;
      let overLimit = 0;
      for (const entry of groupMemberRoster(await getAllGroupMembers(group.id))) {
        if (!entry || typeof entry !== "object") { skipped += 1; continue; }
        const value = entry as Record<string, unknown>;
        const userId = typeof value.identity_user_id === "string" ? value.identity_user_id : typeof value.userId === "string" ? value.userId : "";
        const memberId = memberIdByUserId.get(userId);
        if (!memberId) { skipped += 1; continue; }
        if (selected.has(memberId)) continue;
        if (selected.size >= MAX_SCHEDULING_MEMBERS) { overLimit += 1; continue; }
        selected.add(memberId);
        added.push(memberId);
      }
      update({ attendeeMemberIds: [...selected] });
      setGroupFeedback(t("calendar.group_members_result", { added: added.length, skipped, overLimit }));
    } catch {
      setGroupFeedback(t("calendar.group_members_failed"));
    } finally {
      setLoadingGroupId(null);
    }
  };

  const update = (patch: Partial<CalendarEventFormValues>) => {
    setForm((current) => ({ ...current, ...patch }));
    if (status.kind === "validation") setStatus({ kind: "editing" });
  };
  const updateTime = (patch: Record<string, string>) => {
    setForm((current) => {
      let time = { ...current.time, ...patch } as CalendarEventFormValues["time"];
      // Moving the start keeps the existing duration; editing the end remains explicit.
      if (patch.startDate !== undefined || patch.startTime !== undefined) {
        try {
          if (current.time.kind === "timed" && time.kind === "timed") {
            const previousStart = Temporal.PlainDateTime.from(`${current.time.startDate}T${current.time.startTime}`);
            const previousEnd = Temporal.PlainDateTime.from(`${current.time.endDate}T${current.time.endTime}`);
            if (Temporal.PlainDateTime.compare(previousEnd, previousStart) > 0) {
              const end = Temporal.PlainDateTime.from(`${time.startDate}T${time.startTime}`).add(previousStart.until(previousEnd));
              time = { ...time, endDate: end.toPlainDate().toString(), endTime: end.toPlainTime().toString().slice(0, 5) };
            }
          } else if (current.time.kind === "allDay" && time.kind === "allDay") {
            const duration = Temporal.PlainDate.from(current.time.startDate).until(Temporal.PlainDate.from(current.time.endDateExclusive));
            time = { ...time, endDateExclusive: Temporal.PlainDate.from(time.startDate).add(duration).toString() };
          }
        } catch { /* Preserve incomplete manual input for field validation. */ }
      }
      return { ...current, time };
    });
    if (status.kind === "validation") setStatus({ kind: "editing" });
  };

  const fail = (error: unknown, operation: "save" | "delete") => {
    const failure = classifyCalendarSaveFailure(error);
    if (failure.kind === "conflict") {
      const current = calendarMutationConflict(error) as DenCalendarEvent | null;
      if (current && (!base || current.id !== base.id || current.organizationId !== props.scope.organizationId || current.calendarId !== base.calendarId)) {
        setStatus({ kind: "failed", failure: { kind: "network", message: "calendar.error_network" } });
        return;
      }
      if (current && "calendarId" in current) setCanonicalCalendarEvent(queryClient, props.scope, current);
      setStatus({ kind: "conflict", current, operation });
      return;
    }
    setStatus({ kind: "failed", failure });
  };

  const keepDraft = async () => {
    if (!props.onSaveDraft || pending) return;
    try {
      await props.onSaveDraft(form, base);
      setStatus({ kind: "draft-saved" });
    } catch {
      setStatus({ kind: "draft-failed" });
    }
  };

  const submit = async () => {
    if (pending) return;
    // Offline never sends or queues an authoritative write.
    if (!online) return;
    const validation = validateCalendarEventForm(form, activeIds, teamSelected ? undefined : creatorMemberId);
    if (!validation.ok) {
      setStatus({ kind: "validation", errors: validation.errors });
      return;
    }
    if (props.teamCalendarIds?.has(validation.values.calendarId) && (validation.values.attendeeMemberIds.length > 0 || validation.values.recurrence !== null)) {
      setStatus({ kind: "validation", errors: { calendarId: "calendar.error_team_scheduling_unsupported" } });
      return;
    }
    const fingerprint = JSON.stringify(validation.values);
    setStatus({ kind: "pending" });
    try {
      // Personal writes can replay their idempotency key; team endpoints intentionally do not retry.
      const teamCalendarId = base
        ? props.teamCalendarIds?.has(base.calendarId) ? base.calendarId : null
        : props.teamCalendarIds?.has(validation.values.calendarId) ? validation.values.calendarId : null;
      const mutation = base ? updateMutation : createMutation;
      const schedulingMutation = base ? schedulingMutations.update : schedulingMutations.create;
      const replay = mutation.canRetryLast && lastSubmitted.current === fingerprint;
      const schedulingReplay = schedulingMutation.canRetryLast && lastSubmitted.current === fingerprint;
      lastSubmitted.current = fingerprint;
      let result: { event: DenCalendarEvent };
      if (teamCalendarId && base) {
        const patch = calendarEventUpdatePatch(base, validation.values);
        if (Object.keys(patch).length === 0) {
          props.onSaved(base);
          return;
        }
        const { calendarId: _calendarId, attendeeMemberIds: _attendees, recurrence: _recurrence, ...teamPatch } = patch;
        result = await teamMutations.update.mutateAsync({ calendarId: teamCalendarId, eventId: base.id, input: { expectedVersion: base.version, ...teamPatch } });
      } else if (teamCalendarId) {
        const { calendarId, attendeeMemberIds: _attendees, recurrence: _recurrence, ...input } = validation.values;
        result = await teamMutations.create.mutateAsync({ calendarId, input: { ...input, description: input.description ?? "" } });
      } else if (base && ("attendees" in base || validation.values.attendeeMemberIds.length > 0 || validation.values.recurrence !== null)) {
        const patch = calendarEventUpdatePatch(base, validation.values);
        if (Object.keys(patch).length === 0) {
          props.onSaved(base);
          return;
        }
        const { attendeeMemberIds, ...corePatch } = patch;
        result = schedulingReplay ? await schedulingMutations.update.retryLastAsync() : await schedulingMutations.update.mutateAsync({ eventId: base.id, input: { expectedVersion: base.version, ...corePatch, ...(attendeeMemberIds ? { attendees: attendeeMemberIds.map((memberId) => ({ memberId })) } : {}) } });
      } else if (base && replay) {
        result = await (mutation.retryLastAsync as () => Promise<{ event: DenCalendarEvent }>)();
      } else if (base) {
        const patch = calendarEventUpdatePatch(base, validation.values);
        if (Object.keys(patch).length === 0) {
          props.onSaved(base);
          return;
        }
        result = await updateMutation.mutateAsync({ eventId: base.id, expectedVersion: base.version, patch });
      } else {
        const { attendeeMemberIds, recurrence, ...input } = validation.values;
        if (attendeeMemberIds.length > 0 || recurrence !== null) {
          result = schedulingReplay ? await schedulingMutations.create.retryLastAsync() : await schedulingMutations.create.mutateAsync({ ...input, recurrence, attendees: attendeeMemberIds.map((memberId) => ({ memberId })) });
        } else {
          result = replay ? await createMutation.retryLastAsync() : await createMutation.mutateAsync(input);
        }
      }
      props.onSaved(result.event);
    } catch (error) {
      fail(error, "save");
    }
  };

  const remove = async () => {
    if (!base || pending || !online) return;
    setStatus({ kind: "pending" });
    try {
      if (props.teamCalendarIds?.has(base.calendarId)) {
        await teamMutations.remove.mutateAsync({ calendarId: base.calendarId, eventId: base.id, expectedVersion: base.version });
      } else {
        await deleteMutation.mutateAsync({ eventId: base.id, expectedVersion: base.version });
      }
      props.onDeleted(base.id);
    } catch (error) {
      fail(error, "delete");
    }
  };

  const useLatest = () => {
    if (status.kind !== "conflict" || !status.current) return;
    setBase(status.current);
    setForm(ensureRequiredCreatorAttendee(calendarEventToForm(status.current), status.current.ownerMemberId, props.teamCalendarIds));
    lastSubmitted.current = null;
    setStatus({ kind: "editing" });
  };
  const keepMine = () => {
    if (status.kind !== "conflict" || !status.current) return;
    // Rebase onto the latest version; the user resubmits deliberately.
    setBase(status.current);
    lastSubmitted.current = null;
    setStatus({ kind: "editing" });
  };

  const time = form.time;
  const fieldError = (field: keyof CalendarEventFormErrors) => errors[field]
    ? <p id={`${formId}-${field}-error`} className="text-xs text-red-600" data-testid={`calendar-form-error-${field}`}>{t(errors[field]!)}</p>
    : null;
  const describedBy = (field: keyof CalendarEventFormErrors) => errors[field] ? `${formId}-${field}-error` : undefined;

  const actionsView = (
    <div className={cn(
      "flex flex-wrap items-center gap-2",
      dialogPresentation && "mt-auto min-h-20 shrink-0 gap-3 border-t border-dls-border bg-dls-surface px-6 py-6",
    )} data-testid="calendar-form-actions">
      {base ? (
        <Button type="button" size="sm" variant="ghost" disabled={pending || !online} title={!online ? t("calendar.offline_delete_unavailable") : undefined} onClick={() => setConfirmingDelete(true)} aria-label={t("calendar.delete_event")} data-testid="calendar-form-delete">
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
      <Button type="button" size="sm" variant={dialogPresentation ? "outline" : "ghost"} className={cn("ml-auto min-w-24", dialogPresentation && "h-8 min-w-20 rounded-md px-5 font-normal before:rounded-md")} disabled={pending} onClick={props.onCancel} data-testid="calendar-form-cancel">{t("calendar.cancel")}</Button>
      {props.onSaveDraft && (!online || (status.kind === "failed" && status.failure.kind === "network")) ? (
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void keepDraft()} data-testid="calendar-form-save-draft">
          {t("calendar.draft_keep")}
        </Button>
      ) : null}
      <Button type="submit" size="sm" className={cn("min-w-24", dialogPresentation && "h-8 min-w-20 rounded-md px-5 font-normal before:rounded-md")} disabled={!online || pending || (status.kind === "conflict")} data-testid="calendar-form-save">
        {status.kind === "failed" && status.failure.kind === "network" ? t("calendar.retry_save") : t("calendar.save")}
      </Button>
    </div>
  );

  const formView = (
    <form
      aria-labelledby={`${formId}-title`}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-dls-border bg-dls-surface p-3",
        dialogPresentation && "h-full min-h-0 gap-0 overflow-hidden rounded-none border-0 bg-transparent p-0",
      )}
      data-testid="calendar-event-form"
      data-status={status.kind}
      noValidate
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          if (confirmingDelete) setConfirmingDelete(false);
          else props.onCancel();
        }
      }}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <h3 id={`${formId}-title`} className={cn(
        "text-sm font-semibold text-dls-text",
        dialogPresentation && "flex h-10 shrink-0 items-center justify-center text-center text-sm",
      )}>
        {isEdit ? t("calendar.edit_event") : t("calendar.create_event")}
      </h3>
      <div className={cn("grid min-h-0 flex-1 grid-cols-1 gap-5", dialogPresentation ? "gap-1.5 overflow-hidden px-1.5 pb-1.5 min-[850px]:grid-cols-[minmax(0,1.59fr)_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,1.2fr)_minmax(22rem,.8fr)]", teamSelected && "!grid-cols-1")} data-testid="calendar-editor-columns">
      <div className={cn("min-w-0 space-y-4", dialogPresentation && "flex min-h-0 flex-col space-y-0 overflow-hidden rounded-lg bg-dls-surface")}>
      <div className={cn("min-w-0 space-y-4", dialogPresentation && "min-h-0 flex-1 overflow-y-auto px-7 py-6")}>
      {!online ? (
        <p className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-xs text-dls-text" role="note" data-testid="calendar-form-offline">
          {props.onSaveDraft ? t("calendar.offline_form_draft_only") : t("calendar.offline_form_unavailable")}
        </p>
      ) : null}
      {props.restoredFromDraft ? (
        <p className="flex flex-wrap items-center gap-2 rounded-lg bg-dls-hover px-2 py-1.5 text-xs text-dls-text" role="note" data-testid="calendar-form-restored-draft">
          <span>{t("calendar.draft_restored")}</span>
          {props.onDiscardDraft ? (
            <button type="button" className="underline" onClick={props.onDiscardDraft} data-testid="calendar-form-discard-draft">{t("calendar.draft_discard")}</button>
          ) : null}
        </p>
      ) : null}
      <fieldset disabled={pending} className={cn("flex min-w-0 flex-col gap-3", dialogPresentation && "gap-3")}>
        <label className="flex flex-col gap-1 text-xs text-dls-secondary">
          <span className="sr-only">{t("calendar.field_title")}</span>
          <input
            ref={titleInput}
            className={cn(inputClass, dialogPresentation && "mb-1 h-11 rounded-none border-0 bg-transparent px-0 text-xl font-semibold placeholder:text-dls-secondary/70 focus-visible:ring-0")}
            value={form.title}
            placeholder={t("calendar.field_title_placeholder")}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy("title")}
            onChange={(event) => update({ title: event.target.value })}
            data-testid="calendar-form-title"
          />
          {fieldError("title")}
        </label>
        {!teamSelected ? <Popover open={peopleOpen} onOpenChange={setPeopleOpen}>
          <div className="flex flex-col gap-1 text-xs text-dls-secondary">
          <span className="sr-only">{t("calendar.attendees")}</span>
          <PopoverTrigger render={<button type="button" className={cn(inputClass, "flex h-auto min-h-11 items-center justify-between gap-2 px-3 py-2 text-left", dialogPresentation && "min-h-8 rounded-md border-0 bg-transparent px-0 py-0")} aria-expanded={peopleOpen} aria-haspopup="listbox" aria-controls={`${formId}-attendees-picker`} data-testid="calendar-form-attendees-trigger" />}>
            <span className="flex min-w-0 flex-1 items-center gap-[18px]">
              <Users className="size-4 shrink-0 text-dls-secondary" aria-hidden="true" />
              <span className={cn("text-sm text-dls-secondary", dialogPresentation && "min-w-0 flex-1 rounded-md bg-dls-hover px-2 py-1.5")}>{invitedAttendeeMemberIds.length ? t("calendar.attendees_add_more") : t("calendar.attendees_placeholder")}</span>
            </span>
            {!dialogPresentation ? <ChevronDown className="size-4 shrink-0" /> : null}
          </PopoverTrigger>
          {fieldError("attendees")}
          {peopleOpen ? (
            <PopoverContent id={`${formId}-attendees-picker`} align="start" className="max-h-80 w-[min(28rem,calc(100vw-2rem))] gap-0 overflow-y-auto rounded-md border border-dls-border bg-dls-surface p-2 shadow-xl" role="listbox" data-testid="calendar-attendees-picker" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPeopleOpen(false); } }}>
              <label className="mb-2 flex items-center gap-2 rounded-lg border border-dls-border px-2"><Search className="size-3.5" aria-hidden="true" /><input aria-label={t("calendar.attendees_search")} className="h-8 min-w-0 flex-1 bg-transparent text-sm text-dls-text outline-none" value={peopleSearch} onChange={(event) => setPeopleSearch(event.target.value)} placeholder={t("calendar.attendees_search")} /></label>
              {membersQuery.isLoading ? <p className="p-2 text-xs">{t("calendar.attendees_loading")}</p> : null}
              {membersQuery.isError ? <p className="p-2 text-xs text-red-600">{t("calendar.attendees_failed")}</p> : null}
              {members.filter((member) => member.id !== creatorMemberId && memberName(member).toLocaleLowerCase().includes(peopleSearch.trim().toLocaleLowerCase())).map((member) => {
                const selected = form.attendeeMemberIds.includes(member.id);
                 return <button key={member.id} type="button" className="flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm text-dls-text hover:bg-dls-hover" onClick={() => toggleMember(member.id)} data-testid={`calendar-attendee-${member.id}`}><span className="flex-1 truncate">{memberName(member)}</span>{selected ? <Check className="size-4 text-dls-accent" /> : null}</button>;
              })}
              <div className="my-2 h-px bg-dls-border" />
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-dls-secondary">{t("calendar.groups")}</p>
              {groupsError ? <p className="p-2 text-xs text-red-600">{groupsError}</p> : null}
              {groups.filter((group) => group.name.toLocaleLowerCase().includes(peopleSearch.trim().toLocaleLowerCase())).map((group) => <button key={group.id} type="button" disabled={loadingGroupId !== null || !membersQuery.isSuccess} className="flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-50" onClick={() => void addGroup(group)} data-testid={`calendar-group-${group.id}`}><Users className="size-4 text-dls-secondary" /><span className="flex-1 truncate">{group.name}</span>{loadingGroupId === group.id ? <LoaderCircle className="size-3 animate-spin" /> : null}</button>)}
              {groupFeedback ? <p className="p-2 text-xs text-dls-secondary" role="status" data-testid="calendar-group-feedback">{groupFeedback}</p> : null}
            </PopoverContent>
          ) : null}
          {form.attendeeMemberIds.length > 0 ? (
            <div className={cn("mt-2 rounded-xl border border-dls-border p-2.5", dialogPresentation && "ml-[34px] mt-3 rounded-none border-0 p-0")} data-testid="calendar-attendee-list">
              <p className="mb-2 text-sm font-normal text-dls-text">{t("calendar.attendees_count", { count: form.attendeeMemberIds.length })}</p>
              <div className="flex flex-col gap-2">
                {form.attendeeMemberIds.map((memberId) => {
                  const member = membersById.get(memberId);
                  const name = member ? memberName(member) : memberId;
                  const availabilityVisible = !hiddenAvailabilityMemberIds.has(memberId);
                  const creator = memberId === creatorMemberId;
                  return (
                    <div key={memberId} className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md bg-dls-hover pr-2" data-testid={`calendar-selected-attendee-${memberId}`}>
                      <CalendarMemberAvatar member={member} name={name} />
                      <span className="min-w-0 flex-1 truncate text-sm text-dls-text">{name}</span>
                      {creator ? <span className="sr-only">{t("calendar.attendee_creator")}</span> : null}
                      <button
                        type="button"
                        className="flex size-6 shrink-0 items-center justify-center rounded text-dls-secondary hover:bg-dls-surface/80 hover:text-dls-text"
                        aria-label={availabilityVisible ? t("calendar.availability_hide_member", { name }) : t("calendar.availability_show_member", { name })}
                        title={availabilityVisible ? t("calendar.availability_hide") : t("calendar.availability_show")}
                        aria-pressed={availabilityVisible}
                        onClick={() => toggleAvailabilityMember(memberId)}
                        data-testid={`calendar-attendee-availability-${memberId}`}
                      >
                        {availabilityVisible ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
                      </button>
                      <button type="button" disabled={creator} title={creator ? t("calendar.attendee_creator") : t("calendar.attendee_remove", { name })} className="flex size-6 shrink-0 items-center justify-center rounded text-dls-secondary hover:bg-dls-surface/80 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-30" aria-label={t("calendar.attendee_remove", { name })} onClick={() => toggleMember(memberId)} data-testid={`calendar-selected-attendee-remove-${memberId}`}>
                        <X className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          </div>
        </Popover> : <p className="rounded-lg bg-dls-hover px-3 py-2 text-xs text-dls-secondary" data-testid="calendar-team-scheduling-unavailable">{t("calendar.team_scheduling_unsupported")}</p>}
        <div className={cn("rounded-xl border border-dls-border p-3", dialogPresentation && "mt-2 rounded-none border-x-0 border-y border-dls-border px-0 py-3.5")}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" role="group" aria-label={t("calendar.detail_time")} aria-describedby={describedBy("time")} data-testid="calendar-form-time-grid">
          <Clock3 className="mr-2.5 size-4 shrink-0 text-dls-secondary" aria-hidden="true" />
          {time.kind === "allDay" ? (
            <>
              <CalendarEditorDatePicker timeZone={props.timeZone} label={t("calendar.field_start_date")} value={time.startDate} onChange={(value) => updateTime({ startDate: value })} testId="calendar-form-start-date" disabled={pending} />
              <span className="text-dls-secondary" aria-hidden="true">—</span>
              <CalendarEditorDatePicker timeZone={props.timeZone} label={t("calendar.field_end_date")} value={Temporal.PlainDate.from(time.endDateExclusive).subtract({ days: 1 }).toString()} onChange={(value) => updateTime({ endDateExclusive: Temporal.PlainDate.from(value).add({ days: 1 }).toString() })} testId="calendar-form-end-date" disabled={pending} />
            </>
          ) : (
            <>
              <CalendarEditorDatePicker timeZone={props.timeZone} label={t("calendar.field_start_date")} value={time.startDate} onChange={(value) => updateTime({ startDate: value })} testId="calendar-form-start-date" disabled={pending} />
              <CalendarTimePicker label={t("calendar.field_start_time")} value={time.startTime.slice(0, 5)} onChange={(value) => updateTime({ startTime: value })} testId="calendar-form-start-time" disabled={pending} />
              <span className="text-dls-secondary" aria-hidden="true">—</span>
              <CalendarTimePicker label={t("calendar.field_end_time")} value={time.endTime.slice(0, 5)} onChange={(value) => updateTime({ endTime: value })} testId="calendar-form-end-time" disabled={pending} />
              <CalendarEditorDatePicker timeZone={props.timeZone} label={t("calendar.field_end_date")} value={time.endDate} onChange={(value) => updateTime({ endDate: value })} testId="calendar-form-end-date" disabled={pending} />
            </>
          )}
        </div>

        <div className="ml-[34px] mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-2 text-sm text-dls-text">
            <input
              type="checkbox"
              className="size-4 rounded border-dls-border accent-[var(--dls-text)]"
              checked={time.kind === "allDay"}
              onChange={(event) => setForm((current) => switchCalendarFormTimeKind(current, event.target.checked ? "allDay" : "timed", props.timeZone))}
              data-testid="calendar-form-all-day"
            />
            {t("calendar.all_day")}
          </label>
          <span className="h-3 border-l border-dls-border" aria-hidden="true" />
          <Popover open={zoneOpen} onOpenChange={setZoneOpen}>
            <PopoverTrigger render={<button type="button" className={calendarEditorControl} aria-label={t("calendar.detail_time_zone")} data-testid="calendar-form-zone-trigger" />}>
              {t("calendar.detail_time_zone")}<ChevronRight className="ml-1 inline size-3.5" />
            </PopoverTrigger>
            {zoneOpen ? <PopoverContent className="w-auto rounded-md border border-dls-border bg-dls-surface p-3 text-sm text-dls-text" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setZoneOpen(false); } }}><span data-testid="calendar-form-zone">{time.kind === "timed" ? time.timeZone : props.timeZone}</span></PopoverContent> : null}
          </Popover>
          {!teamSelected ? <label className="flex w-full items-center gap-2 text-sm text-dls-text">
            <span className="sr-only">{t("calendar.recurrence")}</span>
            <CalendarEditorSelect label={t("calendar.recurrence")} value={form.recurrence.frequency} onChange={(value) => update({ recurrence: value === "none" ? { frequency: "none" } : defaultCalendarRecurrence(value as "daily" | "weekly" | "monthly", form.time.startDate) })} testId="calendar-form-recurrence" options={[
              { value: "none", label: t("calendar.recurrence_none") }, { value: "daily", label: t("calendar.recurrence_daily") }, { value: "weekly", label: t("calendar.recurrence_weekly") }, { value: "monthly", label: t("calendar.recurrence_monthly") },
            ]} />
          </label> : null}
        </div>
        </div>
        {fieldError("time")}
        {!teamSelected ? <>{form.recurrence.frequency !== "none" ? <div className="ml-[34px] grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-dls-secondary">{t("calendar.recurrence_interval")}<input type="number" min={1} max={365} className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={form.recurrence.interval} onChange={(event) => update({ recurrence: { ...form.recurrence, interval: Number(event.target.value) } as CalendarEventFormValues["recurrence"] })} data-testid="calendar-form-recurrence-interval" /></label>
        </div> : null}
        {form.recurrence.frequency !== "none" ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><label className="flex flex-col gap-1 text-xs text-dls-secondary">{t("calendar.recurrence_end")}<select className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={form.recurrence.endKind} onChange={(event) => update({ recurrence: { ...form.recurrence, endKind: event.target.value as "never" | "until" | "count" } as CalendarEventFormValues["recurrence"] })} data-testid="calendar-form-recurrence-end"><option value="never">{t("calendar.recurrence_never")}</option><option value="until">{t("calendar.recurrence_until")}</option><option value="count">{t("calendar.recurrence_count")}</option></select></label>{form.recurrence.endKind === "until" ? <label className="flex flex-col gap-1 text-xs text-dls-secondary">{t("calendar.recurrence_until")}<input type="date" className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={form.recurrence.untilDate} onChange={(event) => update({ recurrence: { ...form.recurrence, untilDate: event.target.value } as CalendarEventFormValues["recurrence"] })} data-testid="calendar-form-recurrence-until" /></label> : null}{form.recurrence.endKind === "count" ? <label className="flex flex-col gap-1 text-xs text-dls-secondary">{t("calendar.recurrence_occurrences")}<input type="number" min={1} max={1000} className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={form.recurrence.count} onChange={(event) => update({ recurrence: { ...form.recurrence, count: Number(event.target.value) } as CalendarEventFormValues["recurrence"] })} data-testid="calendar-form-recurrence-count" /></label> : null}</div> : null}
        {fieldError("recurrence")}</> : null}

        {form.videoConferenceEnabled ? (
          <div className="group flex min-h-8 items-center gap-[18px] rounded-md px-0 text-sm text-dls-text hover:bg-dls-hover" data-testid="calendar-form-video-conference">
            <Video className="size-4 shrink-0 text-dls-secondary" aria-hidden="true" />
            <span className="flex-1">{t("calendar.video_conference")}</span>
            <button type="button" className="flex size-8 items-center justify-center rounded-lg text-dls-secondary opacity-0 transition-opacity hover:bg-dls-surface hover:text-dls-text group-hover:opacity-100 focus:opacity-100" aria-label={t("calendar.video_conference_remove")} onClick={() => update({ videoConferenceEnabled: false })} data-testid="calendar-form-video-conference-remove">
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button type="button" className="flex min-h-8 items-center gap-[18px] rounded-md px-0 text-left text-sm text-dls-accent hover:bg-dls-hover" onClick={() => update({ videoConferenceEnabled: true })} data-testid="calendar-form-video-conference-add">
            <Video className="size-4 shrink-0 text-dls-secondary" aria-hidden="true" />
            {t("calendar.video_conference_add")}
          </button>
        )}

        <label className="flex items-start gap-[18px] rounded-md px-0 text-xs text-dls-secondary focus-within:bg-dls-hover/50">
          <AlignLeft className="mt-2 size-4 shrink-0" aria-hidden="true" />
          <span className="sr-only">{t("calendar.field_description")}</span>
          <textarea
            ref={descriptionInput}
            rows={1}
            className="min-h-8 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-1.5 text-sm leading-5 text-dls-text outline-none placeholder:text-dls-secondary"
            value={form.description}
            placeholder={t("calendar.field_description_placeholder")}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={describedBy("description")}
            onChange={(event) => update({ description: event.target.value })}
            data-testid="calendar-form-description"
          />
        </label>
        {fieldError("description")}

        <div className="flex items-start gap-[18px] text-sm text-dls-text" data-testid="calendar-form-reminder">
          <Bell className="mt-2 size-4 shrink-0 text-dls-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            {reminders.map((reminder) => {
              const suffix = reminder.id === 0 ? "" : `-${reminder.id}`;
              const open = openReminderId === reminder.id;
              return <div key={reminder.id} className="flex min-h-8 items-center gap-3" data-testid={`calendar-form-reminder-row-${reminder.id}`}>
                <Popover open={open} onOpenChange={(next) => setOpenReminderId(next ? reminder.id : null)}>
                  <PopoverTrigger render={<button type="button" className="-ml-2 flex h-8 items-center gap-1 rounded-md px-2 hover:bg-dls-hover" data-testid={`calendar-form-reminder-trigger${suffix}`} />}>
                    <span>{reminderLabel(reminder.minutes)}</span>
                    <ChevronDown className="size-4 text-dls-secondary" aria-hidden="true" />
                  </PopoverTrigger>
                  {open ? (
                    <PopoverContent align="start" className="max-h-72 w-48 gap-0 overflow-y-auto rounded-md border border-dls-border bg-dls-surface p-1.5 shadow-xl" data-testid={`calendar-form-reminder-menu${suffix}`} onKeyDown={(event) => {
                      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpenReminderId(null); }
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
                        const index = options.indexOf(event.target as HTMLButtonElement);
                        options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
                      }
                    }}>
                      {reminderOptions.map((minutes) => (
                        <button key={minutes} type="button" className={cn("flex h-8 w-full shrink-0 items-center justify-between rounded px-2 text-left text-sm text-dls-text hover:bg-dls-hover focus-visible:bg-dls-hover", minutes === reminder.minutes && "bg-dls-hover font-medium")} onClick={() => {
                          setReminders((current) => current.map((item) => item.id === reminder.id ? { ...item, minutes } : item));
                          setOpenReminderId(null);
                        }} data-testid={`calendar-form-reminder-option-${minutes}${suffix}`}>
                          <span>{reminderLabel(minutes)}</span>
                          {minutes === reminder.minutes ? <Check className="size-4" aria-hidden="true" /> : null}
                        </button>
                      ))}
                    </PopoverContent>
                  ) : null}
                </Popover>
                <span className="whitespace-nowrap">{t("calendar.reminder_me")}</span>
                <button type="button" className="flex size-6 shrink-0 items-center justify-center rounded text-dls-secondary hover:bg-dls-hover hover:text-dls-text" aria-label={`${t("calendar.reminder_remove")} · ${reminderLabel(reminder.minutes)}`} onClick={() => {
                  setReminders((current) => current.filter((item) => item.id !== reminder.id));
                  if (open) setOpenReminderId(null);
                }} data-testid={`calendar-form-reminder-remove${suffix}`}>
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>;
            })}
            <button type="button" className="-ml-2 flex h-8 items-center rounded-md px-2 text-dls-text hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-dls-text/40" onClick={() => {
              const id = nextReminderId.current++;
              setReminders((current) => [...current, { id, minutes: [5, 15, 30, 60, 120, 1440, 2880, 0].find((minutes) => !current.some((item) => item.minutes === minutes)) ?? 5 }]);
            }} data-testid="calendar-form-reminder-add">{t("calendar.reminder_add")}</button>
          </div>
        </div>

        <label className="flex min-h-8 items-center gap-[18px] rounded-md px-0 text-xs text-dls-secondary hover:bg-dls-hover">
          <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
          <span className="sr-only">{t("calendar.detail_calendar")}</span>
          <CalendarEditorSelect
            label={t("calendar.detail_calendar")}
            value={form.calendarId}
            invalid={Boolean(errors.calendarId)}
            describedBy={describedBy("calendarId")}
            onChange={(calendarId) => {
              const selectingTeam = props.teamCalendarIds?.has(calendarId) === true;
              update({ calendarId, attendeeMemberIds: selectingTeam ? form.attendeeMemberIds.filter((memberId) => memberId !== creatorMemberId) : [...new Set([creatorMemberId, ...form.attendeeMemberIds])] });
            }}
            testId="calendar-form-calendar"
            options={props.calendars.map((calendar) => ({ value: calendar.id, label: calendar.name, disabled: advancedScheduling && props.teamCalendarIds?.has(calendar.id) }))}
          />
        </label>
        {fieldError("calendarId")}
      </fieldset>

      <div role="status" aria-live="polite" className="text-xs" data-testid="calendar-form-status">
        {pending ? <span className="inline-flex items-center gap-1 text-dls-secondary"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />{t("calendar.status_saving")}</span> : null}
        {status.kind === "draft-saved" ? (
          <span className="text-dls-secondary" data-testid="calendar-form-draft-saved">{t("calendar.draft_saved_unsynced")}</span>
        ) : null}
        {status.kind === "draft-failed" ? (
          <span className="text-red-600" role="alert" data-testid="calendar-form-draft-failed">{t("calendar.draft_save_failed")}</span>
        ) : null}
        {status.kind === "failed" ? (
          <span className="text-red-600" role="alert" data-testid={`calendar-form-failure-${status.failure.kind}`}>
            {t(status.failure.message)} {status.failure.kind === "network" ? t("calendar.draft_kept") : null}
          </span>
        ) : null}
      </div>

      {status.kind === "conflict" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2" role="alert" data-testid="calendar-form-conflict">
          <p className="text-xs text-dls-text">
            {status.current ? t("calendar.conflict_changed") : t("calendar.conflict_deleted")}
          </p>
          {status.current ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={useLatest} data-testid="calendar-form-conflict-use-latest">{t("calendar.conflict_use_latest")}</Button>
              <Button type="button" size="sm" variant="outline" onClick={keepMine} data-testid="calendar-form-conflict-keep-mine">{t("calendar.conflict_keep_mine")}</Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {confirmingDelete && base ? (
        <div className="flex flex-col gap-2 rounded-lg border border-red-500/40 p-2" role="alertdialog" aria-label={t("calendar.delete_event")} data-testid="calendar-form-delete-confirm">
          <p className="text-xs text-dls-text">{t("calendar.delete_confirm")}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" disabled={pending || !online} onClick={() => void remove()} data-testid="calendar-form-delete-confirm-button">{t("calendar.delete_event")}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)} data-testid="calendar-form-delete-cancel">{t("calendar.cancel")}</Button>
          </div>
        </div>
      ) : null}
      </div>
      {dialogPresentation ? actionsView : null}
      </div>
      {!teamSelected ? <CalendarAvailabilityPanel date={availabilityDate} onDateChange={setAvailabilityDate} dialog={dialogPresentation} form={form} memberIds={visibleAvailabilityMemberIds} membersById={membersById} availabilityByMemberId={availabilityByMemberId} error={availabilityCurrent && availabilityQuery.isError} online={online} timeZone={props.timeZone} /> : null}
      </div>
      {!dialogPresentation ? actionsView : null}
    </form>
  );

  if (!dialogPresentation) return formView;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) props.onCancel(); }}>
      <DialogContent
        className="h-[min(680px,calc(100dvh-2rem))] w-[min(960px,calc(100%-2rem))] max-w-none gap-0 rounded-xl border border-dls-border bg-dls-sidebar p-0 shadow-2xl sm:max-w-[960px] [&>[data-slot=dialog-close]]:top-1 [&>[data-slot=dialog-close]]:right-2 [&>[data-slot=dialog-close]]:rounded-md"
        showCloseButton={!pending}
        finalFocus={false}
        aria-label={t("calendar.create_event")}
        data-testid="calendar-event-dialog"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("calendar.create_event")}</DialogTitle>
          <DialogDescription>{t("calendar.create_event")}</DialogDescription>
        </DialogHeader>
        {formView}
      </DialogContent>
    </Dialog>
  );
}

function isSchedulingAggregate(event: DenCalendarEvent): event is DenCalendarSchedulingEvent {
  return "attendees" in event && Array.isArray(event.attendees);
}

function ensureRequiredCreatorAttendee(
  form: CalendarEventFormValues,
  creatorMemberId: string,
  teamCalendarIds?: ReadonlySet<string>,
): CalendarEventFormValues {
  if (teamCalendarIds?.has(form.calendarId)) {
    return { ...form, attendeeMemberIds: form.attendeeMemberIds.filter((memberId) => memberId !== creatorMemberId) };
  }
  return { ...form, attendeeMemberIds: [...new Set([creatorMemberId, ...form.attendeeMemberIds])] };
}
