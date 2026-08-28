import { describe, expect, test } from "bun:test";

import { setLocale } from "../src/i18n";
import { accountDisplayName, membershipTierLabel, organizationMenuGroups } from "../src/react-app/shell/account-menu-model";

describe("account menu presentation", () => {
  test("maps tenant tiers to product labels", () => {
    setLocale("en");
    expect(membershipTierLabel("normal")).toBe("Normal");
    expect(membershipTierLabel("pro")).toBe("Pro");
    expect(membershipTierLabel("power")).toBe("Power");
    expect(membershipTierLabel("team")).toBe("Team");
    expect(membershipTierLabel("business")).toBe("Business");
  });

  test("calls a normal membership 普通用户 in Chinese", () => {
    setLocale("zh");
    expect(membershipTierLabel("normal")).toBe("普通用户");
    setLocale("en");
  });

  test("prefers nickname, then account, then email", () => {
    expect(accountDisplayName({ name: "  Taylor  ", account: "tay", email: "t@example.com" })).toBe("Taylor");
    expect(accountDisplayName({ name: null, account: "tay", email: "t@example.com" })).toBe("tay");
    expect(accountDisplayName({ name: null, account: null, email: "t@example.com" })).toBe("t@example.com");
  });

  test("separates Personal from joined organizations", () => {
    const personal = { id: "personal", name: "Personal", slug: "personal", role: "owner" as const, tier: "normal" as const };
    const team = { id: "team", name: "Studio", slug: "studio", role: "member" as const, kind: "organization" as const, tier: "team" as const };
    expect(organizationMenuGroups([team, personal])).toEqual({ personal: [personal], others: [team] });
  });
});
