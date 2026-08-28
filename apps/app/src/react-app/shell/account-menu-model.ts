import type { DenOrgSummary, DenTenantTier } from "@/app/lib/den";
import { t } from "@/i18n";

export function membershipTierLabel(tier: DenTenantTier | null | undefined): string {
  switch (tier) {
    case "normal": return t("account_menu.tier_normal");
    case "pro": return t("account_menu.tier_pro");
    case "power": return t("account_menu.tier_power");
    case "team": return t("account_menu.tier_team");
    case "business": return t("account_menu.tier_business");
    default: return t("account_menu.membership_unknown");
  }
}

export function accountDisplayName(user: { name?: string | null; account?: string | null; email?: string | null } | null): string {
  return user?.name?.trim() || user?.account?.trim() || user?.email?.trim() || t("account_menu.signed_out");
}

export function organizationMenuGroups(organizations: DenOrgSummary[]): {
  personal: DenOrgSummary[];
  others: DenOrgSummary[];
} {
  const personal: DenOrgSummary[] = [];
  const others: DenOrgSummary[] = [];
  for (const organization of organizations) {
    if (organization.kind === "personal" || organization.slug.toLowerCase() === "personal") {
      personal.push(organization);
    } else {
      others.push(organization);
    }
  }
  return { personal, others };
}
