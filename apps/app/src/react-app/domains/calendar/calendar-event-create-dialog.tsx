/** @jsxImportSource react */
import * as React from "react";
import { Temporal } from "@js-temporal/polyfill";
import { CalendarDays, LoaderCircle } from "lucide-react";

import { denCalendarFromCollaborationResource, type DenCalendarEvent } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { calendarEventFormWithNextHalfHour, defaultCalendarEventForm } from "./calendar-event-form-model";
import { CalendarEventEditor } from "./calendar-event-editor";
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
  const desktopConfig = useDesktopConfig();
  const gate = resolveCalendarPageGate({
    isSignedIn: cloud.isSignedIn,
    baseUrl: cloud.baseUrl,
    organizationId: cloud.activeOrganization?.id,
    memberId: cloud.activeOrganization?.orgMemberId || cloud.activeOrganization?.membershipId,
    configLoading: desktopConfig.loading,
    calendarEnabled: desktopConfig.config.calendarEnabled,
    calendarWriteEnabled: desktopConfig.config.calendarWriteEnabled,
  });

  if (!props.open) return null;
  if (gate.kind !== "ready" || !gate.writeEnabled) {
    return (
      <CalendarCreateStatusDialog
        loading={gate.kind === "loading-capability"}
        message={gate.kind === "loading-capability" ? t("calendar.loading") : t("calendar.unavailable")}
        onClose={() => props.onOpenChange(false)}
      />
    );
  }

  return (
    <CalendarEventCreateDialogReady
      key={calendarScopeIdentity(gate.scope) ?? "calendar-create"}
      {...props}
      scope={gate.scope}
      collaborationEnabled={desktopConfig.config.calendarCollaborationEnabled === true}
    />
  );
}

function CalendarEventCreateDialogReady(props: CalendarEventCreateDialogProps & {
  scope: CalendarScope;
  collaborationEnabled: boolean;
}) {
  const cloud = useCloudSession();
  const timeZone = React.useMemo(() => props.timeZone?.() ?? Temporal.Now.timeZoneId(), [props.timeZone]);
  const now = React.useMemo(() => props.now?.() ?? Temporal.Now.instant(), [props.now]);
  const date = React.useMemo(() => now.toZonedDateTimeISO(timeZone).toPlainDate(), [now, timeZone]);
  const bootstrapQuery = useCalendarBootstrapQuery({
    client: cloud.client,
    scope: props.scope,
    range: { startDate: date.toString(), endDateExclusive: date.add({ days: 1 }).toString() },
  });
  const calendarsQuery = useCalendarsQuery({
    client: cloud.client,
    scope: props.scope,
    active: !props.collaborationEnabled,
  });
  const collaborationQuery = useCalendarCollaborationQuery({
    client: cloud.client,
    scope: props.scope,
    active: props.collaborationEnabled,
  });

  const resources = props.collaborationEnabled ? collaborationQuery.data?.items ?? [] : [];
  const calendars = props.collaborationEnabled
    ? resources.map(denCalendarFromCollaborationResource)
    : calendarsQuery.data ?? [];
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  const writableCalendars = calendars.filter((calendar) => {
    if (!props.collaborationEnabled) return true;
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
  const loading = bootstrapQuery.isLoading || (props.collaborationEnabled ? collaborationQuery.isLoading : calendarsQuery.isLoading);
  const failed = bootstrapQuery.isError || (props.collaborationEnabled ? collaborationQuery.isError : calendarsQuery.isError);

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
      writeEnabled
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
