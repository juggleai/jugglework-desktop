/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Check, Minus, Plus, QrCode, Sparkles, Users } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DenTenantTier } from "@/app/lib/den";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";
import {
  annualMonthlyEquivalent,
  defaultUpgradeTier,
  isMembershipTierSelectable,
  membershipAudienceForTier,
  membershipPlans,
  membershipTotal,
  type BillingPeriod,
  type MembershipAudience,
} from "./membership-upgrade-model";

type MembershipUpgradeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTier?: DenTenantTier | null;
};

function Money({ amount, suffix }: { amount: number; suffix?: string }) {
  return (
    <span className="font-heading font-semibold tabular-nums tracking-[-0.03em]">
      <span className="mr-0.5 text-[0.58em] align-[0.24em]">¥</span>{amount.toLocaleString("zh-CN")}
      {suffix ? <span className="ml-1 text-[0.46em] font-medium tracking-normal text-muted-foreground">{suffix}</span> : null}
    </span>
  );
}

function PaymentCodePlaceholder({ free, zh }: { free: boolean; zh: boolean }) {
  return (
    <div
      className={cn(
        "relative flex size-40 shrink-0 items-center justify-center overflow-hidden rounded-[18px] border bg-background",
        free ? "border-dls-border" : "border-[rgba(var(--dls-accent-rgb),0.18)] shadow-[0_18px_44px_-34px_rgba(var(--dls-accent-rgb),0.65)]",
      )}
      data-testid="membership-payment-code"
      aria-label={zh ? "支付宝付款码" : "Alipay payment code"}
    >
      <div className="absolute inset-2.5 rounded-[13px] bg-[radial-gradient(circle_at_center,rgba(var(--dls-accent-rgb),0.09)_1px,transparent_1px)] [background-size:5px_5px]" />
      <div className="relative flex size-16 flex-col items-center justify-center rounded-[14px] border border-dls-border bg-background shadow-sm">
        {free ? <Check className="size-6 text-dls-accent" strokeWidth={2.1} /> : <QrCode className="size-6 text-dls-accent" strokeWidth={1.7} />}
        <span className="mt-1 text-[10px] font-semibold text-dls-text">{free ? (zh ? "免费" : "Free") : "Alipay"}</span>
      </div>
    </div>
  );
}

export function MembershipUpgradeDialog({ open, onOpenChange, currentTier }: MembershipUpgradeDialogProps) {
  const zh = currentLocale() === "zh";
  const plans = useMemo(() => membershipPlans(currentLocale()), [open]);
  const initialAudience = membershipAudienceForTier(currentTier);
  const [audience, setAudience] = useState<MembershipAudience>(initialAudience);
  const [selectedTier, setSelectedTier] = useState<DenTenantTier>(defaultUpgradeTier(currentTier));
  const [period, setPeriod] = useState<BillingPeriod>("annual");
  const selectedPlan = plans.find((plan) => plan.id === selectedTier) ?? plans[1];
  const [seats, setSeats] = useState(selectedPlan.minimumSeats);

  useEffect(() => {
    if (!open) return;
    const nextAudience = membershipAudienceForTier(currentTier);
    setAudience(nextAudience);
    setSelectedTier(defaultUpgradeTier(currentTier));
    setPeriod("annual");
  }, [currentTier, open]);

  useEffect(() => {
    setSeats(selectedPlan.minimumSeats);
  }, [selectedPlan.id, selectedPlan.minimumSeats]);

  const visiblePlans = plans.filter((plan) => plan.audience === audience);
  const unitPrice = period === "monthly" ? selectedPlan.monthlyPrice : selectedPlan.annualPrice;
  const total = membershipTotal(selectedPlan, period, seats);
  const isTeam = selectedPlan.audience === "team";
  const isFree = total === 0;
  const periodLabel = period === "monthly" ? (zh ? "按月购买" : "Monthly") : (zh ? "按年购买" : "Annual");
  const durationLabel = period === "monthly" ? (zh ? "1 个月" : "1 month") : (zh ? "1 年" : "1 year");
  const unitPriceLabel = isTeam
    ? period === "monthly"
      ? `¥${unitPrice.toLocaleString("zh-CN")}${zh ? " / 月 / 席位" : " / mo / seat"}`
      : `¥${unitPrice.toLocaleString("zh-CN")}${zh ? " / 年 / 席位" : " / yr / seat"}`
    : period === "monthly"
      ? `¥${unitPrice.toLocaleString("zh-CN")}${zh ? " / 月" : " / mo"}`
      : `¥${unitPrice.toLocaleString("zh-CN")}${zh ? " / 年" : " / yr"}`;

  const selectAudience = (nextAudience: MembershipAudience) => {
    const availablePlans = plans.filter((plan) => (
      plan.audience === nextAudience && isMembershipTierSelectable(currentTier, plan.id)
    ));
    if (availablePlans.length === 0) return;
    setAudience(nextAudience);
    const currentAudience = membershipAudienceForTier(currentTier);
    const preferredTier = nextAudience === currentAudience
      ? defaultUpgradeTier(currentTier)
      : nextAudience === "personal" ? "pro" : "team";
    const nextPlan = availablePlans.find((plan) => plan.id === preferredTier) ?? availablePlans[0];
    setSelectedTier(nextPlan.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex w-[calc(100vw-2rem)] max-w-[880px] flex-col gap-0 overflow-hidden rounded-[24px] p-0 sm:max-w-[880px] md:h-[600px]"
        data-testid="membership-upgrade-dialog"
      >
        <DialogHeader className="shrink-0 border-b border-dls-border px-6 pb-4 pt-5 pr-14">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <DialogTitle className="text-[20px] font-semibold tracking-[-0.035em]">
                {zh ? "选择适合你的会员方案" : "Choose the membership that fits your work"}
              </DialogTitle>
              <DialogDescription className="mt-1 text-[12px] leading-5">
                {zh ? "升级积分、模型与自动化能力，套餐可随时调整。" : "Add points, models, and automation capacity. You can change plans later."}
              </DialogDescription>
            </div>
            <div className="rounded-lg bg-dls-hover px-2.5 py-1.5 text-[11px] text-muted-foreground">
              {zh ? "当前方案" : "Current"} · {plans.find((plan) => plan.id === currentTier)?.name ?? "Community"}
            </div>
          </div>
        </DialogHeader>

        <div className="md:grid md:min-h-0 md:flex-1 md:grid-cols-[minmax(0,1.38fr)_minmax(285px,0.92fr)]">
          <section className="px-5 py-5 md:px-6">
            <div className="grid grid-cols-2 rounded-[14px] bg-dls-hover p-1" role="tablist" aria-label={zh ? "套餐类型" : "Plan type"}>
              {(["personal", "team"] as const).map((item) => {
                const active = audience === item;
                const enabled = plans.some((plan) => (
                  plan.audience === item && isMembershipTierSelectable(currentTier, plan.id)
                ));
                return (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    disabled={!enabled}
                    onClick={() => selectAudience(item)}
                    className={cn(
                      "flex h-9 items-center justify-center gap-2 rounded-[10px] text-[12px] font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] active:scale-[0.99]",
                      active ? "bg-background text-dls-text shadow-sm ring-1 ring-foreground/5" : "text-muted-foreground hover:text-dls-text",
                      !enabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground active:scale-100",
                    )}
                    data-testid={`membership-audience-${item}`}
                  >
                    {item === "personal" ? <Sparkles className="size-4" strokeWidth={1.8} /> : <Users className="size-4" strokeWidth={1.8} />}
                    {item === "personal" ? (zh ? "个人版" : "Personal") : (zh ? "团队版" : "Team")}
                  </button>
                );
              })}
            </div>

            <div className={cn("mt-4 grid gap-2", visiblePlans.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
              {visiblePlans.map((plan) => {
                const active = plan.id === selectedPlan.id;
                const current = plan.id === currentTier;
                const selectable = isMembershipTierSelectable(currentTier, plan.id);
                return (
                  <button
                    key={plan.id}
                    type="button"
                    disabled={!selectable}
                    onClick={() => setSelectedTier(plan.id)}
                    className={cn(
                      "relative min-w-0 rounded-[14px] border px-3 py-3 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] active:scale-[0.99]",
                      active
                        ? "border-dls-accent bg-[rgba(var(--dls-accent-rgb),0.055)] shadow-[0_10px_30px_-26px_rgba(var(--dls-accent-rgb),0.9)]"
                        : "border-dls-border bg-background hover:-translate-y-0.5 hover:border-foreground/20",
                      !selectable && "cursor-not-allowed opacity-45 hover:translate-y-0 hover:border-dls-border active:scale-100",
                    )}
                    title={!selectable ? (zh ? "当前套餐不支持降级到此档位" : "Downgrading to this plan is not available") : undefined}
                    data-testid={`membership-plan-${plan.id}`}
                  >
                    {plan.recommended && !current && selectable ? (
                      <span className="absolute -top-2 right-2 rounded-md bg-dls-accent px-1.5 py-0.5 text-[9px] font-semibold text-[var(--dls-accent-fg)]">
                        {zh ? "推荐" : "Popular"}
                      </span>
                    ) : null}
                    <span className="flex items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-semibold text-dls-text">{plan.name}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{plan.edition}</span>
                      </span>
                      {current ? (
                        <span className="flex shrink-0 items-center gap-1 rounded-md bg-dls-hover px-1.5 py-1 text-[9px] font-medium text-muted-foreground">
                          <Check className="size-2.5" strokeWidth={2.4} />
                          {zh ? "当前" : "Current"}
                        </span>
                      ) : !selectable ? (
                        <span className="shrink-0 rounded-md bg-dls-hover px-1.5 py-1 text-[9px] font-medium text-muted-foreground">
                          {zh ? "不可降级" : "Unavailable"}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>

            <article className="mt-4 rounded-[18px] border border-dls-border bg-background px-4 pb-4 pt-4">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <p className="text-[15px] font-semibold tracking-[-0.02em] text-dls-text">{selectedPlan.name} · {selectedPlan.edition}</p>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{selectedPlan.description}</p>
                </div>
                {selectedPlan.id === currentTier ? (
                  <span className="shrink-0 rounded-lg bg-dls-hover px-2 py-1 text-[10px] font-medium text-muted-foreground">{zh ? "当前" : "Current"}</span>
                ) : null}
              </div>
              <ul className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
                {selectedPlan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-[11px] leading-4 text-dls-text">
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-[rgba(var(--dls-accent-rgb),0.09)] text-dls-accent">
                      <Check className="size-2.5" strokeWidth={2.5} />
                    </span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </article>

            <div className="mt-4">
              <p className="text-[12px] font-semibold text-dls-text">{zh ? "选择计费方式" : "Billing period"}</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(["monthly", "annual"] as const).map((item) => {
                  const active = period === item;
                  const price = item === "monthly" ? selectedPlan.monthlyPrice : selectedPlan.annualPrice;
                  const suffix = isTeam
                    ? item === "monthly" ? (zh ? "/ 月 / 席位" : "/ mo / seat") : (zh ? "/ 年 / 席位" : "/ yr / seat")
                    : item === "monthly" ? (zh ? "/ 月" : "/ mo") : (zh ? "/ 年" : "/ yr");
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setPeriod(item)}
                      className={cn(
                        "flex min-h-[68px] items-center justify-between gap-2 rounded-[14px] border bg-background px-3 py-2.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] active:scale-[0.99]",
                        active ? "border-dls-accent bg-[rgba(var(--dls-accent-rgb),0.045)]" : "border-dls-border hover:border-foreground/20",
                      )}
                      data-testid={`membership-billing-${item}`}
                    >
                      <span>
                        <span className="block text-[12px] font-medium text-dls-text">{item === "monthly" ? (zh ? "按月购买" : "Monthly") : (zh ? "按年购买" : "Annual")}</span>
                        {item === "annual" ? (
                          <span className="mt-1 block text-[9px] tabular-nums text-muted-foreground">
                            {zh ? `折合 ¥${annualMonthlyEquivalent(selectedPlan)} / 月` : `¥${annualMonthlyEquivalent(selectedPlan)} / month`}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[15px] text-dls-text"><Money amount={price} suffix={suffix} /></span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <aside className="border-t border-dls-border bg-dls-hover/45 p-4 md:border-l md:border-t-0">
            <div className="flex h-full flex-col rounded-[18px] border border-dls-border bg-background p-4 shadow-[0_18px_44px_-40px_rgba(1,22,39,0.5)]">
              <div className="flex items-center justify-between gap-4">
                <p className="text-[13px] font-semibold text-dls-text">
                  {selectedPlan.id === currentTier ? (zh ? "当前" : "Current") : (zh ? "升级" : "Upgrade")} {selectedPlan.name}
                </p>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {durationLabel}{isTeam ? (zh ? ` · ${seats} 席位` : ` · ${seats} seats`) : ""}
                </span>
              </div>
              <p className="mt-3 text-[32px] leading-none text-dls-text"><Money amount={total} /></p>

              <div className="mt-4 flex items-center justify-between gap-3 text-[11px]">
                <span className="font-medium text-dls-text">{selectedPlan.edition} · {periodLabel}</span>
                <span className="shrink-0 font-semibold tabular-nums text-dls-text">{unitPriceLabel}</span>
              </div>

              {isTeam ? (
                <div className="mt-3 flex items-center justify-between rounded-[12px] bg-dls-hover/60 px-3 py-2.5">
                  <div>
                    <p className="text-[11px] font-medium text-dls-text">{zh ? "购买席位" : "Seats"}</p>
                    <p className="mt-0.5 text-[9px] text-muted-foreground">{zh ? `至少 ${selectedPlan.minimumSeats} 席位` : `${selectedPlan.minimumSeats} minimum`}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSeats((value) => Math.max(selectedPlan.minimumSeats, value - 1))}
                      disabled={seats <= selectedPlan.minimumSeats}
                      className="flex size-7 items-center justify-center rounded-lg border border-dls-border text-muted-foreground transition-colors hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] disabled:cursor-not-allowed disabled:opacity-35"
                      aria-label={zh ? "减少席位" : "Remove seat"}
                    ><Minus className="size-3.5" /></button>
                    <span className="w-8 text-center text-[13px] font-semibold tabular-nums text-dls-text">{seats}</span>
                    <button
                      type="button"
                      onClick={() => setSeats((value) => value + 1)}
                      className="flex size-7 items-center justify-center rounded-lg border border-dls-border text-muted-foreground transition-colors hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                      aria-label={zh ? "增加席位" : "Add seat"}
                    ><Plus className="size-3.5" /></button>
                  </div>
                </div>
              ) : null}

              <div className="mt-auto pt-5">
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="text-muted-foreground">{zh ? "生效时间" : "Effective"}</span>
                  <span className="font-medium text-dls-text">{zh ? "支付完成后立即生效" : "Immediately after payment"}</span>
                </div>
                <div className="my-3 border-t border-dashed border-dls-border" />
                <p className="text-[10px] font-medium text-muted-foreground">
                  {isFree ? (zh ? "无需支付" : "No payment required") : (zh ? "支付宝扫码支付" : "Pay with Alipay")}
                </p>
                <div className="mt-2 flex justify-center">
                  <PaymentCodePlaceholder free={isFree} zh={zh} />
                </div>
                <p className="mt-2 text-center text-[9px] leading-4 text-muted-foreground">
                  {isFree
                    ? (zh ? "Community 免费使用，无需扫码。" : "Community is free. No scan is needed.")
                    : (zh ? "确认订单后生成付款码，请使用支付宝扫码。" : "Confirm the order, then scan the generated code with Alipay.")}
                </p>
                <div className="mt-2 flex items-start justify-center gap-1.5 text-[9px] leading-4 text-muted-foreground">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-dls-accent text-[var(--dls-accent-fg)]">
                    <Check className="size-2.5" strokeWidth={2.5} />
                  </span>
                  <span>{zh ? "我已确认所选套餐与计费周期" : "I have confirmed the selected plan and billing period"}</span>
                </div>
              </div>
            </div>
          </aside>
        </div>
        <span className="sr-only">{t("common.close")}</span>
      </DialogContent>
    </Dialog>
  );
}
