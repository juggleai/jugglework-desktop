/** @jsxImportSource react */
import * as React from "react";
import { LoaderCircle, UserMinus } from "lucide-react";

import { DenApiError, type DenCalendarCollaborationResource, type DenCalendarCollaborationRole, type DenOrganizationMember, type DenClient } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useTeamCalendarMembershipMutations } from "./calendar-mutations";
import { useCalendarOrganizationMembersQuery, useTeamCalendarMembershipsQuery } from "./calendar-queries";
import type { CalendarScope } from "./calendar-scope";

const roles: DenCalendarCollaborationRole[] = ["free-busy", "viewer", "editor", "manager"];

function memberName(member: DenOrganizationMember | undefined, memberId: string): string {
  return member?.user.name?.trim() || member?.user.account?.trim() || member?.user.email?.trim() || memberId;
}

function mutationError(error: unknown): string {
  if (error instanceof DenApiError && error.code === "calendar_last_manager") return t("calendar.members_last_manager_error");
  if (error instanceof DenApiError && error.code === "calendar_authorization_version_conflict") return t("calendar.members_version_error");
  if (error instanceof DenApiError && error.code === "calendar_member_invalid") return t("calendar.members_invalid_member_error");
  return t("calendar.members_change_failed");
}

function isAuthorizationConflict(error: unknown): boolean {
  return error instanceof DenApiError && error.code === "calendar_authorization_version_conflict";
}

export function CalendarMembersDialog(props: {
  open: boolean;
  calendar: DenCalendarCollaborationResource;
  client: DenClient;
  scope: CalendarScope;
  onOpenChange: (open: boolean) => void;
}) {
  const memberships = useTeamCalendarMembershipsQuery({ client: props.client, scope: props.scope, calendarId: props.calendar.id, active: props.open });
  const directory = useCalendarOrganizationMembersQuery({ client: props.client, scope: props.scope, active: props.open });
  const mutations = useTeamCalendarMembershipMutations(props.client, props.scope, props.calendar.id);
  const [memberId, setMemberId] = React.useState("");
  const [role, setRole] = React.useState<DenCalendarCollaborationRole>("viewer");
  const [error, setError] = React.useState<string | null>(null);
  const pending = mutations.put.isPending || mutations.revoke.isPending;
  const directoryById = new Map((directory.data ?? []).map((member) => [member.id, member]));
  const existingIds = new Set((memberships.data?.items ?? []).map((membership) => membership.memberId));
  const available = (directory.data ?? []).filter((member) => !existingIds.has(member.id));
  const selectedMemberId = available.some((member) => member.id === memberId) ? memberId : available[0]?.id ?? "";
  const authorizationVersion = memberships.data?.authorizationVersion;

  const put = async (targetMemberId: string, nextRole: DenCalendarCollaborationRole) => {
    if (!authorizationVersion || pending) return;
    setError(null);
    try {
      await mutations.put.mutateAsync({ memberId: targetMemberId, role: nextRole, expectedAuthorizationVersion: authorizationVersion });
      if (!existingIds.has(targetMemberId)) setMemberId("");
    } catch (nextError) {
      if (isAuthorizationConflict(nextError)) await Promise.all([memberships.refetch(), directory.refetch()]);
      setError(mutationError(nextError));
    }
  };
  const revoke = async (targetMemberId: string) => {
    if (!authorizationVersion || pending) return;
    setError(null);
    try {
      await mutations.revoke.mutateAsync({ memberId: targetMemberId, expectedAuthorizationVersion: authorizationVersion });
    } catch (nextError) {
      if (isAuthorizationConflict(nextError)) await Promise.all([memberships.refetch(), directory.refetch()]);
      setError(mutationError(nextError));
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!pending) props.onOpenChange(open); }}>
      <DialogContent className="max-h-[min(42rem,calc(100vh-2rem))] max-w-2xl overflow-y-auto sm:max-w-2xl" aria-label={t("calendar.manage_members_label", { name: props.calendar.name })} showCloseButton={!pending} data-testid="calendar-members-dialog">
        <DialogHeader>
          <DialogTitle>{t("calendar.manage_members")}</DialogTitle>
          <DialogDescription>{t("calendar.manage_members_description", { name: props.calendar.name })}</DialogDescription>
        </DialogHeader>

        <section aria-label={t("calendar.role_capabilities")} className="grid gap-2 sm:grid-cols-2">
          {roles.map((item) => <div key={item} className="rounded-xl border border-dls-border bg-dls-surface px-3 py-2"><p className="text-sm font-medium text-dls-text">{t(`calendar.role_${item.replace("-", "_")}`)}</p><p className="mt-0.5 text-xs leading-5 text-dls-secondary">{t(`calendar.role_${item.replace("-", "_")}_description`)}</p></div>)}
        </section>

        {memberships.isLoading || directory.isLoading ? <p role="status" className="flex items-center gap-2 text-sm text-dls-secondary"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{t("calendar.members_loading")}</p> : null}
        {memberships.isError || directory.isError ? <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-red-3 px-3 py-2 text-sm text-red-11"><span>{t("calendar.members_load_failed")}</span><Button type="button" variant="outline" size="sm" onClick={() => { void memberships.refetch(); void directory.refetch(); }}>{t("calendar.members_retry")}</Button></div> : null}

        {memberships.data && directory.data ? (
          <div className="grid gap-5">
            <section aria-label={t("calendar.current_members")}>
              <h3 className="mb-2 text-sm font-medium text-dls-text">{t("calendar.current_members")}</h3>
              <ul className="grid gap-2" data-testid="calendar-members-list">
                {memberships.data.items.map((membership) => {
                  const name = memberName(directoryById.get(membership.memberId), membership.memberId);
                  return <li key={membership.memberId} className="flex flex-wrap items-center gap-2 rounded-xl border border-dls-border px-3 py-2"><span className="min-w-40 flex-1 truncate text-sm text-dls-text">{name}</span><select value={membership.role} disabled={pending} aria-label={t("calendar.member_role_label", { name })} data-testid={`calendar-member-role-${membership.memberId}`} className="h-9 rounded-lg border border-dls-border bg-dls-surface px-2 text-sm" onChange={(event) => { void put(membership.memberId, event.target.value as DenCalendarCollaborationRole); }}>{roles.map((item) => <option key={item} value={item}>{t(`calendar.role_${item.replace("-", "_")}`)}</option>)}</select><Button type="button" variant="ghost" size="icon-sm" disabled={pending} aria-label={t("calendar.remove_member_label", { name })} data-testid={`calendar-remove-member-${membership.memberId}`} onClick={() => { void revoke(membership.memberId); }}><UserMinus className="size-4" aria-hidden="true" /></Button></li>;
                })}
              </ul>
            </section>

            <section aria-label={t("calendar.add_member")} className="rounded-xl border border-dls-border bg-dls-surface p-3">
              <h3 className="mb-2 text-sm font-medium text-dls-text">{t("calendar.add_member")}</h3>
              {available.length ? <div className="flex flex-wrap items-end gap-2"><label className="grid min-w-48 flex-1 gap-1 text-xs text-dls-secondary">{t("calendar.organization_member")}<select value={selectedMemberId} disabled={pending} aria-label={t("calendar.organization_member")} data-testid="calendar-add-member-select" className="h-9 rounded-lg border border-dls-border bg-dls-surface px-2 text-sm text-dls-text" onChange={(event) => setMemberId(event.target.value)}>{available.map((member) => <option key={member.id} value={member.id}>{memberName(member, member.id)}</option>)}</select></label><label className="grid gap-1 text-xs text-dls-secondary">{t("calendar.member_role")}<select value={role} disabled={pending} aria-label={t("calendar.member_role")} data-testid="calendar-add-member-role" className="h-9 rounded-lg border border-dls-border bg-dls-surface px-2 text-sm text-dls-text" onChange={(event) => setRole(event.target.value as DenCalendarCollaborationRole)}>{roles.map((item) => <option key={item} value={item}>{t(`calendar.role_${item.replace("-", "_")}`)}</option>)}</select></label><Button type="button" disabled={pending || !selectedMemberId} data-testid="calendar-add-member-submit" onClick={() => { void put(selectedMemberId, role); }}>{pending ? t("calendar.members_saving") : t("calendar.add_member")}</Button></div> : <p className="text-sm text-dls-secondary" data-testid="calendar-no-available-members">{t("calendar.no_available_members")}</p>}
            </section>
          </div>
        ) : null}

        {error ? <p role="alert" className="rounded-xl bg-red-3 px-3 py-2 text-sm text-red-11" data-testid="calendar-members-error">{error}</p> : null}
        <DialogFooter><Button type="button" variant="outline" disabled={pending} data-testid="calendar-members-close" onClick={() => props.onOpenChange(false)}>{t("calendar.members_close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
