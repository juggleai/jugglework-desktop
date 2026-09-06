/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { t } from "@/i18n";
import type { GithubReadinessState } from "./event-trigger-editor";
import { automationReadinessUnblockedEvent } from "./automation-readiness-events";

const POLL_INTERVAL_MS = 30_000;

export type EventTriggerReadinessClient = {
  checkGithubEventReadiness: (repo: { owner: string; name: string }) => Promise<GithubReadinessState>;
};

/**
 * 任务 2.3b：轮询某个事件触发自动化目标仓库的就绪态，供自动化列表行渲染"待仓库就绪"
 * 标记——这是这个探测第一次在编辑器之外被用到，让"哪些自动化被卡住了"不用逐个点开才
 * 知道。
 *
 * TIPS: 收到 `jw:automation-readiness-unblocked` 的 IM 推送时立刻重查一次，不用干等
 * 下一个轮询周期——这条推送本身只带仓库全名，不带自动化 id，所以是"仓库匹配就重查"，
 * 不是"精确知道是哪个自动化"，重查后端点会给出真实状态，不需要信任推送内容本身。
 */
export function useEventTriggerReadinessBadge(
  client: EventTriggerReadinessClient | null,
  repo: { owner: string; name: string } | null,
  enabled: boolean,
): GithubReadinessState {
  const [state, setState] = useState<GithubReadinessState>("unknown");
  const owner = repo?.owner ?? "";
  const name = repo?.name ?? "";

  useEffect(() => {
    if (!enabled || !client || !owner || !name) {
      setState("unknown");
      return;
    }
    let cancelled = false;
    const poll = () => {
      client.checkGithubEventReadiness({ owner, name })
        .then((next) => { if (!cancelled) setState(next); })
        .catch(() => { if (!cancelled) setState("unknown"); });
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    const onUnblocked = (event: WindowEventMap[typeof automationReadinessUnblockedEvent]) => {
      if (event.detail.repository === `${owner}/${name}`) poll();
    };
    window.addEventListener(automationReadinessUnblockedEvent, onUnblocked);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(automationReadinessUnblockedEvent, onUnblocked);
    };
  }, [client, owner, name, enabled]);

  return state;
}

/**
 * "待仓库就绪"标记。只在真的被卡住（未连接组织能力，或已安装但仓库未绑定）时渲染——
 * `"ready"`/`"unknown"` 都不该给用户一个看起来像警告的东西：`"unknown"` 常常只是还没
 * 探测完，不是真的有问题。
 */
export function EventTriggerReadinessBadge(props: { state: GithubReadinessState }) {
  if (props.state !== "not_connected" && props.state !== "pending_configuration") return null;
  return (
    <span className="ml-3 inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-3 px-2 py-0.5 text-xs text-amber-11">
      <TriangleAlert className="size-3" aria-hidden="true" />
      {t("automation.event_readiness_blocked_badge")}
    </span>
  );
}
