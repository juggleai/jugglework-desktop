import { JuggleWorkServerError, type JuggleWorkServerClient } from "../../../app/lib/jugglework-server";

/**
 * 工作区键的读取与缓存。
 *
 * 键由 JuggleWork 服务端生成并持久化，这里只做读取与去重：同一工作区在维护循环、
 * 会话面板等多个调用点都要用它，但它在一台机器上永不变化，重复取没有意义。
 */

export type WorkspaceMcpKeyClient = Pick<JuggleWorkServerClient, "baseUrl"> & {
  getCloudMcpWorkspaceKey?: JuggleWorkServerClient["getCloudMcpWorkspaceKey"];
};

/** null 表示这台 JuggleWork 服务端没有该路由（旧版本），调用方据此降级。 */
const cache = new Map<string, Promise<string | null>>();

function cacheKey(baseUrl: string, workspaceId: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}::${workspaceId.trim()}`;
}

async function fetchWorkspaceKey(
  client: WorkspaceMcpKeyClient,
  workspaceId: string,
): Promise<string | null> {
  const read = client.getCloudMcpWorkspaceKey;
  if (!read) return null;
  try {
    const result = await read(workspaceId);
    const key = result.workspaceKey.trim();
    return key || null;
  } catch (error) {
    // 只有明确的旧服务端 404 才允许降级为账号级行为。网络、超时、鉴权和 5xx
    // 必须中止本轮 reconcile，保留已有 scoped token，不能扩大能力范围。
    if (error instanceof JuggleWorkServerError && (error.status === 404 || error.code === "not_found")) return null;
    throw error;
  }
}

/**
 * 读取一个工作区的 workspaceKey。
 *
 * @param client JuggleWork 服务端客户端
 * @param workspaceId 工作区 id
 * @returns 工作区键；只有服务端明确不支持时返回 null，其它错误向上抛出
 */
export async function resolveWorkspaceMcpKey(
  client: WorkspaceMcpKeyClient,
  workspaceId: string,
): Promise<string | null> {
  const id = workspaceId.trim();
  if (!id) return null;
  const key = cacheKey(client.baseUrl, id);
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = fetchWorkspaceKey(client, id);
  cache.set(key, pending);
  // 读取失败（含旧版 404）不缓存，让下一次调用重试；成功的值永久缓存。
  void pending.then((value) => {
    if (value === null) cache.delete(key);
  }).catch(() => cache.delete(key));
  return pending;
}

export function resetWorkspaceMcpKeyCacheForTests(): void {
  cache.clear();
}
