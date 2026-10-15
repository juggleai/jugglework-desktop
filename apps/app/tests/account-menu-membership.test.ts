import { describe, expect, test } from "bun:test";
import type { DenOrgSummary, DenTenantAccount, DenTenantTier } from "../src/app/lib/den";
import { membershipUpgradeContext } from "../src/react-app/shell/account-menu-model";

function account(kind: "personal" | "organization", tier: DenTenantTier, canManageBilling = true, available = 0): DenTenantAccount {
  return {
    kind,
    tier,
    status: "active",
    tierVersion: 1,
    points: { available, reserved: 0, version: 1 },
    permissions: { canViewLedger: true, canManageBilling },
    billing: null,
  };
}

function organization(role: DenOrgSummary["role"]): DenOrgSummary {
  return { id: "org", name: "Org", slug: "org", role, kind: "organization", tier: "team" };
}

describe("account menu membership upgrade", () => {
  test("routes eligible Personal accounts only to Personal selection", () => {
    expect(membershipUpgradeContext(account("personal", "normal"), organization("member"))).toBe("personal");
    expect(membershipUpgradeContext(account("personal", "pro"), organization("member"))).toBe("personal");
    expect(membershipUpgradeContext(account("personal", "power"), organization("owner"))).toBeNull();
  });

  test("shows team selection only to an organization Owner", () => {
    expect(membershipUpgradeContext(account("organization", "lite_team"), organization("owner"))).toBe("team");
    expect(membershipUpgradeContext(account("organization", "team"), organization("owner"))).toBe("team");
    expect(membershipUpgradeContext(account("organization", "business"), organization("owner"))).toBe("team");
    expect(membershipUpgradeContext(account("organization", "team"), organization("admin"))).toBeNull();
    expect(membershipUpgradeContext(account("organization", "team"), organization("member"))).toBeNull();
    expect(membershipUpgradeContext(account("organization", "lite_team"), organization("admin"))).toBeNull();
  });

  test("never exposes upgrade without billing permission", () => {
    expect(membershipUpgradeContext(account("personal", "normal", false), organization("owner"))).toBeNull();
    expect(membershipUpgradeContext(account("organization", "team", false), organization("owner"))).toBeNull();
    expect(membershipUpgradeContext(account("organization", "lite_team", false), organization("owner"))).toBeNull();
  });

  test("keeps eligible upgrade entry visible after points reach zero or debt", () => {
    for (const available of [853, 1, 0, -1, -1280]) {
      expect(membershipUpgradeContext(account("personal", "normal", true, available), organization("member"))).toBe("personal");
      expect(membershipUpgradeContext(account("organization", "team", true, available), organization("owner"))).toBe("team");
    }
  });
});
