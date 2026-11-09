/** @jsxImportSource react */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Trash2 } from "lucide-react";

import type { DenCalendar, DenCalendarEvent } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { CalendarScope } from "./calendar-scope";
import {
  calendarMutationConflict,
  useCreateCalendarEventMutation,
  useDeleteCalendarEventMutation,
  useUpdateCalendarEventMutation,
  type CalendarMutationClient,
} from "./calendar-mutations";
import { setCanonicalCalendarEvent } from "./calendar-queries";
import {
  calendarEventToForm,
  calendarEventUpdatePatch,
  classifyCalendarSaveFailure,
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
  | { kind: "conflict"; current: DenCalendarEvent | null; operation: "save" | "delete" };

export type CalendarEventEditorProps = {
  client: CalendarMutationClient;
  scope: CalendarScope;
  calendars: readonly DenCalendar[];
  timeZone: string;
  /** Existing event for edit mode; omitted for create. */
  event?: DenCalendarEvent;
  initial: CalendarEventFormValues;
  onSaved: (event: DenCalendarEvent) => void;
  onDeleted: (eventId: string) => void;
  onCancel: () => void;
};

const inputClass = "h-8 w-full min-w-0 rounded-lg border border-dls-border bg-dls-surface px-2 text-sm text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35 aria-[invalid=true]:border-red-500";

export function CalendarEventEditor(props: CalendarEventEditorProps) {
  const queryClient = useQueryClient();
  const createMutation = useCreateCalendarEventMutation(props.client, props.scope);
  const updateMutation = useUpdateCalendarEventMutation(props.client, props.scope);
  const deleteMutation = useDeleteCalendarEventMutation(props.client, props.scope);
  const [form, setForm] = React.useState(props.initial);
  const [status, setStatus] = React.useState<EditorStatus>({ kind: "editing" });
  // The version the form was based on; moves forward only when the user explicitly resolves a conflict.
  const [base, setBase] = React.useState<DenCalendarEvent | undefined>(props.event);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const lastSubmitted = React.useRef<string | null>(null);
  const formId = React.useId();
  const isEdit = Boolean(props.event);
  const pending = status.kind === "pending";
  const errors = status.kind === "validation" ? status.errors : {};
  const activeIds = props.calendars.map((calendar) => calendar.id);

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
      if (current && "calendarId" in current) setCanonicalCalendarEvent(queryClient, props.scope, current);
      setStatus({ kind: "conflict", current, operation });
      return;
    }
    setStatus({ kind: "failed", failure });
  };

  const submit = async () => {
    if (pending) return;
    const validation = validateCalendarEventForm(form, activeIds);
    if (!validation.ok) {
      setStatus({ kind: "validation", errors: validation.errors });
      return;
    }
    const fingerprint = JSON.stringify(validation.values);
    setStatus({ kind: "pending" });
    try {
      // An uncertain failure with unchanged input replays the same idempotency key instead of creating a duplicate.
      const mutation = base ? updateMutation : createMutation;
      const replay = mutation.canRetryLast && lastSubmitted.current === fingerprint;
      lastSubmitted.current = fingerprint;
      let result: { event: DenCalendarEvent };
      if (replay) {
        result = await (mutation.retryLastAsync as () => Promise<{ event: DenCalendarEvent }>)();
      } else if (base) {
        const patch = calendarEventUpdatePatch(base, validation.values);
        if (Object.keys(patch).length === 0) {
          props.onSaved(base);
          return;
        }
        result = await updateMutation.mutateAsync({ eventId: base.id, expectedVersion: base.version, patch });
      } else {
        result = await createMutation.mutateAsync(validation.values);
      }
      props.onSaved(result.event);
    } catch (error) {
      fail(error, "save");
    }
  };

  const remove = async () => {
    if (!base || pending) return;
    setStatus({ kind: "pending" });
    try {
      await deleteMutation.mutateAsync({ eventId: base.id, expectedVersion: base.version });
      props.onDeleted(base.id);
    } catch (error) {
      fail(error, "delete");
    }
  };

  const useLatest = () => {
    if (status.kind !== "conflict" || !status.current) return;
    setBase(status.current);
    setForm(calendarEventToForm(status.current));
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

  return (
    <form
      aria-labelledby={`${formId}-title`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-dls-border p-3"
      data-testid="calendar-event-form"
      data-status={status.kind}
      noValidate
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <h3 id={`${formId}-title`} className="text-sm font-semibold text-dls-text">
        {isEdit ? t("calendar.edit_event") : t("calendar.create_event")}
      </h3>
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-dls-secondary">
          {t("calendar.field_title")}
          <input
            className={inputClass}
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
            className={inputClass}
            value={form.calendarId}
            aria-invalid={errors.calendarId ? true : undefined}
            aria-describedby={describedBy("calendarId")}
            onChange={(event) => update({ calendarId: event.target.value })}
            data-testid="calendar-form-calendar"
          >
            {props.calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
          </select>
          {fieldError("calendarId")}
        </label>
        <label className="flex items-center gap-2 text-sm text-dls-text">
          <input
            type="checkbox"
            checked={time.kind === "allDay"}
            onChange={(event) => setForm((current) => switchCalendarFormTimeKind(current, event.target.checked ? "allDay" : "timed", props.timeZone))}
            data-testid="calendar-form-all-day"
          />
          {t("calendar.all_day")}
        </label>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("calendar.detail_time")} aria-describedby={describedBy("time")}>
          {time.kind === "allDay" ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_start_date")}
                <input type="date" className={inputClass} value={time.startDate} onChange={(event) => updateTime({ startDate: event.target.value })} data-testid="calendar-form-start-date" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_end_date_exclusive")}
                <input type="date" className={inputClass} value={time.endDateExclusive} onChange={(event) => updateTime({ endDateExclusive: event.target.value })} data-testid="calendar-form-end-date" />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_start_date")}
                <input type="date" className={inputClass} value={time.startDate} onChange={(event) => updateTime({ startDate: event.target.value })} data-testid="calendar-form-start-date" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_start_time")}
                <input type="time" className={inputClass} value={time.startTime.slice(0, 5)} onChange={(event) => updateTime({ startTime: event.target.value })} data-testid="calendar-form-start-time" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_end_date")}
                <input type="date" className={inputClass} value={time.endDate} onChange={(event) => updateTime({ endDate: event.target.value })} data-testid="calendar-form-end-date" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-dls-secondary">
                {t("calendar.field_end_time")}
                <input type="time" className={inputClass} value={time.endTime.slice(0, 5)} onChange={(event) => updateTime({ endTime: event.target.value })} data-testid="calendar-form-end-time" />
              </label>
              <p className="col-span-2 text-xs text-dls-secondary" data-testid="calendar-form-zone">{t("calendar.detail_time_zone")}: {time.timeZone}</p>
            </>
          )}
        </div>
        {fieldError("time")}
        <label className="flex flex-col gap-1 text-xs text-dls-secondary">
          {t("calendar.field_description")}
          <textarea
            className={`${inputClass} h-20 py-1`}
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
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => void remove()} data-testid="calendar-form-delete-confirm-button">{t("calendar.delete_event")}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)} data-testid="calendar-form-delete-cancel">{t("calendar.cancel")}</Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || (status.kind === "conflict")} data-testid="calendar-form-save">
          {status.kind === "failed" && status.failure.kind === "network" ? t("calendar.retry_save") : t("calendar.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={props.onCancel} data-testid="calendar-form-cancel">{t("calendar.cancel")}</Button>
        {base ? (
          <Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={pending} onClick={() => setConfirmingDelete(true)} aria-label={t("calendar.delete_event")} data-testid="calendar-form-delete">
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </form>
  );
}
