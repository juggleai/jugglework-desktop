/** @jsxImportSource react */
import * as React from "react";
import { Temporal } from "@js-temporal/polyfill";
import { CalendarDays, LoaderCircle } from "lucide-react";

import { denCalendarFromCollaborationResource, type DenCalendarEvent } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { calendarEventFormWithNextHalfHour, defaultCalendarEventForm } from "./calendar-event-form-model";
import { CalendarEventEditor } from "./calendar-event-editor";
import { browserCalendarOnlineSource, useCalendarOnline } from "./calendar-offline-runtime";
import { resolveCalendarPageGate } from "./calendar-page-gate";
import { useCalendarBootstrapQuery, useCalendarCollaborationQuery, useCalendarsQuery } from "./calendar-queries";
import { calendarScopeIdentity, type CalendarScope } from "./calendar-scope";

export type CalendarEventCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (event: DenCalendarEvent) => void;
  now?: () => Temporal.Instant;
  timeZone?: () => string;
};

export function CalendarEventCreateDialog(props: CalendarEventCreateDialogProps) {
  const cloud = useCloudSession();
  const gate = resolveCalendarPageGate(cloud);

  if (!props.open) return null;
  if (gate.kind !== "ready") {
    return (
      <CalendarCreateStatusDialog
        message={t("calendar.unavailable")}
        onClose={() => props.onOpenChange(false)}
      />
    );
  }

  return (
    <CalendarEventCreateDialogReady
      key={calendarScopeIdentity(gate.scope) ?? "calendar-create"}
      {...props}
      scope={gate.scope}
      supportsTeamCalendars={gate.workspaceKind === "organization"}
    />
  );
}

function CalendarEventCreateDialogReady(props: CalendarEventCreateDialogProps & {
  scope: CalendarScope;
  supportsTeamCalendars: boolean;
}) {
  const cloud = useCloudSession();
  const online = useCalendarOnline(browserCalendarOnlineSource);
  const timeZone = React.useMemo(() => props.timeZone?.() ?? Temporal.Now.timeZoneId(), [props.timeZone]);
  const now = React.useMemo(() => props.now?.() ?? Temporal.Now.instant(), [props.now]);
  const date = React.useMemo(() => now.toZonedDateTimeISO(timeZone).toPlainDate(), [now, timeZone]);
  const bootstrapQuery = useCalendarBootstrapQuery({
    client: cloud.client,
    scope: props.scope,
    range: { startDate: date.toString(), endDateExclusive: date.add({ days: 1 }).toString() },
    active: online,
  });
  const calendarsQuery = useCalendarsQuery({
    client: cloud.client,
    scope: props.scope,
    active: online && !props.supportsTeamCalendars,
  });
  const collaborationQuery = useCalendarCollaborationQuery({
    client: cloud.client,
    scope: props.supportsTeamCalendars ? props.scope : null,
    active: online,
  });

  const resources = props.supportsTeamCalendars ? collaborationQuery.data?.items ?? [] : [];
  const calendars = props.supportsTeamCalendars
    ? resources.map(denCalendarFromCollaborationResource)
    : calendarsQuery.data ?? [];
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  const writableCalendars = calendars.filter((calendar) => {
    if (!props.supportsTeamCalendars) return true;
    return resourcesById.get(calendar.id)?.capabilities.canEditEvents === true;
  });
  const authoritativeDefaultCalendarId = bootstrapQuery.data?.calendars.find((calendar) => calendar.isDefault)?.id;
  const defaultCalendarId = writableCalendars.find((calendar) => calendar.id === authoritativeDefaultCalendarId)?.id
    ?? writableCalendars.find((calendar) => calendar.isDefault)?.id
    ?? writableCalendars[0]?.id
    ?? "";
  const teamCalendarIds = React.useMemo(
    () => new Set(resources.filter((resource) => resource.kind === "team").map((resource) => resource.id)),
    [resources],
  );
  const currentUserDisplayName = cloud.user?.name?.trim() || cloud.user?.account?.trim() || "";
  const editorCalendars = writableCalendars.map((calendar) =>
    calendar.id === authoritativeDefaultCalendarId && currentUserDisplayName
      ? { ...calendar, name: currentUserDisplayName }
      : calendar,
  );
  const loading = bootstrapQuery.isLoading || (props.supportsTeamCalendars ? collaborationQuery.isLoading : calendarsQuery.isLoading);
  const failed = bootstrapQuery.isError || (props.supportsTeamCalendars ? collaborationQuery.isError : calendarsQuery.isError);

  if (!online && !defaultCalendarId) {
    return <CalendarCreateStatusDialog message={t("calendar.offline_form_unavailable")} onClose={() => props.onOpenChange(false)} />;
  }
  if (loading) {
    return <CalendarCreateStatusDialog loading message={t("calendar.loading")} onClose={() => props.onOpenChange(false)} />;
  }
  if (failed || !defaultCalendarId) {
    return (
      <CalendarCreateStatusDialog
        message={failed ? t("calendar.events_unavailable") : t("calendar.no_calendars")}
        onClose={() => props.onOpenChange(false)}
      />
    );
  }

  const initial = calendarEventFormWithNextHalfHour(defaultCalendarEventForm({
    date,
    calendarId: defaultCalendarId,
    timeZone,
    creatorMemberId: teamCalendarIds.has(defaultCalendarId) ? undefined : props.scope.memberId,
  }), now, timeZone);

  return (
    <CalendarEventEditor
      presentation="dialog"
      client={cloud.client}
      scope={props.scope}
      calendars={editorCalendars}
      teamCalendarIds={teamCalendarIds}
      timeZone={timeZone}
      now={() => now}
      initial={initial}
      online={online}
      onSaved={(event) => {
        props.onSaved?.(event);
        props.onOpenChange(false);
      }}
      onDeleted={() => props.onOpenChange(false)}
      onCancel={() => props.onOpenChange(false)}
    />
  );
}

function CalendarCreateStatusDialog(props: { loading?: boolean; message: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="w-[min(26rem,calc(100%-2rem))] rounded-xl border border-dls-border bg-dls-surface" aria-label={t("calendar.create_event")} data-testid="calendar-create-status-dialog">
        <DialogHeader>
          <DialogTitle>{t("calendar.create_event")}</DialogTitle>
          <DialogDescription className="flex items-center gap-2 pt-2 text-dls-secondary">
            {props.loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <CalendarDays className="size-4" aria-hidden="true" />}
            {props.message}
          </DialogDescription>
        </DialogHeader>
        {!props.loading ? <Button type="button" variant="outline" className="ml-auto" onClick={props.onClose}>{t("calendar.cancel")}</Button> : null}
      </DialogContent>
    </Dialog>
  );
}
