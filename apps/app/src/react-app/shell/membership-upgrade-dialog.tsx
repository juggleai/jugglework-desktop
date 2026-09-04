/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, LoaderCircle, Minus, Plus, Sparkles, Users } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createMembershipClaimIdempotencyKey,
  createDenClient,
  DenApiError,
  isMembershipCheckoutOpenable,
  isRetryableMembershipPollingError,
  readDenSettings,
  writeDenSettings,
  type DenMembershipBillingCatalog,
  type DenMembershipOrder,
  type DenOrgSummary,
  type DenTenantTier,
} from "@/app/lib/den";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";
import {
  defaultUpgradeTier,
  isMembershipTierSelectable,
  membershipAudienceForTier,
  membershipPlans,
  type BillingPeriod,
  type MembershipAudience,
} from "./membership-upgrade-model";

type MembershipUpgradeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTier?: DenTenantTier | null;
  tenantKind?: "personal" | "organization" | null;
  organizationId?: string | null;
  organizations?: DenOrgSummary[];
  canManageBilling?: boolean;
  billingPeriod?: BillingPeriod | null;
  onSwitchOrganization?: (organizationId: string) => Promise<void>;
  onFulfilled?: () => Promise<void>;
};

const EMPTY_ORGANIZATIONS: DenOrgSummary[] = [];

function Money({ amountFen, locale, suffix }: { amountFen: string | null; locale: string; suffix?: string }) {
  return (
    <span className="font-heading font-semibold tabular-nums tracking-[-0.03em]">
      <span className="mr-0.5 text-[0.58em] align-[0.24em]">¥</span>{amountFen === null ? "--" : formatFen(amountFen, locale)}
      {suffix ? <span className="ml-1 text-[0.46em] font-medium tracking-normal text-muted-foreground">{suffix}</span> : null}
    </span>
  );
}

function CheckoutPlaceholder({ free, zh }: { free: boolean; zh: boolean }) {
  return (
    <div
      className={cn(
        "relative flex size-40 shrink-0 items-center justify-center overflow-hidden rounded-[18px] border bg-background",
        free ? "border-dls-border" : "border-[rgba(var(--dls-accent-rgb),0.18)] shadow-[0_18px_44px_-34px_rgba(var(--dls-accent-rgb),0.65)]",
      )}
      data-testid="membership-checkout-placeholder"
      aria-label={zh ? "支付宝网页支付" : "Alipay web checkout"}
    >
      <div className="absolute inset-2.5 rounded-[13px] bg-[radial-gradient(circle_at_center,rgba(var(--dls-accent-rgb),0.09)_1px,transparent_1px)] [background-size:5px_5px]" />
      <div className="relative flex size-16 flex-col items-center justify-center rounded-[14px] border border-dls-border bg-background shadow-sm">
        {free ? <Check className="size-6 text-dls-accent" strokeWidth={2.1} /> : <ExternalLink className="size-6 text-dls-accent" strokeWidth={1.7} />}
        <span className="mt-1 text-[10px] font-semibold text-dls-text">{free ? (zh ? "免费" : "Free") : "Alipay"}</span>
      </div>
    </div>
  );
}

function createIdempotencyKey(kind: "order"): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `desktop-membership-${kind}-${random}`;
}

function monthlyEquivalentFen(annualAmountFen: string): string | null {
  try {
    return String(BigInt(annualAmountFen) / 12n);
  } catch {
    return null;
  }
}

function formatFen(amountFen: string, locale: string): string {
  try {
    const fen = BigInt(amountFen);
    const whole = fen / 100n;
    const fraction = String(fen % 100n).padStart(2, "0");
    return `${new Intl.NumberFormat(locale).format(whole)}.${fraction}`;
  } catch {
    return "--";
  }
}

function isCheckoutOrder(order: DenMembershipOrder): boolean {
  return order.status !== "closed" && order.status !== "expired" && order.status !== "fulfilled";
}

function shouldPollOrder(order: DenMembershipOrder): boolean {
  return order.status === "payment_pending" || order.status === "paid_pending_fulfillment";
}

function recoveryPriority(order: DenMembershipOrder): number {
  switch (order.status) {
    case "paid_pending_activation": return 0;
    case "reconciliation_required": return 1;
    case "paid_pending_fulfillment": return 2;
    case "payment_pending": return 3;
    default: return 4;
  }
}

function pollingErrorMessage(error: unknown, zh: boolean): { message: string; retryable: boolean } {
  if (error instanceof DenApiError) {
    return { message: error.message, retryable: isRetryableMembershipPollingError(error) };
  }
  return {
    message: error instanceof Error ? error.message : (zh ? "订单状态检查失败。" : "Order status check failed."),
    retryable: true,
  };
}

function orderOrganizationError(zh: boolean): Error {
  return new Error(zh
    ? "订单所属工作区不再可用，无法安全地继续操作。"
    : "The order's organization is no longer available, so the action cannot continue safely.");
}

class BillingOperationCancelled extends Error {}
class BillingOrganizationUncertain extends Error {}

async function openPaymentInSystemBrowser(url: string): Promise<void> {
  const openExternal = typeof window !== "undefined" ? window.__JUGGLEWORK_ELECTRON__?.shell?.openExternal : undefined;
  if (!openExternal) throw new Error("The system browser bridge is unavailable. Restart the desktop app before paying.");
  const result = await openExternal(url);
  if (result && result.ok === false) throw new Error(result.error ?? "Failed to open the system browser.");
}

export function MembershipUpgradeDialog({
  open,
  onOpenChange,
  currentTier,
  tenantKind,
  organizationId,
  organizations = EMPTY_ORGANIZATIONS,
  canManageBilling = true,
  billingPeriod,
  onSwitchOrganization,
  onFulfilled,
}: MembershipUpgradeDialogProps) {
  const zh = currentLocale() === "zh";
  const locale = currentLocale();
  const basePlans = useMemo(() => membershipPlans(locale), [locale, open]);
  const [catalog, setCatalog] = useState<DenMembershipBillingCatalog | null>(null);
  const plans = useMemo(() => basePlans.map((plan) => {
    const serverPlan = catalog?.plans.find((entry) => entry.plan === plan.id);
    return serverPlan ? {
      ...plan,
      minimumSeats: serverPlan.minimumSeats,
    } : plan;
  }), [basePlans, catalog]);
  const initialAudience = membershipAudienceForTier(currentTier);
  const [audience, setAudience] = useState<MembershipAudience>(initialAudience);
  const [selectedTier, setSelectedTier] = useState<DenTenantTier>(defaultUpgradeTier(currentTier));
  const [period, setPeriod] = useState<BillingPeriod>(billingPeriod ?? "annual");
  const selectedPlan = plans.find((plan) => plan.id === selectedTier) ?? plans[1];
  const [seats, setSeats] = useState(selectedPlan.minimumSeats);
  const [order, setOrder] = useState<DenMembershipOrder | null>(null);
  const [recoveryOrders, setRecoveryOrders] = useState<DenMembershipOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const orderKeyRef = useRef<{ selection: string; key: string } | null>(null);
  const claimKeyRef = useRef<{ selection: string; key: string } | null>(null);
  const refreshedOrderIdRef = useRef<string | null>(null);
  const operationGenerationRef = useRef(0);
  const renderedOpenRef = useRef(open);
  const availableOrganizationsRef = useRef<DenOrgSummary[]>(organizations);
  const organizationsPropRef = useRef(organizations);
  const activeOrganizationIdRef = useRef(organizationId?.trim() || "");
  const renderedOrganizationId = organizationId?.trim() || "";
  if (renderedOrganizationId && renderedOrganizationId !== activeOrganizationIdRef.current) {
    activeOrganizationIdRef.current = renderedOrganizationId;
  }
  if (!open && renderedOpenRef.current) operationGenerationRef.current += 1;
  renderedOpenRef.current = open;
  if (organizations !== organizationsPropRef.current) {
    organizationsPropRef.current = organizations;
    availableOrganizationsRef.current = organizations;
  }

  const assertCurrentOperation = (generation: number) => {
    if (generation !== operationGenerationRef.current) throw new BillingOperationCancelled();
  };

  const synchronizeOrderOrganization = async (
    candidate: DenMembershipOrder,
    client: ReturnType<typeof createDenClient>,
    generation: number,
  ): Promise<string | null> => {
    assertCurrentOperation(generation);
    if (candidate.organizationId === null) {
      if (candidate.targetMode !== "new_organization") throw orderOrganizationError(zh);
      return null;
    }
    const target = availableOrganizationsRef.current.find((item) => item.id === candidate.organizationId);
    if (!target || candidate.targetMode !== "existing_tenant") throw orderOrganizationError(zh);
    if (activeOrganizationIdRef.current !== target.id) {
      if (onSwitchOrganization) {
        await onSwitchOrganization(target.id);
      } else {
        if (activeOrganizationIdRef.current) throw orderOrganizationError(zh);
        await client.setActiveOrganization({ organizationId: target.id });
      }
    }
    assertCurrentOperation(generation);
    activeOrganizationIdRef.current = target.id;
    return target.id;
  };

  const restoreOrderOrganization = async (
    originalOrganizationId: string,
    targetOrganizationId: string | null,
    client: ReturnType<typeof createDenClient>,
  ) => {
    if (!originalOrganizationId || !targetOrganizationId || originalOrganizationId === targetOrganizationId) return;
    if (!availableOrganizationsRef.current.some((item) => item.id === originalOrganizationId)) return;
    if (onSwitchOrganization) {
      await onSwitchOrganization(originalOrganizationId);
    } else {
      await client.setActiveOrganization({ organizationId: originalOrganizationId });
    }
    activeOrganizationIdRef.current = originalOrganizationId;
  };

  const readRecoveryOrder = async (
    candidate: DenMembershipOrder,
    client: ReturnType<typeof createDenClient>,
    fallbackOrganizationId: string,
    generation: number,
  ): Promise<DenMembershipOrder> => {
    assertCurrentOperation(generation);
    if (candidate.status === "paid_pending_activation" && candidate.targetMode === "new_organization") return candidate;
    const originalOrganizationId = activeOrganizationIdRef.current;
    const targetOrganizationId = candidate.organizationId;
    try {
      const synchronizedOrganizationId = await synchronizeOrderOrganization(candidate, client, generation);
      const result = await client.getMembershipOrder(synchronizedOrganizationId ?? fallbackOrganizationId, candidate.id, candidate);
      assertCurrentOperation(generation);
      return result;
    } catch (nextError) {
      try {
        await restoreOrderOrganization(originalOrganizationId, targetOrganizationId, client);
      } catch {
        throw new BillingOrganizationUncertain(zh
          ? "工作区切换结果不确定，已停止支付操作。请重新加载工作区后再试。"
          : "The organization context is uncertain, so billing was stopped. Reload your organizations before trying again.");
      }
      throw nextError;
    }
  };

  const withOrderOrganization = async <T,>(
    candidate: DenMembershipOrder,
    client: ReturnType<typeof createDenClient>,
    action: (organizationId: string | null) => Promise<T>,
    generation: number,
  ): Promise<T> => {
    assertCurrentOperation(generation);
    const originalOrganizationId = activeOrganizationIdRef.current;
    const targetOrganizationId = candidate.organizationId;
    try {
      const synchronizedOrganizationId = await synchronizeOrderOrganization(candidate, client, generation);
      const result = await action(synchronizedOrganizationId);
      assertCurrentOperation(generation);
      return result;
    } catch (nextError) {
      try {
        await restoreOrderOrganization(originalOrganizationId, targetOrganizationId, client);
      } catch {
        throw new BillingOrganizationUncertain(zh
          ? "工作区切换结果不确定，已停止支付操作。请重新加载工作区后再试。"
          : "The organization context is uncertain, so billing was stopped. Reload your organizations before trying again.");
      }
      throw nextError;
    }
  };

  useEffect(() => {
    if (!open) return;
    const nextAudience = membershipAudienceForTier(currentTier);
    const nextTier = defaultUpgradeTier(currentTier);
    setAudience(nextAudience);
    setSelectedTier(nextTier);
    setPeriod(billingPeriod ?? "annual");
    setSeats(basePlans.find((plan) => plan.id === nextTier)?.minimumSeats ?? 1);
    setCatalog(null);
    setOrder(null);
    setRecoveryOrders([]);
    setError(null);
    setOrganizationName("");
    orderKeyRef.current = null;
    claimKeyRef.current = null;
    refreshedOrderIdRef.current = null;
    const generation = ++operationGenerationRef.current;

    const settings = readDenSettings();
    const orgId = organizationId?.trim() || settings.activeOrgId?.trim() || "";
    activeOrganizationIdRef.current = orgId;
    const token = settings.authToken?.trim() ?? "";
    if (!token) {
      setError(zh ? "请先登录。" : "Sign in first.");
      return;
    }

    let cancelled = false;
    setBusy(true);
    const client = createDenClient({ baseUrl: settings.baseUrl, token });
    const catalogRequest = orgId ? client.getMembershipBillingCatalog(orgId) : Promise.reject(new Error("active organization required for catalog"));
    void Promise.allSettled([catalogRequest, client.listMembershipOrders(100), client.listOrgs()])
      .then(async ([catalogResult, ordersResult, organizationsResult]) => {
        assertCurrentOperation(generation);
        if (ordersResult.status === "rejected") throw ordersResult.reason;
        const listedOrganizations = organizationsResult.status === "fulfilled" ? organizationsResult.value.orgs : availableOrganizationsRef.current;
        availableOrganizationsRef.current = listedOrganizations;
        const candidates = ordersResult.value.filter(isCheckoutOrder).sort((left, right) => recoveryPriority(left) - recoveryPriority(right));
        const recoverable = candidates.filter((item) => (
          item.organizationId !== null
            ? listedOrganizations.some((organization) => organization.id === item.organizationId)
            : item.targetMode === "new_organization"
        ));
        assertCurrentOperation(generation);
        setRecoveryOrders(candidates);
        const candidate = recoverable.find((item) => item.status === "paid_pending_activation") ?? recoverable[0] ?? null;
        let resumable: DenMembershipOrder | null = null;
        if (candidate) {
          if (candidate.status === "paid_pending_activation") {
            resumable = candidate;
          } else {
            for (const item of recoverable) {
              try {
                if (cancelled) return;
                resumable = await readRecoveryOrder(item, client, orgId, generation);
                break;
              } catch (nextError) {
                if (nextError instanceof BillingOperationCancelled) return;
                if (nextError instanceof BillingOrganizationUncertain) throw nextError;
                // Keep this item in the recovery selector and try the next one.
              }
            }
          }
        }
        if (cancelled || generation !== operationGenerationRef.current) return;
        if (catalogResult.status === "fulfilled") {
          setCatalog(catalogResult.value);
        } else if (!resumable || resumable.nextAction !== "create_organization") {
          throw catalogResult.reason;
        }
        if (resumable) {
          setOrder(resumable);
          setRecoveryOrders(candidates.filter((item) => item.id !== resumable?.id));
          setSelectedTier(resumable.plan);
          setAudience(membershipAudienceForTier(resumable.plan));
          setPeriod(resumable.period);
          setSeats(resumable.seats);
        }
      })
      .catch((nextError) => {
        if (!cancelled && !(nextError instanceof BillingOperationCancelled)) setError(nextError instanceof Error ? nextError.message : (zh ? "无法加载会员信息。" : "Could not load membership billing."));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      operationGenerationRef.current += 1;
    };
  }, [basePlans, billingPeriod, currentTier, open, zh]);

  useEffect(() => {
    if (!open || busy || !order || !shouldPollOrder(order)) return;
    const settings = readDenSettings();
    const orgId = order.organizationId ?? (activeOrganizationIdRef.current || settings.activeOrgId?.trim() || "");
    const token = settings.authToken?.trim() ?? "";
    if (!orgId || !token) return;
    const client = createDenClient({ baseUrl: settings.baseUrl, token });
    const delays = [1_500, 2_500, 4_000, 6_000, 10_000];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let stopped = false;
    let attempt = 0;
    let consecutiveErrors = 0;
    const errorBudget = 3;
    const generation = operationGenerationRef.current;
    const documentTarget = typeof document === "undefined" ? null : document;
    const isVisible = () => documentTarget?.visibilityState !== "hidden";
    const schedule = () => {
      if (cancelled || !isVisible()) return;
      timer = setTimeout(() => void poll(), delays[Math.min(attempt++, delays.length - 1)]);
    };
    const poll = async () => {
      if (cancelled || stopped || polling || !isVisible()) return;
      polling = true;
      try {
        const nextOrder = await client.getMembershipOrder(orgId, order.id, order);
        if (cancelled || generation !== operationGenerationRef.current) return;
        consecutiveErrors = 0;
        setError(null);
        setOrder(nextOrder);
        if (!shouldPollOrder(nextOrder)) return;
      } catch (nextError) {
        if (cancelled || generation !== operationGenerationRef.current) return;
        const classified = pollingErrorMessage(nextError, zh);
        consecutiveErrors += 1;
        if (!classified.retryable || consecutiveErrors >= errorBudget) {
          stopped = true;
          setError(zh
            ? `无法继续检查支付状态：${classified.message}`
            : `Could not continue checking payment status: ${classified.message}`);
          return;
        }
      } finally {
        polling = false;
      }
      schedule();
    };
    const onVisibilityChange = () => {
      if (stopped) return;
      if (!isVisible()) {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      if (!polling) void poll();
    };
    documentTarget?.addEventListener("visibilitychange", onVisibilityChange);
    void withOrderOrganization(order, client, async () => undefined, generation)
      .then(() => {
        schedule();
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : (zh ? "无法同步订单工作区。" : "Could not synchronize the order organization."));
        }
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [busy, open, order?.id, order?.nextAction, order?.organizationId, order?.status, zh]);

  useEffect(() => {
    if (!open || !order || (order.status !== "fulfilled" && order.nextAction !== "refresh_tenant_account")) return;
    if (refreshedOrderIdRef.current === order.id) return;
    refreshedOrderIdRef.current = order.id;
    void onFulfilled?.();
  }, [onFulfilled, open, order]);

  const visiblePlans = plans.filter((plan) => plan.audience === audience);
  const isTeam = selectedPlan.audience === "team";
  const catalogPlan = catalog?.plans.find((plan) => plan.plan === selectedPlan.id) ?? null;
  const catalogUnitAmountFen = catalogPlan
    ? period === "monthly" ? catalogPlan.monthlyAmountFen : catalogPlan.annualAmountFen
    : null;
  const isFree = catalogUnitAmountFen === "0";
  const orderOrganization = order?.organizationId
    ? availableOrganizationsRef.current.find((item) => item.id === order.organizationId) ?? null
    : null;
  const selectionFrozen = Boolean(order && order.status !== "closed" && order.status !== "expired" && order.status !== "fulfilled");
  const periodLabel = period === "monthly" ? (zh ? "按月购买" : "Monthly") : (zh ? "按年购买" : "Annual");
  const durationLabel = period === "monthly" ? (zh ? "1 个月" : "1 month") : (zh ? "1 年" : "1 year");
  const unitPriceLabel = isTeam
    ? period === "monthly"
      ? `¥${catalogUnitAmountFen ? formatFen(catalogUnitAmountFen, locale) : "--"}${zh ? " / 月 / 席位" : " / mo / seat"}`
      : `¥${catalogUnitAmountFen ? formatFen(catalogUnitAmountFen, locale) : "--"}${zh ? " / 年 / 席位" : " / yr / seat"}`
    : period === "monthly"
      ? `¥${catalogUnitAmountFen ? formatFen(catalogUnitAmountFen, locale) : "--"}${zh ? " / 月" : " / mo"}`
      : `¥${catalogUnitAmountFen ? formatFen(catalogUnitAmountFen, locale) : "--"}${zh ? " / 年" : " / yr"}`;

  const closeCurrentOrder = async () => {
    if (!order || (order.status !== "quoted" && order.status !== "payment_pending")) return;
    const settings = readDenSettings();
    const orgId = order.organizationId ?? (activeOrganizationIdRef.current || settings.activeOrgId?.trim() || "");
    const token = settings.authToken?.trim() ?? "";
    if (!orgId || !token) return;
    setBusy(true);
    setError(null);
    const generation = ++operationGenerationRef.current;
    try {
      const client = createDenClient({ baseUrl: settings.baseUrl, token });
      await withOrderOrganization(order, client, (synchronizedOrgId) => client.closeMembershipOrder(synchronizedOrgId ?? orgId, order.id, order), generation);
      assertCurrentOperation(generation);
      setOrder(null);
      orderKeyRef.current = null;
    } catch (nextError) {
      if (!(nextError instanceof BillingOperationCancelled)) {
        setError(nextError instanceof Error ? nextError.message : (zh ? "无法取消订单。" : "Could not cancel the order."));
        setOrder({ ...order });
      }
    } finally {
      if (generation === operationGenerationRef.current) setBusy(false);
    }
  };

  const resumeRecoveryOrder = async (candidate: DenMembershipOrder) => {
    const settings = readDenSettings();
    const orgId = activeOrganizationIdRef.current || settings.activeOrgId?.trim() || "";
    const token = settings.authToken?.trim() ?? "";
    if (!orgId || !token) return;
    setBusy(true);
    setError(null);
    const generation = ++operationGenerationRef.current;
    try {
      const client = createDenClient({ baseUrl: settings.baseUrl, token });
      const nextOrder = await readRecoveryOrder(candidate, client, orgId, generation);
      assertCurrentOperation(generation);
      setRecoveryOrders((current) => {
        const previous = order && isCheckoutOrder(order) && order.id !== nextOrder.id ? [order] : [];
        return [...previous, ...current.filter((item) => item.id !== nextOrder.id && item.id !== order?.id)]
          .sort((left, right) => recoveryPriority(left) - recoveryPriority(right));
      });
      setOrder(nextOrder);
      setSelectedTier(nextOrder.plan);
      setAudience(membershipAudienceForTier(nextOrder.plan));
      setPeriod(nextOrder.period);
      setSeats(nextOrder.seats);
      setOrganizationName("");
    } catch (nextError) {
      if (!(nextError instanceof BillingOperationCancelled)) setError(nextError instanceof Error ? nextError.message : (zh ? "无法恢复该订单。" : "Could not resume that order."));
    } finally {
      if (generation === operationGenerationRef.current) setBusy(false);
    }
  };

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
    setSeats(nextPlan.minimumSeats);
    setOrder(null);
    orderKeyRef.current = null;
  };

  const selectTier = (tier: DenTenantTier) => {
    const nextPlan = plans.find((plan) => plan.id === tier);
    setSelectedTier(tier);
    setSeats(nextPlan?.minimumSeats ?? 1);
    setOrder(null);
    setError(null);
    orderKeyRef.current = null;
  };

  const selectPeriod = (nextPeriod: BillingPeriod) => {
    setPeriod(nextPeriod);
    setOrder(null);
    setError(null);
    orderKeyRef.current = null;
  };

  const changeSeats = (nextSeats: number) => {
    setSeats(Math.max(selectedPlan.minimumSeats, nextSeats));
    setOrder(null);
    setError(null);
    orderKeyRef.current = null;
  };

  const runBillingAction = async () => {
    const settings = readDenSettings();
    const orgId = activeOrganizationIdRef.current || settings.activeOrgId?.trim() || "";
    const token = settings.authToken?.trim() ?? "";
    if (!orgId || !token) return;
    const client = createDenClient({ baseUrl: settings.baseUrl, token });
    const generation = ++operationGenerationRef.current;
    setBusy(true);
    setError(null);
    try {
      if (order?.status === "expired" || order?.status === "closed") {
        setOrder(null);
        orderKeyRef.current = null;
        return;
      }

      if (!order) {
        if (!catalogPlan) {
          throw new Error(zh ? "服务器目录中没有所选套餐。" : "The selected plan is missing from the server catalog.");
        }
        const selection = {
          targetMode: isTeam && tenantKind !== "organization" ? "new_organization" as const : "existing_tenant" as const,
          plan: selectedPlan.id,
          period,
          seats,
        };
        const signature = JSON.stringify(selection);
        if (orderKeyRef.current?.selection !== signature) {
          orderKeyRef.current = { selection: signature, key: createIdempotencyKey("order") };
        }
        const nextOrder = await client.createMembershipOrder(orgId, selection, orderKeyRef.current.key);
        assertCurrentOperation(generation);
        setOrder(nextOrder);
        return;
      }

      if (order.status === "paid_pending_activation" && order.nextAction === "create_organization") {
        const name = organizationName.trim();
        if (Array.from(name).length < 2 || Array.from(name).length > 120) {
          throw new Error(zh ? "团队名称需要 2 到 120 个字符。" : "Organization name must be 2 to 120 characters.");
        }
        const signature = `${order.id}\n${name}`;
        if (claimKeyRef.current?.selection !== signature) {
          claimKeyRef.current = { selection: signature, key: await createMembershipClaimIdempotencyKey(order.id, name) };
        }
        const organization = await client.activatePaidTeamOrganization(order.id, name, claimKeyRef.current.key);
        assertCurrentOperation(generation);
        writeDenSettings({
          ...settings,
          activeOrgId: organization.id,
          activeOrgSlug: organization.slug,
          activeOrgName: organization.name,
        }, { persistBootstrap: false });
        activeOrganizationIdRef.current = organization.id;
        refreshedOrderIdRef.current = order.id;
        setOrder({
          ...order,
          status: "fulfilled",
          fulfillmentStatus: "fulfilled",
          fulfilledAt: new Date().toISOString(),
          nextAction: "refresh_tenant_account",
        });
        await onFulfilled?.();
        assertCurrentOperation(generation);
        return;
      }

      if (order.nextAction === "open_checkout") {
        await withOrderOrganization(order, client, async () => {
          if (!isMembershipCheckoutOpenable(order)) {
            throw new Error(zh ? "支付地址无效或已过期，请等待状态刷新。" : "The checkout URL is invalid or expired. Wait for the order to refresh.");
          }
          assertCurrentOperation(generation);
          await openPaymentInSystemBrowser(order.checkout!.url);
        }, generation);
        return;
      }

      if (
        order.status === "quoted" ||
        order.nextAction === "refresh_checkout" ||
        order.nextAction === "refresh_payment_code"
      ) {
        const nextOrder = await withOrderOrganization(order, client, async (synchronizedOrgId) => {
          const result = await client.createMembershipPaymentAttempt(synchronizedOrgId ?? orgId, order.id, order);
          assertCurrentOperation(generation);
          if (result.nextAction === "open_checkout") {
            if (!isMembershipCheckoutOpenable(result)) {
              throw new Error(zh ? "支付地址无效或已过期，请重新生成。" : "The checkout URL is invalid or expired. Create a new checkout.");
            }
            await openPaymentInSystemBrowser(result.checkout!.url);
          }
          return result;
        }, generation);
        assertCurrentOperation(generation);
        setOrder(nextOrder);
      }
    } catch (nextError) {
      if (!(nextError instanceof BillingOperationCancelled)) setError(nextError instanceof Error ? nextError.message : (zh ? "支付操作失败，请重试。" : "Payment action failed. Try again."));
    } finally {
      if (generation === operationGenerationRef.current) setBusy(false);
    }
  };

  const actionLabel = !order
    ? (zh ? "确认订单" : "Confirm order")
    : order.status === "fulfilled" || order.nextAction === "refresh_tenant_account"
      ? (zh ? "会员已生效" : "Membership active")
      : order.status === "paid_pending_activation" || order.nextAction === "create_organization"
        ? (zh ? "创建并进入团队" : "Create and enter organization")
      : order.status === "expired" || order.status === "closed"
        ? (zh ? "重新选择并创建订单" : "Start a new order")
      : order.nextAction === "open_checkout"
        ? (zh ? "打开支付宝付款" : "Open Alipay checkout")
        : order.nextAction === "refresh_checkout"
          ? (zh ? "刷新支付页面" : "Refresh checkout")
          : order.status === "reconciliation_required" || order.nextAction === "contact_support"
            ? (zh ? "请联系支持" : "Contact support")
            : (zh ? "创建支付页面" : "Create checkout");
  const needsPaymentAdmission = !order || order.status === "quoted" || order.status === "expired" || order.status === "closed" || order.nextAction === "refresh_checkout" || order.nextAction === "refresh_payment_code";
  const hasBillingAction = !order || order.status === "quoted" || order.status === "expired" || order.status === "closed" || order.nextAction === "open_checkout" || order.nextAction === "refresh_checkout" || order.nextAction === "refresh_payment_code" || order.nextAction === "create_organization";
  const claimNameValid = Array.from(organizationName.trim()).length >= 2 && Array.from(organizationName.trim()).length <= 120;
  const isClaimAction = order?.nextAction === "create_organization";
  const actionDisabled = busy || (!catalog && !isClaimAction) || (needsPaymentAdmission && !catalog?.payment.alipayPageAvailable) || (!canManageBilling && !isClaimAction) || !hasBillingAction || isFree || (isClaimAction && !claimNameValid);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) operationGenerationRef.current += 1;
        onOpenChange(nextOpen);
      }}
    >
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
          <section className="px-5 py-5 md:min-h-0 md:overflow-y-auto md:px-6">
            <div className="grid grid-cols-2 rounded-[14px] bg-dls-hover p-1" role="tablist" aria-label={zh ? "套餐类型" : "Plan type"}>
              {(["personal", "team"] as const).map((item) => {
                const active = audience === item;
                const enabled = !selectionFrozen && plans.some((plan) => (
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
                    disabled={!selectable || selectionFrozen}
                    onClick={() => selectTier(plan.id)}
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
                  const itemAmountFen = catalogPlan
                    ? item === "monthly" ? catalogPlan.monthlyAmountFen : catalogPlan.annualAmountFen
                    : null;
                  const suffix = isTeam
                    ? item === "monthly" ? (zh ? "/ 月 / 席位" : "/ mo / seat") : (zh ? "/ 年 / 席位" : "/ yr / seat")
                    : item === "monthly" ? (zh ? "/ 月" : "/ mo") : (zh ? "/ 年" : "/ yr");
                  return (
                    <button
                      key={item}
                      type="button"
                      disabled={selectionFrozen}
                      onClick={() => selectPeriod(item)}
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
                            {zh
                              ? `折合 ¥${itemAmountFen ? formatFen(monthlyEquivalentFen(itemAmountFen) ?? "", locale) : "--"} / 月`
                              : `¥${itemAmountFen ? formatFen(monthlyEquivalentFen(itemAmountFen) ?? "", locale) : "--"} / month`}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[15px] text-dls-text"><Money amountFen={itemAmountFen} locale={locale} suffix={suffix} /></span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <aside className="border-t border-dls-border bg-dls-hover/45 p-4 md:min-h-0 md:overflow-y-auto md:border-l md:border-t-0">
            <div className="flex h-full flex-col rounded-[18px] border border-dls-border bg-background p-4 shadow-[0_18px_44px_-40px_rgba(1,22,39,0.5)]">
              <div className="flex items-center justify-between gap-4">
                <p className="text-[13px] font-semibold text-dls-text">
                  {selectedPlan.id === currentTier ? (zh ? "当前" : "Current") : (zh ? "升级" : "Upgrade")} {selectedPlan.name}
                </p>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {durationLabel}{isTeam ? (zh ? ` · ${seats} 席位` : ` · ${seats} seats`) : ""}
                </span>
              </div>
              <p className="mt-3 text-[32px] leading-none text-dls-text">
                {order ? (
                  <span className="font-heading font-semibold tabular-nums tracking-[-0.03em]">
                    <span className="mr-0.5 text-[0.58em] align-[0.24em]">¥</span>{formatFen(order.totalAmountFen, locale)}
                  </span>
                ) : <span className="font-heading font-semibold tabular-nums">--</span>}
              </p>

              <div className="mt-4 flex items-center justify-between gap-3 text-[11px]">
                <span className="font-medium text-dls-text">{selectedPlan.edition} · {periodLabel}</span>
                <span className="shrink-0 font-semibold tabular-nums text-dls-text">{unitPriceLabel}</span>
              </div>

              {order ? (
                <div className="mt-3 rounded-[12px] bg-dls-hover/60 px-3 py-2.5 text-[10px]" data-testid="membership-frozen-order-scope">
                  <span className="text-muted-foreground">{zh ? "订单归属" : "Order for"}</span>
                  <span className="ml-2 font-medium text-dls-text">
                    {order.targetMode === "new_organization"
                      ? (zh ? "待创建的新团队" : "New organization to be created")
                      : `${orderOrganization?.name ?? (zh ? "工作区" : "Organization")} (${order.organizationId})`}
                  </span>
                </div>
              ) : null}

              {isTeam ? (
                <div className="mt-3 flex items-center justify-between rounded-[12px] bg-dls-hover/60 px-3 py-2.5">
                  <div>
                    <p className="text-[11px] font-medium text-dls-text">{zh ? "购买席位" : "Seats"}</p>
                    <p className="mt-0.5 text-[9px] text-muted-foreground">{zh ? `至少 ${selectedPlan.minimumSeats} 席位` : `${selectedPlan.minimumSeats} minimum`}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => changeSeats(seats - 1)}
                      disabled={selectionFrozen || seats <= selectedPlan.minimumSeats}
                      className="flex size-7 items-center justify-center rounded-lg border border-dls-border text-muted-foreground transition-colors hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] disabled:cursor-not-allowed disabled:opacity-35"
                      aria-label={zh ? "减少席位" : "Remove seat"}
                    ><Minus className="size-3.5" /></button>
                    <span className="w-8 text-center text-[13px] font-semibold tabular-nums text-dls-text">{seats}</span>
                    <button
                      type="button"
                      onClick={() => changeSeats(seats + 1)}
                      disabled={selectionFrozen}
                      className="flex size-7 items-center justify-center rounded-lg border border-dls-border text-muted-foreground transition-colors hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                      aria-label={zh ? "增加席位" : "Add seat"}
                    ><Plus className="size-3.5" /></button>
                  </div>
                </div>
              ) : null}

              <div className="mt-auto pt-5">
                {recoveryOrders.length > 0 ? (
                  <div className="mb-3 max-h-28 overflow-y-auto rounded-[12px] border border-dls-border bg-dls-hover/45 p-2" data-testid="membership-recovery-orders">
                    <p className="px-1 text-[9px] font-medium text-muted-foreground">
                      {zh ? `还有 ${recoveryOrders.length} 个待处理订单` : `${recoveryOrders.length} more order${recoveryOrders.length === 1 ? "" : "s"} to finish`}
                    </p>
                    <div className="mt-1.5 grid gap-1">
                      {recoveryOrders.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          disabled={busy}
                          onClick={() => void resumeRecoveryOrder(candidate)}
                          className="flex h-7 items-center justify-between rounded-lg px-2 text-[9px] font-medium text-dls-text hover:bg-background disabled:opacity-45"
                          data-testid={`membership-recovery-order-${candidate.id}`}
                        >
                          <span>{candidate.plan === "team" || candidate.plan === "business" ? (zh ? "团队订单" : "Team order") : (zh ? "个人订单" : "Personal order")}</span>
                          <span className="text-muted-foreground">{candidate.nextAction === "create_organization" ? (zh ? "创建团队" : "Create team") : (zh ? "继续" : "Resume")}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {order?.nextAction === "create_organization" ? (
                  <label className="mb-3 block">
                    <span className="text-[11px] font-medium text-dls-text">{zh ? "团队名称" : "Organization name"}</span>
                    <input
                      type="text"
                      value={organizationName}
                      maxLength={120}
                      disabled={busy}
                      onChange={(event) => {
                        setOrganizationName(event.target.value);
                        setError(null);
                      }}
                      placeholder={zh ? "例如：星河工作室" : "For example: Northstar Studio"}
                      className="mt-1.5 h-9 w-full rounded-xl border border-dls-border bg-background px-3 text-[11px] text-dls-text outline-none transition-colors placeholder:text-muted-foreground focus:border-dls-accent"
                      data-testid="membership-organization-name"
                    />
                    <span className="mt-1 block text-[9px] leading-4 text-muted-foreground">
                      {zh ? "付款已确认。创建团队不会再次扣款。" : "Payment is confirmed. Creating the organization will not charge you again."}
                    </span>
                  </label>
                ) : null}
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="text-muted-foreground">{zh ? "生效时间" : "Effective"}</span>
                  <span className="font-medium text-dls-text">{zh ? "支付完成后立即生效" : "Immediately after payment"}</span>
                </div>
                <div className="my-3 border-t border-dashed border-dls-border" />
                <p className="text-[10px] font-medium text-muted-foreground">
                  {isFree ? (zh ? "无需支付" : "No payment required") : (zh ? "支付宝网页支付" : "Pay on Alipay")}
                </p>
                <div className="mt-2 flex justify-center">
                  <CheckoutPlaceholder free={isFree} zh={zh} />
                </div>
                <p className="mt-2 text-center text-[9px] leading-4 text-muted-foreground">
                  {isFree
                    ? (zh ? "Community 免费使用，无需支付。" : "Community is free. No payment is needed.")
                    : order
                      ? (zh ? "金额以服务器冻结订单为准，支付结果由服务器确认。" : "The frozen server order is authoritative. The server confirms payment.")
                      : (zh ? `服务器目录单价 ¥${catalogUnitAmountFen ? formatFen(catalogUnitAmountFen, locale) : "--"}，确认后冻结总价。` : `Server catalog unit price ¥${catalogUnitAmountFen ? formatFen(catalogUnitAmountFen, locale) : "--"}. Confirm to freeze the total.`)}
                </p>
                {error ? <p className="mt-2 text-center text-[10px] leading-4 text-destructive">{error}</p> : null}
                {!catalog?.payment.alipayPageAvailable && !busy && !error ? (
                  <p className="mt-2 text-center text-[10px] leading-4 text-muted-foreground">{zh ? "支付宝网页支付暂不可用。" : "Alipay web checkout is unavailable."}</p>
                ) : null}
                <button
                  type="button"
                  disabled={actionDisabled}
                  onClick={() => void runBillingAction()}
                  className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-dls-accent px-3 text-[11px] font-semibold text-[var(--dls-accent-fg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                  data-testid="membership-checkout-action"
                >
                  {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : order?.nextAction === "open_checkout" ? <ExternalLink className="size-3.5" /> : <Check className="size-3.5" />}
                  {actionLabel}
                </button>
                {order && (order.status === "quoted" || order.status === "payment_pending") ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void closeCurrentOrder()}
                    className="mt-2 h-8 w-full rounded-xl border border-dls-border bg-background px-3 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-45"
                    data-testid="membership-change-plan"
                  >
                    {zh ? "取消订单并更改方案" : "Cancel order and change plan"}
                  </button>
                ) : null}
              </div>
            </div>
          </aside>
        </div>
        <span className="sr-only">{t("common.close")}</span>
      </DialogContent>
    </Dialog>
  );
}
