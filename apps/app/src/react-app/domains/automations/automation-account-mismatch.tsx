/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { t } from "@/i18n";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";

/**
 * 任务 6.1：事件触发自动化的账号一致性状态。跟 apps/server 的
 * `AutomationSubscriptionAccountStatus`（subscription-sync.ts）是同一个契约，这里独立
 * 声明一份而不是跨包 import，因为这是渲染进程到本机 apps/server 的 HTTP 响应形状，
 * 不是共享类型包 `@jugglework/types` 收敛的领域模型。
 */
export type AutomationSubscriptionAccountStatus =
  | { state: "ok" }
  | { state: "unknown" }
  | { state: "mismatch"; confirmedAccountId: string; currentAccountId: string };

export type AutomationSubscriptionAccountClient = {
  getAutomationSubscriptionAccountStatus: (automationId: string) => Promise<AutomationSubscriptionAccountStatus>;
  confirmAutomationSubscriptionAccount: (automationId: string) => Promise<{ ok: boolean }>;
};

const POLL_INTERVAL_MS = 30_000;

/**
 * 轮询某个事件触发自动化的账号一致性状态。
 * TIPS: 轮询而不是订阅推送——这套状态本来就是 apps/server 的 `AutomationSubscriptionSync`
 * 后台周期性 reconciler 算出来的（同一个 30 秒节奏，见 subscription-sync.ts），没必要为了
 * 这一件事另开一条实时通道。`enabled` 传 false（非事件触发的自动化，或还没有 client）时
 * 完全不发请求，直接停在 "unknown"——定时任务没有这个概念，不该悄悄打一个永远返回 404
 * 或没有意义的轮询。
 */
export function useAutomationSubscriptionAccountStatus(
  client: Pick<AutomationSubscriptionAccountClient, "getAutomationSubscriptionAccountStatus"> | null,
  automationId: string,
  enabled: boolean,
): AutomationSubscriptionAccountStatus {
  const [status, setStatus] = useState<AutomationSubscriptionAccountStatus>({ state: "unknown" });

  useEffect(() => {
    if (!enabled || !client) {
      setStatus({ state: "unknown" });
      return;
    }
    let cancelled = false;
    const poll = () => {
      client.getAutomationSubscriptionAccountStatus(automationId)
        .then((next) => { if (!cancelled) setStatus(next); })
        .catch(() => { if (!cancelled) setStatus({ state: "unknown" }); });
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [client, automationId, enabled]);

  return status;
}

/**
 * 账号变化的重新确认徽标 + 弹窗。
 * TIPS: 产品界面只呈现结果——"账号已变化，是否继续"——不解释 OwnerIMUserID/记账表这些
 * 服务端推理细节，那些只属于代码注释和 tasks.md。
 *
 * @param status 当前账号一致性状态；非 mismatch 时不渲染任何东西
 * @param onConfirm 用户点"继续使用当前账号"后的回调，应当调用 confirmAutomationSubscriptionAccount
 */
export function AccountMismatchBadge(props: {
  status: AutomationSubscriptionAccountStatus;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (props.status.state !== "mismatch") return null;
  return (
    <>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); setOpen(true); }}
        className="ml-3 inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-3 px-2 py-0.5 text-xs text-amber-11"
      >
        <TriangleAlert className="size-3" aria-hidden="true" />
        {t("automation.account_mismatch_badge")}
      </button>
      <ConfirmModal
        open={open}
        title={t("automation.account_mismatch_title")}
        message={t("automation.account_mismatch_message")}
        confirmLabel={t("automation.account_mismatch_confirm")}
        cancelLabel={t("automation.cancel")}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          if (confirming) return;
          setConfirming(true);
          props.onConfirm().finally(() => { setConfirming(false); setOpen(false); });
        }}
      />
    </>
  );
}
