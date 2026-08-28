import { describe, expect, test } from "bun:test";

import {
  annualMonthlyEquivalent,
  defaultUpgradeTier,
  isMembershipTierSelectable,
  membershipAudienceForTier,
  membershipPlans,
  membershipTotal,
} from "../src/react-app/shell/membership-upgrade-model";

describe("membership upgrade plans", () => {
  test("groups the three personal and two team tiers", () => {
    const plans = membershipPlans("zh");
    expect(plans.filter((plan) => plan.audience === "personal").map((plan) => plan.id)).toEqual(["normal", "pro", "power"]);
    expect(plans.filter((plan) => plan.audience === "team").map((plan) => plan.id)).toEqual(["team", "business"]);
    expect(membershipAudienceForTier("business")).toBe("team");
    expect(membershipAudienceForTier("power")).toBe("personal");
  });

  test("selects the next higher tier by default and keeps the top tier selected", () => {
    expect(defaultUpgradeTier("normal")).toBe("pro");
    expect(defaultUpgradeTier("pro")).toBe("power");
    expect(defaultUpgradeTier("power")).toBe("power");
    expect(defaultUpgradeTier("team")).toBe("business");
    expect(defaultUpgradeTier("business")).toBe("business");
    expect(defaultUpgradeTier(null)).toBe("pro");
  });

  test("allows only the current or a higher membership tier", () => {
    expect(isMembershipTierSelectable("normal", "pro")).toBe(true);
    expect(isMembershipTierSelectable("pro", "pro")).toBe(true);
    expect(isMembershipTierSelectable("pro", "normal")).toBe(false);
    expect(isMembershipTierSelectable("power", "team")).toBe(true);
    expect(isMembershipTierSelectable("team", "power")).toBe(false);
    expect(isMembershipTierSelectable("business", "team")).toBe(false);
    expect(isMembershipTierSelectable(null, "normal")).toBe(true);
  });

  test("keeps the requested monthly and annual prices", () => {
    const byId = Object.fromEntries(membershipPlans("zh").map((plan) => [plan.id, plan]));
    expect([byId.normal.monthlyPrice, byId.normal.annualPrice]).toEqual([0, 0]);
    expect([byId.pro.monthlyPrice, byId.pro.annualPrice]).toEqual([99, 948]);
    expect([byId.power.monthlyPrice, byId.power.annualPrice]).toEqual([199, 1908]);
    expect([byId.team.monthlyPrice, byId.team.annualPrice]).toEqual([169, 1668]);
    expect([byId.business.monthlyPrice, byId.business.annualPrice]).toEqual([299, 2988]);
    expect(annualMonthlyEquivalent(byId.normal)).toBe(0);
    expect(annualMonthlyEquivalent(byId.pro)).toBe(79);
    expect(annualMonthlyEquivalent(byId.power)).toBe(159);
    expect(annualMonthlyEquivalent(byId.team)).toBe(139);
    expect(annualMonthlyEquivalent(byId.business)).toBe(249);
  });

  test("calculates team totals from the minimum seat count", () => {
    const team = membershipPlans("zh").find((plan) => plan.id === "team");
    const business = membershipPlans("zh").find((plan) => plan.id === "business");
    expect(team).toBeDefined();
    expect(business).toBeDefined();
    expect(membershipTotal(team!, "monthly", 1)).toBe(507);
    expect(membershipTotal(team!, "annual", 4)).toBe(6672);
    expect(membershipTotal(business!, "monthly", 2)).toBe(2990);
  });

  test("includes every requested benefit", () => {
    const byId = Object.fromEntries(membershipPlans("zh").map((plan) => [plan.id, plan]));
    expect(byId.normal.features).toHaveLength(3);
    expect(byId.pro.features).toHaveLength(5);
    expect(byId.power.features).toHaveLength(5);
    expect(byId.team.features).toHaveLength(8);
    expect(byId.business.features).toHaveLength(9);
    expect(byId.business.features).toContain("企业 SSO / SCIM");
  });
});
