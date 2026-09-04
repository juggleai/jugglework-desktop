// @ts-check
import { createRemoteControlCredentialStore } from "./remote-control-credentials.mjs";
import { createRemoteControlCloudClient } from "./remote-control-cloud-client.mjs";

/**
 * 事件触发自动化的设备身份，复用远程控制已经完成的那份 enrollment——服务端
 * `AuthenticateAgentToken` 只认一个 scope 常量（`desktop-agent:connect`），远程控制
 * 和自动化事件中继本来就是同一个设备身份，不需要另开一套注册流程。
 *
 * TIPS: 这里单独开一份 `createRemoteControlCredentialStore` 实例，且只调用它的
 * 只读方法（`getSigningCredential`，经由 `issueAgentToken` 间接调用）。写路径
 * （`prepareEnrollment`/`completeEnrollment`/`delete`）自始至终只经过
 * `remote-control-agent.mjs` 里那一份原装实例；两份实例并发只读同一份凭据文件是安全的
 * （`remote-control-credentials.mjs` 的 `read`/`getSigningCredential` 不写文件）。
 * 不改 remote-control-agent.mjs 的公开返回值形状，也不新增它的写路径。
 *
 * @param {{
 *   app: import("electron").App,
 *   safeStorage: import("electron").SafeStorage,
 *   platform: "darwin" | "linux",
 *   allowInsecureLoopback: boolean,
 *   fetcher: typeof fetch,
 * }} options
 */
export function createAutomationAgentTokenIssuer({ app, safeStorage, platform, allowInsecureLoopback, fetcher }) {
  const credentialStore = createRemoteControlCredentialStore({ app, safeStorage, platform, allowInsecureLoopback });

  /**
   * 给定当前登录的云端上下文，铸造一枚短期 `desktop-agent:connect` scope 的 agent
   * token。这台设备从没走过远程控制 enrollment 时返回 null——这不是错误，是"这台设备
   * 暂时没有可复用的身份"；调用方（`resolveAuth`）本来就要优雅降级，agentToken 缺省
   * 时轮询/认领/写回继续拒绝，不影响不需要它的方法。
   *
   * @param {{ controlPlaneBaseUrl: string, userId: string, organizationId: string }} scope
   * @returns {Promise<{ accessToken: string, expiresAt: string } | null>}
   */
  async function mint(scope) {
    const controlPlaneBaseUrl = scope?.controlPlaneBaseUrl?.trim();
    const userId = scope?.userId?.trim();
    const organizationId = scope?.organizationId?.trim();
    if (!controlPlaneBaseUrl || !userId || !organizationId) return null;

    try {
      const cloudClient = createRemoteControlCloudClient({
        controlPlaneBaseUrl,
        fetcher,
        allowInsecureLoopback,
      });
      const token = await cloudClient.issueAgentToken({
        credentials: credentialStore,
        context: { controlPlaneBaseUrl, userId, organizationId },
      });
      return { accessToken: token.accessToken, expiresAt: token.expiresAt };
    } catch {
      // Not enrolled for remote control, a context mismatch, or the mint
      // request failed (offline, revoked, etc.) — all resolve to "no agent
      // token available right now", never a thrown error into the caller.
      return null;
    }
  }

  return Object.freeze({ mint });
}
