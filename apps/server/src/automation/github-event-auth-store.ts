import type { GithubEventRelayAuth } from "./github-event-client.js";

/**
 * 进程内存里的一份云端凭据快照，由渲染进程登录后通过本地 `/automations/github-event-auth`
 * 接口推送进来（见 routes/automations.ts）——这是 resolveAuth 的真实生产路径：渲染进程
 * 本来就持有真实登录态，`apps/server` 自己从来不发起登录。不落盘：进程重启后就是空的，
 * 渲染进程会在下一次自己的登录状态确认时重新推送一遍，不需要持久化这份数据。
 */
export class GithubEventAuthStore {
  private current: GithubEventRelayAuth | null = null;

  get(): GithubEventRelayAuth | null {
    return this.current;
  }

  set(auth: GithubEventRelayAuth | null): void {
    this.current = auth;
  }
}
