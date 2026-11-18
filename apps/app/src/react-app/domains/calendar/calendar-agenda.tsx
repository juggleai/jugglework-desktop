/** @jsxImportSource react */
import * as React from "react";
import type { Temporal } from "@js-temporal/polyfill";
import {
  Bell,
  CalendarDays,
  CalendarPlus,
  Check,
  FileText,
  LoaderCircle,
  Minus,
  Pencil,
  Trash2,
  UserRound,
  Users,
  Video,
  X,
} from "lucide-react";

import type { DenCalendar, DenCalendarEvent, DenCalendarSchedulingEvent, DenOrganizationMember } from "@/app/lib/den";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { CalendarDayEntry } from "./calendar-event-layout";
import { DEFAULT_CALENDAR_REMINDER_MINUTES, readCalendarReminderMinutes, reminderLabel } from "./calendar-reminder-preferences";
import type { CalendarScope } from "./calendar-scope";
import { formatCalendarTime, parseCalendarEventTime } from "./calendar-time-adapter";

function entryTimeLabel(entry: CalendarDayEntry, locale: string): string {
  if (entry.interval.kind === "allDay") return t("calendar.all_day");
  const zone = entry.interval.timeZone;
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const start = entry.interval.startInstant.toZonedDateTimeISO(zone).toLocaleString(locale, options);
  const end = entry.interval.endInstantExclusive.toZonedDateTimeISO(zone).toLocaleString(locale, options);
  return `${start} – ${end}`;
}

export function CalendarAgenda(props: {
  date: Temporal.PlainDate;
  entries: readonly CalendarDayEntry[];
  calendarsById: ReadonlyMap<string, DenCalendar>;
  locale: string;
  selectedEventId: string | null;
  canCreate: boolean;
  onOpenEvent: (eventId: string) => void;
  onCreate?: () => void;
}) {
  const heading = props.date.toLocaleString(props.locale, { dateStyle: "full" });
  return (
    <section aria-labelledby="calendar-agenda-heading" className="flex min-h-0 min-w-0 flex-col gap-2" data-testid="calendar-agenda">
      <h3 id="calendar-agenda-heading" className="text-sm font-semibold text-dls-text" data-testid="calendar-agenda-date">{heading}</h3>
      {props.entries.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-dls-border p-3" data-testid="calendar-agenda-empty">
          <p className="text-sm text-dls-secondary">{t("calendar.agenda_empty")}</p>
          {props.canCreate && props.onCreate ? (
            <Button type="button" variant="outline" size="sm" onClick={props.onCreate} data-testid="calendar-agenda-create">
              <CalendarPlus className="size-4" aria-hidden="true" />
              {t("calendar.create_event")}
            </Button>
          ) : null}
        </div>
      ) : (
        <ol className="flex flex-col gap-1" data-testid="calendar-agenda-list">
          {props.entries.map((entry) => {
            const calendar = props.calendarsById.get(entry.event.calendarId);
            const selected = entry.event.id === props.selectedEventId;
            return (
              <li key={entry.event.id}>
                <button
                  type="button"
                  onClick={() => props.onOpenEvent(entry.event.id)}
                  aria-current={selected ? "true" : undefined}
                  className="flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 aria-[current=true]:bg-dls-active"
                  data-testid={`calendar-agenda-item-${entry.event.id}`}
                >
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: calendar?.color ?? "var(--dls-accent)" }} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-dls-text">{entry.event.title}</span>
                    <span className="block truncate text-xs text-dls-secondary">{entryTimeLabel(entry, props.locale)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function CalendarEventDetail(props: {
  event: DenCalendarEvent;
  scope?: CalendarScope;
  calendar: DenCalendar | undefined;
  locale: string;
  onClose: () => void;
  onEdit?: () => void;
  onStartMeeting?: () => void;
  meetingPending?: boolean;
  meetingError?: string;
  membersById?: ReadonlyMap<string, DenOrganizationMember>;
  currentMemberId?: string;
  currentUserLabel?: string;
  recurringOccurrence?: boolean;
  schedulingEditUnavailable?: "loading" | "error" | "offline";
  onDelete?: (scope: "this" | "this-and-following") => void;
  onRsvp?: (responseStatus: "accepted" | "declined" | "tentative", scope: "this" | "all") => void;
  actionPending?: boolean;
  actionError?: string;
}) {
  const sectionRef = React.useRef<HTMLElement | null>(null);
  // Move focus to the detail when it opens or switches events, so screen readers announce it.
  React.useEffect(() => { sectionRef.current?.focus(); }, [props.event.id]);
  const interval = React.useMemo(() => {
    try { return parseCalendarEventTime(props.event.time); } catch { return null; }
  }, [props.event.time]);
  const scheduling = isSchedulingEvent(props.event) ? props.event : null;
  const reminderEventId = props.recurringOccurrence || scheduling?.recurrence ? seriesIdFromDisplayId(props.event.id) : props.event.id;
  const reminders = props.scope ? readCalendarReminderMinutes(props.scope, reminderEventId) : DEFAULT_CALENDAR_REMINDER_MINUTES;
  const owner = props.membersById?.get(props.event.ownerMemberId);
  const displayName = (memberId: string) => {
    const member = props.membersById?.get(memberId);
    return member?.user.name?.trim() || member?.user.account?.trim() || member?.user.email?.trim() || memberId;
  };
  const recurrenceLabel = scheduling?.recurrence
    ? t(`calendar.recurrence_${scheduling.recurrence.frequency}`)
    : null;
  const attendeeResponse = scheduling?.attendees.find((attendee) => attendee.memberId === props.currentMemberId)?.responseStatus;
  const currentMemberCanRespond = attendeeResponse !== undefined;
  const accepted = scheduling?.attendees.filter((item) => item.responseStatus === "accepted").length ?? 0;
  const pending = scheduling?.attendees.filter((item) => item.responseStatus === "needs-action").length ?? 0;
  const eventColor = props.calendar?.color ?? "#3370ff";
  const calendarOwner = props.calendar ? props.membersById?.get(props.calendar.ownerMemberId) : undefined;
  const calendarLabel = props.calendar?.isDefault
    ? calendarOwner?.user.name?.trim() || calendarOwner?.user.account?.trim() || calendarOwner?.user.email?.trim() || (props.calendar.ownerMemberId === props.currentMemberId ? props.currentUserLabel?.trim() : "") || props.calendar.name
    : props.calendar?.name;
  const [scopeAction, setScopeAction] = React.useState<{ kind: "delete" } | { kind: "rsvp"; responseStatus: "accepted" | "declined" | "tentative" } | null>(null);
  const [scopeSelection, setScopeSelection] = React.useState<"this" | "following">("this");
  React.useEffect(() => { setScopeAction(null); setScopeSelection("this"); }, [props.event.id]);
  const requestDelete = () => {
    if (!props.onDelete || props.actionPending) return;
    if (props.recurringOccurrence) { setScopeSelection("this"); setScopeAction({ kind: "delete" }); }
    else props.onDelete("this");
  };
  const requestRsvp = (responseStatus: "accepted" | "declined" | "tentative") => {
    if (!props.onRsvp || props.actionPending || responseStatus === attendeeResponse) return;
    if (props.recurringOccurrence) { setScopeSelection("this"); setScopeAction({ kind: "rsvp", responseStatus }); }
    else props.onRsvp(responseStatus, "all");
  };
  const confirmScopeAction = () => {
    if (!scopeAction || props.actionPending) return;
    const action = scopeAction;
    setScopeAction(null);
    if (action.kind === "delete") props.onDelete?.(scopeSelection === "this" ? "this" : "this-and-following");
    else props.onRsvp?.(action.responseStatus, scopeSelection === "this" ? "this" : "all");
  };
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-busy={props.actionPending || undefined}
      aria-labelledby="calendar-event-detail-title"
      className="flex min-h-0 min-w-0 flex-col overflow-y-auto rounded-lg bg-dls-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35"
      data-testid="calendar-event-detail"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <header
        className="shrink-0 bg-[linear-gradient(135deg,rgba(233,240,255,0.96)_0%,rgba(247,249,255,0.98)_62%,rgba(255,255,255,1)_100%)] px-4 pb-3 pt-2 dark:bg-[linear-gradient(135deg,rgba(27,38,66,0.98)_0%,rgba(24,29,42,0.98)_65%,rgba(20,20,22,1)_100%)]"
        data-testid="calendar-event-detail-hero"
      >
        <div className="flex h-8 items-center justify-end gap-0.5" data-testid="calendar-event-detail-actions">
          {props.onEdit ? (
            <Button type="button" variant="ghost" size="icon-sm" className="rounded-lg text-dls-text hover:bg-white/65 dark:hover:bg-white/10" aria-label={t("calendar.edit_event")} title={t("calendar.edit_event")} onClick={props.onEdit} data-testid="calendar-event-detail-edit">
              <Pencil className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
          {props.onDelete ? <Button type="button" variant="ghost" size="icon-sm" className="rounded-lg text-dls-text hover:bg-white/65 dark:hover:bg-white/10" disabled={props.actionPending} aria-label={t("calendar.delete_event")} onClick={requestDelete} data-testid="calendar-event-detail-delete"><Trash2 className="size-4" aria-hidden="true" /></Button> : null}
          <span className="mx-1 h-4 w-px bg-dls-border" aria-hidden="true" />
          <Button type="button" variant="ghost" size="icon-sm" className="rounded-lg text-dls-text hover:bg-white/65 dark:hover:bg-white/10" aria-label={t("calendar.close_detail")} onClick={props.onClose} data-testid="calendar-event-detail-close">
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-4">
          <span className="mt-1 size-3.5 shrink-0 rounded-[4px]" style={{ backgroundColor: eventColor }} aria-hidden="true" />
          <div className="min-w-0">
            <h3 id="calendar-event-detail-title" className="max-h-16 overflow-y-auto break-words text-base font-semibold leading-[22px] tracking-[-0.015em]" style={{ color: eventColor }} data-testid="calendar-event-detail-title">{props.event.title}</h3>
            <p className="mt-1.5 text-xs leading-[18px]" style={{ color: eventColor }} data-testid="calendar-event-detail-time">
              {interval ? formatCalendarTime(interval, props.locale) : "—"}
              {interval?.kind === "allDay" ? <span className="ml-1">({t("calendar.all_day")})</span> : null}
              {interval?.kind === "timed" ? <span className="ml-1">(<span data-testid="calendar-event-detail-zone">{interval.timeZone}</span>)</span> : null}
            </p>
            {recurrenceLabel ? <p className="mt-0.5 text-xs leading-[18px]" style={{ color: eventColor }} data-testid="calendar-event-detail-recurrence">{recurrenceLabel}</p> : null}
            <p className="sr-only" data-testid="calendar-event-detail-status">{t("calendar.status_saved")}</p>
          </div>
        </div>
      </header>
      <div className="subtle-scrollbar min-h-0 overflow-y-auto px-4 py-3" data-testid="calendar-event-detail-body">
        <div className="space-y-3 text-xs leading-[18px]">
          {props.event.videoConferenceEnabled && props.onStartMeeting ? (
            <DetailRow icon={<Video className="size-4" />}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" className="h-7 rounded-md bg-dls-surface px-2 text-xs font-normal" disabled={props.meetingPending} onClick={props.onStartMeeting} data-testid="calendar-event-start-meeting">
                    {props.meetingPending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
                    {props.meetingPending ? t("calendar.meeting_starting") : t("calendar.meeting_start")}
                  </Button>
                </div>
                {props.meetingError ? <p className="mt-2 text-xs text-red-600" role="alert" data-testid="calendar-event-meeting-error">{props.meetingError}</p> : null}
              </div>
            </DetailRow>
          ) : null}
          <DetailRow icon={<UserRound className="size-4" />}>
            <MemberLine member={owner} fallbackName={owner ? displayName(owner.id) : displayName(props.event.ownerMemberId)} status={scheduling?.attendees.find((item) => item.memberId === props.event.ownerMemberId)?.responseStatus} />
            <span className="rounded-md bg-[#e8efff] px-1.5 py-0.5 text-[10px] leading-3 font-medium text-[#2864dc] dark:bg-blue-500/15 dark:text-blue-300">{t("calendar.attendee_creator")}</span>
          </DetailRow>
          {scheduling ? (
            <DetailRow icon={<Users className="size-4" />} align="start">
              <div className="min-w-0 flex-1">
                <p className="font-medium leading-[18px] text-dls-text">{t("calendar.attendees_count", { count: scheduling.attendees.length })}</p>
                <p className="mt-0.5 text-xs leading-[18px] text-dls-secondary">{t("calendar.attendee_response_summary", { accepted, pending })}</p>
                <div className="mt-2 space-y-2" data-testid="calendar-event-detail-attendees">
                  {scheduling.attendees.map((attendee) => {
                    const member = props.membersById?.get(attendee.memberId);
                    return <MemberLine key={attendee.memberId} member={member} fallbackName={displayName(attendee.memberId)} status={attendee.responseStatus} />;
                  })}
                </div>
              </div>
            </DetailRow>
          ) : null}
          {props.event.description ? <DetailRow icon={<FileText className="size-4" />} align="start"><p className="whitespace-pre-wrap break-words leading-[18px] text-dls-text" data-testid="calendar-event-detail-description">{props.event.description}</p></DetailRow> : null}
          {reminders.length > 0 ? <DetailRow icon={<Bell className="size-4" />}>
            <ul className="leading-[18px] text-dls-text" data-testid="calendar-event-detail-reminder">{reminders.map((minutes) => <li key={minutes}>{reminderLabel(minutes)}</li>)}</ul>
          </DetailRow> : null}
          <DetailRow icon={<CalendarDays className="size-4" data-testid="calendar-event-detail-calendar-icon" />}>
            <p className="leading-[18px] text-dls-text" data-testid="calendar-event-detail-calendar">{calendarLabel ?? "—"}</p>
          </DetailRow>
        </div>
        {props.recurringOccurrence ? <p className="mt-3 rounded-lg bg-dls-hover px-3 py-2 text-xs text-dls-secondary" role="note" data-testid="calendar-occurrence-read-only">{t("calendar.occurrence_read_only")}</p> : null}
        {props.schedulingEditUnavailable ? <p className="mt-3 rounded-lg bg-dls-hover px-3 py-2 text-xs text-dls-secondary" role="note" data-testid={`calendar-scheduling-edit-${props.schedulingEditUnavailable}`}>{t(props.schedulingEditUnavailable === "loading" ? "calendar.scheduling_edit_loading" : props.schedulingEditUnavailable === "offline" ? "calendar.scheduling_edit_offline" : "calendar.scheduling_edit_unavailable")}</p> : null}
        {props.actionError ? <p className="mt-3 text-xs text-red-600" role="alert" data-testid="calendar-event-action-error">{props.actionError}</p> : null}
      </div>
      <Dialog open={scopeAction !== null} onOpenChange={(open) => { if (!open && !props.actionPending) setScopeAction(null); }}>
        {scopeAction ? (
          <DialogContent showCloseButton={false} data-testid={`calendar-event-${scopeAction.kind}-scope`}>
            <DialogHeader>
              <DialogTitle>{t(scopeAction.kind === "delete" ? "calendar.delete_scope_title" : "calendar.rsvp_scope_title")}</DialogTitle>
            </DialogHeader>
            <RadioGroup value={scopeSelection} onValueChange={(value) => { if (value === "this" || value === "following") setScopeSelection(value); }} aria-label={t(scopeAction.kind === "delete" ? "calendar.delete_scope_title" : "calendar.rsvp_scope_title")}>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dls-border px-4 py-3 text-sm text-dls-text hover:bg-dls-hover">
                <RadioGroupItem value="this" disabled={props.actionPending} onClick={() => setScopeSelection("this")} data-testid={`calendar-event-${scopeAction.kind}-scope-this`} />
                <span>{t(scopeAction.kind === "delete" ? "calendar.delete_scope_this" : "calendar.rsvp_scope_this")}</span>
              </label>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dls-border px-4 py-3 text-sm text-dls-text hover:bg-dls-hover">
                <RadioGroupItem value="following" disabled={props.actionPending} onClick={() => setScopeSelection("following")} data-testid={`calendar-event-${scopeAction.kind}-scope-all`} />
                <span>{t(scopeAction.kind === "delete" ? "calendar.delete_scope_this_and_following" : "calendar.rsvp_scope_all")}</span>
              </label>
            </RadioGroup>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={props.actionPending} onClick={() => setScopeAction(null)}>{t("calendar.cancel")}</Button>
              <Button type="button" variant={scopeAction.kind === "delete" ? "destructive" : "default"} disabled={props.actionPending} onClick={confirmScopeAction} data-testid={`calendar-event-${scopeAction.kind}-scope-confirm`}>
                {scopeAction.kind === "delete" ? t("calendar.delete_event") : t(`calendar.rsvp_${scopeAction.responseStatus === "accepted" ? "accept" : scopeAction.responseStatus === "declined" ? "decline" : "tentative"}`)}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      {scheduling && currentMemberCanRespond ? (
        <footer className="shrink-0 border-t border-dls-border bg-dls-surface px-4 py-2" data-testid="calendar-event-detail-rsvp" data-response-status={attendeeResponse}>
          <div className="grid grid-cols-3 gap-3">
            <ResponseButton active={attendeeResponse === "accepted"} tone="accepted" unavailable={!props.onRsvp || props.actionPending === true} onClick={() => requestRsvp("accepted")}>{t(attendeeResponse === "accepted" ? "calendar.rsvp_accepted" : "calendar.rsvp_accept")}</ResponseButton>
            <ResponseButton active={attendeeResponse === "declined"} tone="declined" unavailable={!props.onRsvp || props.actionPending === true} onClick={() => requestRsvp("declined")}>{t(attendeeResponse === "declined" ? "calendar.rsvp_declined" : "calendar.rsvp_decline")}</ResponseButton>
            <ResponseButton active={attendeeResponse === "tentative"} tone="tentative" unavailable={!props.onRsvp || props.actionPending === true} onClick={() => requestRsvp("tentative")}>{t(attendeeResponse === "tentative" ? "calendar.rsvp_tentative_selected" : "calendar.rsvp_tentative")}</ResponseButton>
          </div>
        </footer>
      ) : null}
    </section>
  );
}

function DetailRow(props: { icon: React.ReactNode; children: React.ReactNode; align?: "center" | "start" }) {
  return (
    <div className={cn("grid grid-cols-[16px_minmax(0,1fr)] gap-x-4", props.align === "start" ? "items-start" : "items-center")}>
      <span className={cn("text-[#8f98a6]", props.align === "start" && "mt-0.5")} aria-hidden="true">{props.icon}</span>
      <div className="flex min-w-0 items-center gap-2">{props.children}</div>
    </div>
  );
}

function MemberLine(props: { member?: DenOrganizationMember; fallbackName: string; status?: DenCalendarSchedulingEvent["attendees"][number]["responseStatus"] }) {
  const name = props.fallbackName.trim() || "?";
  return (
    <div className="flex min-w-0 items-center gap-2" data-response-status={props.status}>
      <Avatar className="bg-dls-text/10">
        {props.member?.user.avatar ? <AvatarImage src={props.member.user.avatar} alt="" /> : null}
        <AvatarFallback className="bg-dls-text/10 text-xs font-medium text-dls-text">{name.slice(0, 1).toLocaleUpperCase()}</AvatarFallback>
        {props.status === "accepted" ? <AvatarBadge className="size-3 bg-[#20b94b] text-white ring-1 ring-dls-surface" data-response-badge="accepted"><Check className="size-2.5 stroke-[3]" aria-hidden="true" /></AvatarBadge> : null}
        {props.status === "declined" ? <AvatarBadge className="size-3 bg-[#f54a45] text-white ring-1 ring-dls-surface" data-response-badge="declined"><Minus className="size-2.5 stroke-[3]" aria-hidden="true" /></AvatarBadge> : null}
        {props.status === "tentative" ? <AvatarBadge className="size-3 bg-[#646a73] text-[10px] font-semibold leading-none text-white ring-1 ring-dls-surface" data-response-badge="tentative">?</AvatarBadge> : null}
      </Avatar>
      <span className="min-w-0 truncate leading-[18px] text-dls-text">{name}</span>
    </div>
  );
}

function ResponseButton(props: { active: boolean; tone: "accepted" | "declined" | "tentative"; unavailable: boolean; onClick: () => void; children: React.ReactNode }) {
  const disabled = props.active || props.unavailable;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "h-8 rounded-md border border-dls-border bg-dls-surface px-2 text-[13px] font-medium text-dls-text shadow-[0_1px_1px_rgba(15,23,42,0.03)] hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 disabled:cursor-not-allowed",
        props.unavailable && !props.active && "disabled:opacity-50",
        props.active && props.tone === "accepted" && "border-[#21a443] bg-[#e5f8e5] text-[#178332] dark:border-green-500/70 dark:bg-green-500/15 dark:text-green-300",
        props.active && props.tone === "declined" && "border-[#e5484d] bg-[#fff1f0] text-[#d8393e] dark:border-red-500/70 dark:bg-red-500/15 dark:text-red-300",
        props.active && props.tone === "tentative" && "border-[#646a73] bg-[#f2f3f5] text-[#373c43] dark:border-slate-400/70 dark:bg-slate-400/15 dark:text-slate-200",
      )}
    >
      {props.children}
    </button>
  );
}

// CalendarPage uses scheduling:<encoded series id>:<index> for projected occurrences, including offline snapshots.
function seriesIdFromDisplayId(id: string): string {
  const encoded = /^scheduling:([^:]+):\d+$/.exec(id)?.[1];
  if (!encoded) return id;
  try { return decodeURIComponent(encoded); } catch { return id; }
}

function isSchedulingEvent(event: DenCalendarEvent): event is DenCalendarSchedulingEvent {
  return "attendees" in event && Array.isArray(event.attendees) && "recurrence" in event;
}
