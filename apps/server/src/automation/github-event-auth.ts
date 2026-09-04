import type { GithubEventRelayAuth } from "./github-event-client.js";

/**
 * TIPS: 这是一个明确临时的开发期直连方案，不是最终接线。真正的生产路径——渲染进程登录后
 * 通过 IPC 把云端 session token + 设备 agent token 推给这个进程——还没做（跟桌面端已有的
 * `.env.development.local` 里 `VITE_DEN_DEV_AUTH_TOKEN` 是同一类"手动喂开发期凭据"的
 * 约定，不是新发明一种）。设备 agent token 目前只有 Electron 主进程的
 * remote-control-cloud-client.mjs 一套挑战应答协议能签发，且是否要复用同一份设备身份还
 * 是给事件触发自动化单独走一遍协议，是一个需要单独决策的架构问题，这次改动没有替它做决定
 * ——见 tasks.md 3.1 的完成说明。
 *
 * 每次调用都重新读环境变量而不是缓存一份快照，这样凭据可以在进程运行期间被替换（比如手动
 * 更新 token 之后不需要重启）而立刻生效，跟 resolveAuth 本身"每次请求都重新解析"的约定
 * 一致。
 */
export function resolveGithubEventAuthFromEnv(): GithubEventRelayAuth | null {
  const baseUrl = (process.env.JUGGLEWORK_GITHUB_EVENT_BASE_URL ?? "").trim();
  const token = (process.env.JUGGLEWORK_GITHUB_EVENT_TOKEN ?? "").trim();
  if (!baseUrl || !token) return null;
  const agentToken = (process.env.JUGGLEWORK_GITHUB_EVENT_AGENT_TOKEN ?? "").trim();
  return { baseUrl, token, ...(agentToken ? { agentToken } : {}) };
}
