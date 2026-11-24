/** 将原生视图的实际路由转换成 Work 的启动目标。 */
export function cloudDocsResumeTarget(content) {
  if (!content) return null;
  return content.docId
    ? { kind: "page", workspaceId: content.workspaceId, pageId: content.docId }
    : { kind: "home" };
}

/** 明确的新深链优先；首页导航可以回到刷新前的实际位置。 */
export function canResumeCloudDocs(actual, requested) {
  if (!actual || !requested || requested.commentId) return false;
  return requested.kind === "home" ||
    (requested.kind === "page" && actual.targetKind === "document" &&
      requested.pageId === actual.docId &&
      requested.workspaceId === actual.workspaceId);
}

/**
 * 在原生分区消费新 grant 并复核旧会话。任何非成功结果均不授权展示。
 * @param {import('electron').Session} nativeSession 原生视图使用的分区
 * @param {string} origin Main 已核对的 Docs 来源
 * @param {{launchGrant:string,instanceId:string,expectedContextId:string,target:{kind:"home"|"page",workspaceId:string,pageId?:string}}} request 本次接管授权和已核对的目标
 */
export async function requestCloudDocsResume(nativeSession, origin, request) {
  try {
    const response = await nativeSession.fetch(new URL("/api/jw/session/resume", origin).href, {
      method: "POST",
      body: JSON.stringify(request),
      headers: { "Content-Type": "application/json", "x-jugglework-docs-context": request.expectedContextId },
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return "fallback";
    const result = await response.json().catch(() => null);
    if (response.status === 200 && result?.outcome === "resumed" && result.grantState === "consumed" &&
      result.instanceId === request.instanceId && result.contextId === request.expectedContextId &&
      result.workspaceId === request.target.workspaceId && result.pageId === (request.target.pageId ?? null)) return "resumed";
    if (response.status === 409 && result?.outcome === "requires_bootstrap" &&
      ["consumed", "not_consumed"].includes(result.grantState)) return "fallback";
    if ([401, 403].includes(response.status) &&
      ["session_invalid", "session_expired", "membership_invalid", "docs_context_changed"].some(
        value => result?.code === value || result?.message === value
      )) return "denied";
    if (response.status === 403 && result?.message === "invalid_docs_grant") return "fallback";
    return "retry";
  } catch {
    return "retry";
  }
}
