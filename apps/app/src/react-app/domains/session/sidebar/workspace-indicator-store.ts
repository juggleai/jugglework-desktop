import { create } from "zustand";

import type { WorkspaceSessionIndicator } from "./utils";

type WorkspaceIndicatorStore = {
  localWorkspaceIndicator: WorkspaceSessionIndicator;
  setLocalWorkspaceIndicator: (indicator: WorkspaceSessionIndicator) => void;
};

/**
 * 跨页面共享本地工作区的任务状态圆点。
 *
 * TIPS: 会话页面切到消息/设置时会保留但隐藏；由隐藏的会话侧栏持续聚合状态，
 * 其他页面新挂载的导航栏订阅这里，避免切页后圆点和呼吸动画丢失。
 */
export const useWorkspaceIndicatorStore = create<WorkspaceIndicatorStore>((set) => ({
  localWorkspaceIndicator: null,
  setLocalWorkspaceIndicator: (indicator) => set((state) => (
    state.localWorkspaceIndicator === indicator ? state : { localWorkspaceIndicator: indicator }
  )),
}));

/**
 * 获取本地工作区聚合状态。
 * @returns 当前导航栏应展示的状态
 */
export function useLocalWorkspaceIndicator(): WorkspaceSessionIndicator {
  return useWorkspaceIndicatorStore((state) => state.localWorkspaceIndicator);
}
