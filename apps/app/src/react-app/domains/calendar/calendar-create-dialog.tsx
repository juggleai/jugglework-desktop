/** @jsxImportSource react */
import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import type { DenClient } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useCreateCalendarMutation, useCreateTeamCalendarMutation } from "./calendar-mutations";
import { calendarQueryKeys } from "./calendar-query-keys";
import type { CalendarScope } from "./calendar-scope";

export function CalendarCreateDialog(props: {
  open: boolean;
  client: DenClient;
  scope: CalendarScope;
  collaborationEnabled: boolean;
  online: boolean;
  writeEnabled: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const personal = useCreateCalendarMutation(props.client, props.scope);
  const team = useCreateTeamCalendarMutation(props.client, props.scope);
  const [kind, setKind] = React.useState<"personal" | "team">("personal");
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const pending = personal.isPending || team.isPending;

  React.useEffect(() => {
    if (!props.open) return;
    setKind("personal");
    setName("");
    setColor("");
    setError(null);
  }, [props.open]);

  const submit = async () => {
    if (!props.writeEnabled) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("calendar.calendar_name_required"));
      return;
    }
    setError(null);
    const input = { name: trimmed, ...(color ? { color } : {}) };
    try {
      if (kind === "team") await team.mutateAsync(input);
      else {
        await personal.mutateAsync(input);
        if (props.collaborationEnabled) await queryClient.invalidateQueries({ queryKey: calendarQueryKeys.collaboration(props.scope) });
      }
      props.onOpenChange(false);
    } catch {
      setError(t("calendar.create_calendar_failed"));
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!pending) props.onOpenChange(open); }}>
      <DialogContent data-testid="calendar-create-dialog" aria-label={t("calendar.create_calendar")}>
        <DialogHeader>
          <DialogTitle>{t("calendar.create_calendar")}</DialogTitle>
          <DialogDescription>{t("calendar.create_calendar_description")}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }} data-testid="calendar-create-form">
          <fieldset className="flex flex-col gap-2" disabled={pending || !props.online || !props.writeEnabled}>
            <legend className="mb-1 text-xs font-medium text-dls-secondary">{t("calendar.calendar_type")}</legend>
            <label className="flex items-center gap-2 text-sm text-dls-text">
              <input type="radio" name="calendar-kind" value="personal" checked={kind === "personal"} onChange={() => setKind("personal")} data-testid="calendar-create-personal" />
              {t("calendar.personal_calendar")}
            </label>
            {props.collaborationEnabled ? (
              <label className="flex items-center gap-2 text-sm text-dls-text">
                <input type="radio" name="calendar-kind" value="team" checked={kind === "team"} onChange={() => setKind("team")} data-testid="calendar-create-team" />
                {t("calendar.team_calendar")}
              </label>
            ) : null}
            <label className="mt-2 flex flex-col gap-1 text-xs text-dls-secondary">
              {t("calendar.calendar_name")}
              <input autoFocus className="h-9 rounded-lg border border-dls-border bg-dls-surface px-2 text-sm text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={error ? true : undefined} data-testid="calendar-create-name" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-dls-secondary">
              {t("calendar.calendar_color")}
              <input type="color" className="h-9 w-full rounded-lg border border-dls-border bg-dls-surface p-1" value={color || "#2563eb"} onChange={(event) => setColor(event.target.value)} data-testid="calendar-create-color" />
            </label>
          </fieldset>
          {error ? <p className="text-sm text-red-600" role="alert" data-testid="calendar-create-error">{error}</p> : null}
          {!props.online ? <p className="text-sm text-dls-secondary" role="note">{t("calendar.offline_create_calendar")}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => props.onOpenChange(false)}>{t("calendar.cancel")}</Button>
            <Button type="submit" disabled={pending || !props.online || !props.writeEnabled} data-testid="calendar-create-submit">
              {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
              {pending ? t("calendar.creating") : t("calendar.create_calendar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
