let activationChain: Promise<void> = Promise.resolve();

/**
 * 串行执行工作区运行时激活
 * @param activate 单次工作区激活操作
 * @returns 当前激活操作的结果
 */
export function serializeWorkspaceActivation<T>(activate: () => Promise<T>): Promise<T> {
  // TIPS: managed OpenCode 被启动恢复、侧边栏和全局会话导航共同使用。
  // 所有入口必须共享同一队列，避免两个 /instance/dispose 交错后让 UI 与运行时指向不同工作区。
  const result = activationChain
    .catch(() => undefined)
    .then(activate);
  activationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
