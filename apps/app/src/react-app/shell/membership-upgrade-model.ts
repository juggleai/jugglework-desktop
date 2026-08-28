import type { DenTenantTier } from "@/app/lib/den";

export type MembershipAudience = "personal" | "team";
export type BillingPeriod = "monthly" | "annual";

export type MembershipPlan = {
  id: DenTenantTier;
  audience: MembershipAudience;
  name: string;
  edition: string;
  description: string;
  features: string[];
  monthlyPrice: number;
  annualPrice: number;
  minimumSeats: number;
  recommended?: boolean;
};

type PlanCopy = Omit<MembershipPlan, "id" | "audience" | "monthlyPrice" | "annualPrice" | "minimumSeats" | "recommended">;

const PLAN_COPY: Record<"zh" | "en", Record<DenTenantTier, PlanCopy>> = {
  zh: {
    normal: {
      name: "Community",
      edition: "普通版",
      description: "轻量体验 JuggleWork 的完整模型能力",
      features: ["每月赠送 1,000 积分", "全部模型可选", "BYOK 模式，可接入自有模型"],
    },
    pro: {
      name: "Pro",
      edition: "专业版",
      description: "适合高频使用模型与自动化的个人用户",
      features: [
        "每月 10,000 基础积分 + 10,000 赠送积分",
        "全部模型可选",
        "BYOK 模式，可接入自有模型",
        "基础技能 / MCP 服务",
        "单机自动化",
      ],
    },
    power: {
      name: "Power",
      edition: "加强版",
      description: "为重度工作流提供更多积分与完整扩展能力",
      features: [
        "每月 20,000 基础积分 + 25,000 赠送积分",
        "全部模型可选",
        "BYOK 模式，可接入自有模型",
        "全部技能 / MCP 服务",
        "单机自动化",
      ],
    },
    team: {
      name: "Team",
      edition: "团队基础版",
      description: "从 3 个席位开始建立团队协作空间",
      features: [
        "每席位 15,000 基础积分 + 10,000 赠送积分",
        "3 个席位起卖",
        "团队协作空间",
        "角色与权限控制",
        "模型用量统计和管控",
        "支持云端 Worker",
        "专属 IM 沟通",
        "专属技术咨询",
      ],
    },
    business: {
      name: "Business",
      edition: "团队商业版",
      description: "面向规模化团队的身份、安全与技术支持",
      features: [
        "每席位 30,000 基础积分 + 20,000 赠送积分",
        "10 个席位起卖",
        "团队协作空间",
        "角色与权限控制",
        "模型用量统计和管控",
        "支持云端 Worker",
        "专属 IM 沟通",
        "企业 SSO / SCIM",
        "专属技术咨询",
      ],
    },
  },
  en: {
    normal: {
      name: "Community",
      edition: "Community",
      description: "A lightweight way to use JuggleWork with every model",
      features: ["1,000 bonus points each month", "Access to every model", "BYOK with your own model providers"],
    },
    pro: {
      name: "Pro",
      edition: "Professional",
      description: "For individuals who use models and automations every day",
      features: [
        "10,000 base + 10,000 bonus points each month",
        "Access to every model",
        "BYOK with your own model providers",
        "Essential Skills and MCP services",
        "Local automations",
      ],
    },
    power: {
      name: "Power",
      edition: "Power",
      description: "More points and the complete extension catalog for heavy workflows",
      features: [
        "20,000 base + 25,000 bonus points each month",
        "Access to every model",
        "BYOK with your own model providers",
        "All Skills and MCP services",
        "Local automations",
      ],
    },
    team: {
      name: "Team",
      edition: "Team",
      description: "A shared workspace for teams starting at three seats",
      features: [
        "15,000 base + 10,000 bonus points per seat",
        "3-seat minimum",
        "Shared team workspace",
        "Roles and permission controls",
        "Model usage reporting and controls",
        "Cloud Worker support",
        "Dedicated IM channel",
        "Dedicated technical consulting",
      ],
    },
    business: {
      name: "Business",
      edition: "Business",
      description: "Identity, security, and support for organizations at scale",
      features: [
        "30,000 base + 20,000 bonus points per seat",
        "10-seat minimum",
        "Shared team workspace",
        "Roles and permission controls",
        "Model usage reporting and controls",
        "Cloud Worker support",
        "Dedicated IM channel",
        "Enterprise SSO / SCIM",
        "Dedicated technical consulting",
      ],
    },
  },
};

const PLAN_FACTS: Record<DenTenantTier, Pick<MembershipPlan, "audience" | "monthlyPrice" | "annualPrice" | "minimumSeats" | "recommended">> = {
  normal: { audience: "personal", monthlyPrice: 0, annualPrice: 0, minimumSeats: 1 },
  pro: { audience: "personal", monthlyPrice: 99, annualPrice: 948, minimumSeats: 1, recommended: true },
  power: { audience: "personal", monthlyPrice: 199, annualPrice: 1908, minimumSeats: 1 },
  team: { audience: "team", monthlyPrice: 169, annualPrice: 1668, minimumSeats: 3, recommended: true },
  business: { audience: "team", monthlyPrice: 299, annualPrice: 2988, minimumSeats: 10 },
};

export function membershipPlans(locale: string): MembershipPlan[] {
  const copy = PLAN_COPY[locale === "zh" ? "zh" : "en"];
  return (["normal", "pro", "power", "team", "business"] as const).map((id) => ({
    id,
    ...PLAN_FACTS[id],
    ...copy[id],
  }));
}

export function membershipAudienceForTier(tier: DenTenantTier | null | undefined): MembershipAudience {
  return tier === "team" || tier === "business" ? "team" : "personal";
}

export function defaultUpgradeTier(tier: DenTenantTier | null | undefined): DenTenantTier {
  switch (tier) {
    case "normal": return "pro";
    case "pro": return "power";
    case "team": return "business";
    case "power":
    case "business": return tier;
    default: return "pro";
  }
}

const MEMBERSHIP_TIER_RANK: Record<DenTenantTier, number> = {
  normal: 0,
  pro: 1,
  power: 2,
  team: 3,
  business: 4,
};

export function isMembershipTierSelectable(
  currentTier: DenTenantTier | null | undefined,
  targetTier: DenTenantTier,
): boolean {
  return currentTier == null || MEMBERSHIP_TIER_RANK[targetTier] >= MEMBERSHIP_TIER_RANK[currentTier];
}

export function membershipTotal(plan: MembershipPlan, period: BillingPeriod, seats: number): number {
  const unitPrice = period === "monthly" ? plan.monthlyPrice : plan.annualPrice;
  return unitPrice * Math.max(plan.minimumSeats, Math.floor(seats));
}

export function annualMonthlyEquivalent(plan: MembershipPlan): number {
  return Math.round(plan.annualPrice / 12);
}
