export const AUTOMATION_SYNC_STATUS_CHANGED_EVENT = "jugglework:automation-sync-status-changed";
export const AUTOMATION_LOCAL_SYNC_CHANGED_EVENT = "jugglework:automation-local-sync-changed";

/**
 * 云同步是否可用
 *
 * - `signed-out`：未登录或未选择组织，本机任务不需要也不会上传。
 * - `unavailable`：登录了，但服务端没有提供自动化同步能力（例如未开启该功能）。
 * - `ready`：已协商成功，outbox 正常排空。
 */
export type AutomationSyncAvailability = "signed-out" | "unavailable" | "ready";

export type AutomationSyncStatus = {
  availability: AutomationSyncAvailability;
  /** `unavailable` 时的稳定错误码，便于定位是未开启、无权限还是网络问题。 */
  reasonCode?: string;
};

let current: AutomationSyncStatus = { availability: "signed-out" };

/** 读取当前云同步可用性。 */
export function readAutomationSyncStatus(): AutomationSyncStatus {
  return current;
}

/**
 * 写入云同步可用性并广播。
 *
 * TIPS: 同步协商失败时本机执行完全不受影响，但界面上「待同步」会永远停住。把失败原因记下来，
 * 才能把「没有同步目标」和「同步坏了」区分开，而不是让用户对着一个不会变的状态发呆。
 *
 * @param next 最新的可用性状态
 */
export function writeAutomationSyncStatus(next: AutomationSyncStatus): void {
  if (current.availability === next.availability && current.reasonCode === next.reasonCode) return;
  current = next;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTOMATION_SYNC_STATUS_CHANGED_EVENT));
  }
}
