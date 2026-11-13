/** @jsxImportSource react */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Check, ChevronDown, LoaderCircle, Search, Trash2, Users } from "lucide-react";
import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendar, DenCalendarAvailabilityInput, DenCalendarEvent, DenCalendarSchedulingEvent, DenOrganizationMember } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
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
const MAX_SCHEDULING_MEMBERS = CALENDAR_EVENT_ATTENDEE_MAX;

function memberName(member: DenOrganizationMember): string {
  return member.user.name?.trim() || member.user.account?.trim() || member.user.email?.trim() || member.userId;
}

function groupMemberRoster(result: unknown): unknown[] {
  const envelope = result && typeof result === "object" && "data" in result ? (result as { data: unknown }).data : result;
  if (!envelope || typeof envelope !== "object") return Array.isArray(envelope) ? envelope : [];
  const value = envelope as Record<string, unknown>;
  return Array.isArray(value.items) ? value.items : Array.isArray(value.members) ? value.members : [];
}

function availabilityRange(form: CalendarEventFormValues, timeZone: string): DenCalendarAvailabilityInput | null {
  try {
    const startDate = Temporal.PlainDate.from(form.time.startDate);
    const endDate = startDate.add({ days: 1 });
    return {
      memberIds: [...new Set(form.attendeeMemberIds)].sort(),
      startInstant: startDate.toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from("00:00") }).toInstant().toString(),
      endInstantExclusive: endDate.toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from("00:00") }).toInstant().toString(),
      timeZone,
    };
  } catch {
    return null;
  }
}

function CalendarAvailabilityPanel(props: {
  form: CalendarEventFormValues;
  membersById: Map<string, DenOrganizationMember>;
  availabilityByMemberId: Map<string, { memberId: string; busy: Array<{ startInstant: string; endInstantExclusive: string }> } | { memberId: string; unknown: true }>;
  loading: boolean;
  error: boolean;
  online: boolean;
  timeZone: string;
}) {
  const date = props.form.time.startDate;
  const intervalPosition = (instant: string) => {
    try {
      const value = Temporal.Instant.from(instant).toZonedDateTimeISO(props.timeZone);
      return Math.max(0, Math.min(100, (value.hour * 60 + value.minute) / 14.4));
    } catch {
      return 0;
    }
  };
  return (
    <aside className="min-w-0 rounded-2xl border border-dls-border bg-dls-sidebar/60 p-4 sm:p-5" aria-label={t("calendar.availability")} data-testid="calendar-availability-panel">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-dls-text">{t("calendar.availability")}</p>
          <p className="mt-1 text-xs text-dls-secondary" data-testid="calendar-availability-date">{date} · {props.timeZone}</p>
        </div>
        <CalendarDays className="size-5 text-dls-secondary" aria-hidden="true" />
      </div>
      {!props.online ? <p className="rounded-lg bg-dls-hover p-3 text-xs text-dls-secondary" data-testid="calendar-availability-offline">{t("calendar.availability_offline")}</p> : null}
      {props.online && props.form.attendeeMemberIds.length === 0 ? <p className="rounded-lg bg-dls-hover p-3 text-xs text-dls-secondary">{t("calendar.availability_empty")}</p> : null}
      {props.online && props.loading ? <p className="inline-flex items-center gap-2 text-xs text-dls-secondary" role="status"><LoaderCircle className="size-3 animate-spin" />{t("calendar.availability_loading")}</p> : null}
      {props.online && props.error ? <p className="text-xs text-red-600" role="alert">{t("calendar.availability_failed")}</p> : null}
      {props.form.attendeeMemberIds.length > 0 ? (
        <div className="space-y-3">
          <div className="ml-28 grid grid-cols-5 text-[10px] text-dls-secondary" aria-hidden="true"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span className="text-right">24:00</span></div>
          {props.form.attendeeMemberIds.map((memberId) => {
            const member = props.membersById.get(memberId);
            const availability = props.availabilityByMemberId.get(memberId);
            return (
              <div key={memberId} className="grid grid-cols-[6.25rem_1fr] items-center gap-3" data-testid={`calendar-availability-member-${memberId}`}>
                <span className="truncate text-xs text-dls-text">{member ? memberName(member) : memberId}</span>
                {!availability || props.loading || props.error || "unknown" in availability ? (
                  <div className="flex h-7 items-center rounded-md border border-dashed border-dls-border px-2 text-[10px] text-dls-secondary">{t("calendar.availability_unknown")}</div>
                ) : (
                  <div className="relative h-7 overflow-hidden rounded-md bg-emerald-500/10" aria-label={t("calendar.availability_busy_free")}>
                    {[25, 50, 75].map((left) => <span key={left} className="absolute inset-y-0 w-px bg-dls-border" style={{ left: `${left}%` }} />)}
                    {availability && "busy" in availability ? availability.busy.map((busy, index) => {
                      const left = intervalPosition(busy.startInstant);
                      const right = intervalPosition(busy.endInstantExclusive);
                      return <span key={`${busy.startInstant}:${index}`} className="absolute inset-y-1 rounded bg-dls-accent/70" style={{ left: `${left}%`, width: `${Math.max(1, right - left)}%` }} data-testid={`calendar-busy-${memberId}-${index}`} />;
                    }) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      <p className="mt-5 text-[11px] leading-4 text-dls-secondary">{t("calendar.availability_privacy")}</p>
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
  const [debouncedAvailability, setDebouncedAvailability] = React.useState<DenCalendarAvailabilityInput | null>(null);
  const nextAvailability = React.useMemo(() => availabilityRange(form, props.timeZone), [form.attendeeMemberIds, form.time, props.timeZone]);
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
  const availabilityByMemberId = React.useMemo(() => new Map((availabilityCurrent ? availabilityQuery.data?.members ?? [] : []).map((member) => [member.memberId, member])), [availabilityCurrent, availabilityQuery.data]);

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
    setForm((current) => ({ ...current, time: { ...current.time, ...patch } as CalendarEventFormValues["time"] }));
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

  const formView = (
    <form
      aria-labelledby={`${formId}-title`}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-dls-border bg-dls-surface p-3",
        dialogPresentation && "h-full min-h-0 gap-0 overflow-y-auto rounded-2xl p-0 shadow-sm",
      )}
      data-testid="calendar-event-form"
      data-status={status.kind}
      noValidate
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) {
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
        dialogPresentation && "sticky top-0 z-10 border-b border-dls-border bg-dls-surface px-6 py-4 text-center text-base",
      )}>
        {isEdit ? t("calendar.edit_event") : t("calendar.create_event")}
      </h3>
      <div className={cn("grid min-h-0 flex-1 grid-cols-1 gap-5", dialogPresentation && "overflow-y-auto px-5 py-5 sm:px-7 sm:py-6", "lg:grid-cols-[minmax(0,1.12fr)_minmax(19rem,.88fr)]")} data-testid="calendar-editor-columns">
      <div className="min-w-0 space-y-4">
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
      <fieldset disabled={pending} className={cn("flex min-w-0 flex-col gap-3", dialogPresentation && "gap-4")}>
        <label className="flex flex-col gap-1 text-xs text-dls-secondary">
          {t("calendar.field_title")}
          <input
            ref={titleInput}
            className={cn(inputClass, dialogPresentation && "h-12 px-3 text-base font-medium")}
            value={form.title}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy("title")}
            onChange={(event) => update({ title: event.target.value })}
            data-testid="calendar-form-title"
          />
          {fieldError("title")}
        </label>
        <label className="flex flex-col gap-1 text-xs text-dls-secondary">
          {t("calendar.detail_calendar")}
          <select
            className={cn(inputClass, dialogPresentation && "h-10 px-3")}
            value={form.calendarId}
            aria-invalid={errors.calendarId ? true : undefined}
            aria-describedby={describedBy("calendarId")}
            onChange={(event) => {
              const calendarId = event.target.value;
              const selectingTeam = props.teamCalendarIds?.has(calendarId) === true;
              update({
                calendarId,
                attendeeMemberIds: selectingTeam
                  ? form.attendeeMemberIds.filter((memberId) => memberId !== creatorMemberId)
                  : [...new Set([creatorMemberId, ...form.attendeeMemberIds])],
              });
            }}
            data-testid="calendar-form-calendar"
          >
            {props.calendars.map((calendar) => <option key={calendar.id} value={calendar.id} disabled={advancedScheduling && props.teamCalendarIds?.has(calendar.id)}>{calendar.name}</option>)}
          </select>
          {fieldError("calendarId")}
        </label>
        {!teamSelected ? <Popover open={peopleOpen} onOpenChange={setPeopleOpen}>
          <div className="flex flex-col gap-1 text-xs text-dls-secondary">
          <span>{t("calendar.attendees")}</span>
          <PopoverTrigger render={<button type="button" className={cn(inputClass, "flex h-auto min-h-10 items-center justify-between gap-2 px-3 py-2 text-left")} aria-expanded={peopleOpen} aria-haspopup="listbox" aria-controls={`${formId}-attendees-picker`} data-testid="calendar-form-attendees-trigger" />}>
            <span className="flex min-w-0 flex-1 flex-wrap gap-1">
              {form.attendeeMemberIds.length ? form.attendeeMemberIds.map((memberId) => <span key={memberId} className="rounded-full bg-dls-hover px-2 py-0.5 text-xs text-dls-text">{membersById.has(memberId) ? memberName(membersById.get(memberId)!) : memberId}</span>) : <span className="text-dls-secondary">{t("calendar.attendees_placeholder")}</span>}
            </span>
            <ChevronDown className="size-4 shrink-0" />
          </PopoverTrigger>
          {fieldError("attendees")}
          {peopleOpen ? (
            <PopoverContent id={`${formId}-attendees-picker`} align="start" className="max-h-80 w-[min(28rem,calc(100vw-2rem))] gap-0 overflow-y-auto rounded-xl border border-dls-border bg-dls-surface p-2 shadow-xl" role="listbox" data-testid="calendar-attendees-picker" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPeopleOpen(false); } }}>
              <label className="mb-2 flex items-center gap-2 rounded-lg border border-dls-border px-2"><Search className="size-3.5" aria-hidden="true" /><input aria-label={t("calendar.attendees_search")} className="h-8 min-w-0 flex-1 bg-transparent text-sm text-dls-text outline-none" value={peopleSearch} onChange={(event) => setPeopleSearch(event.target.value)} placeholder={t("calendar.attendees_search")} /></label>
              {membersQuery.isLoading ? <p className="p-2 text-xs">{t("calendar.attendees_loading")}</p> : null}
              {membersQuery.isError ? <p className="p-2 text-xs text-red-600">{t("calendar.attendees_failed")}</p> : null}
              {members.filter((member) => memberName(member).toLocaleLowerCase().includes(peopleSearch.trim().toLocaleLowerCase())).map((member) => {
                const selected = form.attendeeMemberIds.includes(member.id);
                 const requiredCreator = !teamSelected && member.id === creatorMemberId;
                 return <button key={member.id} type="button" className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-70" disabled={requiredCreator} aria-disabled={requiredCreator || undefined} onClick={() => toggleMember(member.id)} data-testid={`calendar-attendee-${member.id}`}><span className="flex-1 truncate">{memberName(member)}</span>{selected ? <Check className="size-4 text-dls-accent" /> : null}</button>;
              })}
              <div className="my-2 h-px bg-dls-border" />
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-dls-secondary">{t("calendar.groups")}</p>
              {groupsError ? <p className="p-2 text-xs text-red-600">{groupsError}</p> : null}
              {groups.filter((group) => group.name.toLocaleLowerCase().includes(peopleSearch.trim().toLocaleLowerCase())).map((group) => <button key={group.id} type="button" disabled={loadingGroupId !== null || !membersQuery.isSuccess} className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-50" onClick={() => void addGroup(group)} data-testid={`calendar-group-${group.id}`}><Users className="size-4 text-dls-secondary" /><span className="flex-1 truncate">{group.name}</span>{loadingGroupId === group.id ? <LoaderCircle className="size-3 animate-spin" /> : null}</button>)}
              {groupFeedback ? <p className="p-2 text-xs text-dls-secondary" role="status" data-testid="calendar-group-feedback">{groupFeedback}</p> : null}
            </PopoverContent>
          ) : null}
          </div>
        </Popover> : <p className="rounded-lg bg-dls-hover px-3 py-2 text-xs text-dls-secondary" data-testid="calendar-team-scheduling-unavailable">{t("calendar.team_scheduling_unsupported")}</p>}
        <label className="flex items-center gap-2 text-sm text-dls-text">
          <input
            type="checkbox"
            checked={time.kind === "allDay"}
            onChange={(event) => setForm((current) => switchCalendarFormTimeKind(current, event.target.checked ? "allDay" : "timed", props.timeZone))}
            data-testid="calendar-form-all-day"
          />
          {t("calendar.all_day")}
        </label>
        <div className={cn("grid grid-cols-2 gap-2", dialogPresentation && "grid-cols-1 gap-3 sm:grid-cols-2")} role="group" aria-label={t("calendar.detail_time")} aria-describedby={describedBy("time")} data-testid="calendar-form-time-grid">
          {time.kind === "allDay" ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_start_date")}
                <input type="date" className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={time.startDate} onChange={(event) => updateTime({ startDate: event.target.value })} data-testid="calendar-form-start-date" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_end_date_exclusive")}
                <input type="date" className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={time.endDateExclusive} onChange={(event) => updateTime({ endDateExclusive: event.target.value })} data-testid="calendar-form-end-date" />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_start_date")}
                <input type="date" className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={time.startDate} onChange={(event) => updateTime({ startDate: event.target.value })} data-testid="calendar-form-start-date" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_start_time")}
                <input type="time" step={1800} list={`${formId}-time-options`} className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={time.startTime.slice(0, 5)} onChange={(event) => updateTime({ startTime: event.target.value })} data-testid="calendar-form-start-time" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_end_date")}
                <input type="date" className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={time.endDate} onChange={(event) => updateTime({ endDate: event.target.value })} data-testid="calendar-form-end-date" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_end_time")}
                <input type="time" step={1800} list={`${formId}-time-options`} className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={time.endTime.slice(0, 5)} onChange={(event) => updateTime({ endTime: event.target.value })} data-testid="calendar-form-end-time" />
              </label>
              <p className="col-span-2 text-xs text-dls-secondary" data-testid="calendar-form-zone">{t("calendar.detail_time_zone")}: {time.timeZone}</p>
            </>
          )}
        </div>
        {fieldError("time")}
        <datalist id={`${formId}-time-options`} data-testid="calendar-time-options">{timeOptions.map((value) => <option key={value} value={value} />)}</datalist>
        {!teamSelected ? <><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-dls-secondary">{t("calendar.recurrence")}<select className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={form.recurrence.frequency} onChange={(event) => update({ recurrence: event.target.value === "none" ? { frequency: "none" } : defaultCalendarRecurrence(event.target.value as "daily" | "weekly" | "monthly", form.time.startDate) })} data-testid="calendar-form-recurrence"><option value="none">{t("calendar.recurrence_none")}</option><option value="daily">{t("calendar.recurrence_daily")}</option><option value="weekly">{t("calendar.recurrence_weekly")}</option><option value="monthly">{t("calendar.recurrence_monthly")}</option></select></label>
          {form.recurrence.frequency !== "none" ? <label className="flex flex-col gap-1 text-xs text-dls-secondary">{t("calendar.recurrence_interval")}<input type="number" min={1} max={365} className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={form.recurrence.interval} onChange={(event) => update({ recurrence: { ...form.recurrence, interval: Number(event.target.value) } as CalendarEventFormValues["recurrence"] })} data-testid="calendar-form-recurrence-interval" /></label> : null}
        </div>
        {form.recurrence.frequency !== "none" ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><label className="flex flex-col gap-1 text-xs text-dls-secondary">{t("calendar.recurrence_end")}<select className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={form.recurrence.endKind} onChange={(event) => update({ recurrence: { ...form.recurrence, endKind: event.target.value as "never" | "until" | "count" } as CalendarEventFormValues["recurrence"] })} data-testid="calendar-form-recurrence-end"><option value="never">{t("calendar.recurrence_never")}</option><option value="until">{t("calendar.recurrence_until")}</option><option value="count">{t("calendar.recurrence_count")}</option></select></label>{form.recurrence.endKind === "until" ? <label className="flex flex-col gap-1 text-xs text-dls-secondary">{t("calendar.recurrence_until")}<input type="date" className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={form.recurrence.untilDate} onChange={(event) => update({ recurrence: { ...form.recurrence, untilDate: event.target.value } as CalendarEventFormValues["recurrence"] })} data-testid="calendar-form-recurrence-until" /></label> : null}{form.recurrence.endKind === "count" ? <label className="flex flex-col gap-1 text-xs text-dls-secondary">{t("calendar.recurrence_occurrences")}<input type="number" min={1} max={1000} className={cn(inputClass, dialogPresentation && "h-10 px-3")} value={form.recurrence.count} onChange={(event) => update({ recurrence: { ...form.recurrence, count: Number(event.target.value) } as CalendarEventFormValues["recurrence"] })} data-testid="calendar-form-recurrence-count" /></label> : null}</div> : null}
        {fieldError("recurrence")}</> : null}
        <label className="flex flex-col gap-1 text-xs text-dls-secondary">
          {t("calendar.field_description")}
          <textarea
            className={cn(inputClass, "h-20 py-1", dialogPresentation && "min-h-32 px-3 py-2")}
            value={form.description}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={describedBy("description")}
            onChange={(event) => update({ description: event.target.value })}
            data-testid="calendar-form-description"
          />
          {fieldError("description")}
        </label>
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
      {!teamSelected ? <CalendarAvailabilityPanel form={form} membersById={membersById} availabilityByMemberId={availabilityByMemberId} loading={online && form.attendeeMemberIds.length > 0 && (!availabilityCurrent || availabilityQuery.isFetching)} error={availabilityCurrent && availabilityQuery.isError} online={online} timeZone={props.timeZone} /> : null}
      </div>

      <div className={cn(
        "flex flex-wrap items-center gap-2",
        dialogPresentation && "sticky bottom-0 z-10 mt-auto border-t border-dls-border bg-dls-surface px-5 py-4 sm:px-8",
      )} data-testid="calendar-form-actions">
        {base ? (
          <Button type="button" size="sm" variant="ghost" disabled={pending || !online} title={!online ? t("calendar.offline_delete_unavailable") : undefined} onClick={() => setConfirmingDelete(true)} aria-label={t("calendar.delete_event")} data-testid="calendar-form-delete">
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
        <Button type="button" size="sm" variant={dialogPresentation ? "outline" : "ghost"} className="ml-auto" disabled={pending} onClick={props.onCancel} data-testid="calendar-form-cancel">{t("calendar.cancel")}</Button>
        {props.onSaveDraft && (!online || (status.kind === "failed" && status.failure.kind === "network")) ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void keepDraft()} data-testid="calendar-form-save-draft">
            {t("calendar.draft_keep")}
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={!online || pending || (status.kind === "conflict")} data-testid="calendar-form-save">
          {status.kind === "failed" && status.failure.kind === "network" ? t("calendar.retry_save") : t("calendar.save")}
        </Button>
      </div>
    </form>
  );

  if (!dialogPresentation) return formView;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) props.onCancel(); }}>
      <DialogContent
        className="h-[min(800px,calc(100dvh-1rem))] w-[min(1120px,calc(100%-1rem))] max-w-none gap-0 rounded-3xl border border-dls-border bg-dls-sidebar p-2 shadow-2xl sm:max-w-[1120px]"
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
