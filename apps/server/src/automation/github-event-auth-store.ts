import type { GithubEventRelayAuth } from "./github-event-client.js";

/**
 * 进程内存里的一份云端凭据快照，由渲染进程登录后通过本地 `/automations/github-event-auth`
 * 接口推送进来（见 routes/automations.ts）——这是 resolveAuth 的真实生产路径：渲染进程
 * 本来就持有真实登录态，`apps/server` 自己从来不发起登录。不落盘：进程重启后就是空的，
 * 渲染进程会在下一次自己的登录状态确认时重新推送一遍，不需要持久化这份数据。
 */
export class GithubEventAuthStore {
  private current: GithubEventRelayAuth | null = null;
  // TIPS: 任务 6.1（账号切换检测）需要的信号——跟 `current` 分开存，不塞进
  // GithubEventRelayAuth 本身，因为那个类型是直接喂给 github-event-client.ts 拼请求的，
  // 账号 id 不是请求形状的一部分，只是 subscription-sync.ts 用来跟本地记账比对的旁路信息。
  private accountId: string | null = null;

  get(): GithubEventRelayAuth | null {
    return this.current;
  }

  /** 当前推送方所属的账号 id；未登录，或调用方没有一起推送账号 id 时为 null。 */
  getAccountId(): string | null {
    return this.accountId;
  }

  set(auth: GithubEventRelayAuth | null, accountId: string | null = null): void {
    this.current = auth;
    // 登出（auth 为 null）时账号 id 也一并清空，不留旧账号的痕迹。
    this.accountId = auth ? accountId : null;
  }
}
