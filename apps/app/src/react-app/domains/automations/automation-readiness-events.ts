/**
 * 任务 2.3b——事件触发自动化"仓库就绪解除阻塞"的跨域信号。
 *
 * TIPS: jugglework-server 在仓库绑定成功后，会给每个登记过的请求发起人各推一条
 * `jw:automation-readiness-unblocked` IM 系统消息（见 jugglework-server
 * services/automation_readiness_requests.go 的 `NotifyReadinessRequesters`）。真正
 * 接住这条 IM 消息的是 jugglechat/store.ts（它本来就订阅着 IM 消息流），但那个模块
 * 不该反过来引入自动化领域的内部结构——跟 den-session-events.ts 同一个理由，两个领域
 * 之间用一个不带具体业务类型的 window 自定义事件解耦，而不是互相 import。
 */
export const automationReadinessUnblockedEvent = "jugglework-automation-readiness-unblocked";

export type AutomationReadinessUnblockedDetail = {
  /** `owner/name` 形式的仓库全名，跟 `AutomationEventTrigger.repository` 拼出来的形式一致。 */
  repository: string;
};

declare global {
  interface WindowEventMap {
    [automationReadinessUnblockedEvent]: CustomEvent<AutomationReadinessUnblockedDetail>;
  }
}

export function dispatchAutomationReadinessUnblocked(detail: AutomationReadinessUnblockedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AutomationReadinessUnblockedDetail>(automationReadinessUnblockedEvent, { detail }));
}
