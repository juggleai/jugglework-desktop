// TIPS: 多个入口共享会话提交占用；只覆盖请求准备期，运行期由服务端原有run admission判断。
const preparing = new Set<string>();
/** 同一会话已有提交在准备时拒绝重复提交，返回释放函数。 */
export function claimSessionSubmission(workspaceId: string, sessionId: string) {
  const key = `${workspaceId}\0${sessionId}`;
  if (preparing.has(key)) throw new Error("该任务正在发送，请稍后重试");
  preparing.add(key);
  return () => preparing.delete(key);
}

/** 判断原会话是否已有发送预检，供同一个FIFO的消费者等待。 */
export function isSessionSubmissionPreparing(workspaceId: string, sessionId: string) {
  return preparing.has(`${workspaceId}\0${sessionId}`);
}
