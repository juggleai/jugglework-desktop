import type { GithubEventRelayAuth } from "./github-event-client.js";

/**
 * TIPS: 这是一个明确临时的开发期直连方案，不是最终接线。真正的生产路径——渲染进程登录后
 * 通过 IPC 把云端 session token 推给这个进程——见 `github-event-auth-store.ts` 和
 * `desktop-config-provider.tsx` 的接线，只在那条路径没配置时才退化到这里读环境变量
 * （跟桌面端已有的 `.env.development.local` 里 `VITE_DEN_DEV_AUTH_TOKEN` 是同一类
 * "手动喂开发期凭据"的约定，不是新发明一种）。
 *
 * 每次调用都重新读环境变量而不是缓存一份快照，这样凭据可以在进程运行期间被替换（比如手动
 * 更新 token 之后不需要重启）而立刻生效，跟 resolveAuth 本身"每次请求都重新解析"的约定
 * 一致。
 */
export function resolveGithubEventAuthFromEnv(): GithubEventRelayAuth | null {
  const baseUrl = (process.env.JUGGLEWORK_GITHUB_EVENT_BASE_URL ?? "").trim();
  const token = (process.env.JUGGLEWORK_GITHUB_EVENT_TOKEN ?? "").trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}
