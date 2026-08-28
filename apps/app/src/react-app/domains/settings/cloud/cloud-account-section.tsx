/** @jsxImportSource react */
import { Building2, Check, Loader2 } from "lucide-react";

import type { DenOrgSummary } from "../../../../app/lib/den";
import { SettingsNotice } from "../settings-section";
import { t } from "@/i18n";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { useCloudSession } from "./cloud-session-provider";

export interface CloudAccountSectionProps {
  orgsBusy: boolean;
  orgsError: string | null;
}

export function CloudAccountSection({
  orgsBusy,
  orgsError,
}: CloudAccountSectionProps) {
  const { user } = useCloudSession();
  const { activeOrganization } = useDenAuth();

  return (
    <section className="flex flex-col gap-y-6">
      {/* User identity */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-dls-hover text-sm font-semibold text-dls-text">
            {(user?.name ?? user?.email ?? "?").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-dls-text">
              {user?.name || user?.email}
            </div>
            {user?.name && user.email ? (
              <div className="truncate text-xs text-dls-secondary">{user.email}</div>
            ) : null}
          </div>
        </div>
      </div>

      {activeOrganization ? (
        <ConnectedOrganization org={activeOrganization} />
      ) : orgsBusy ? (
        <div className="flex items-center gap-2 text-sm text-dls-secondary">
          <Loader2 size={14} className="animate-spin" />
          {t("cloud_account.loading_orgs")}
        </div>
      ) : null}

      {orgsError ? <SettingsNotice tone="error">{orgsError}</SettingsNotice> : null}
    </section>
  );
}

// Owner and admin share every administrative capability, so an admin must not
// be labelled as a plain member.
function orgRoleLabel(role: DenOrgSummary["role"]): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    default:
      return "Member";
  }
}

export function ConnectedOrganization({
  org,
}: {
  org: Pick<DenOrgSummary, "id" | "name" | "role" | "slug">;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-green-7 bg-dls-surface px-4 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-green-3 text-green-11">
        <Building2 size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-dls-text">{org.name}</div>
        <div className="text-xs text-dls-secondary">{orgRoleLabel(org.role)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-green-11">
        {t("dashboard.connected")}
        <Check size={16} />
      </div>
    </div>
  );
}
