import type { WorkspaceSessionIndicator } from "@/react-app/domains/session/sidebar/utils";

/**
 * 计算本地工作区导航图标是否需要展示后台任务状态。
 *
 * TIPS: 用户已经处于本地工作区时，侧栏中的具体会话会直接展示执行状态，导航图标再闪烁属于
 * 重复反馈；离开本地工作区后，导航图标才承担跨页面提醒职责。
 *
 * @param indicator 本地工作区聚合状态
 * @param homeActive 当前是否处于工作区页面
 * @param taskScope 当前工作区页展示的任务范围
 */
export function visibleLocalWorkspaceIndicator(
  indicator: WorkspaceSessionIndicator,
  homeActive: boolean | undefined,
  taskScope: "local" | "remote",
): WorkspaceSessionIndicator {
  return homeActive && taskScope === "local" && indicator === "running" ? null : indicator;
}
