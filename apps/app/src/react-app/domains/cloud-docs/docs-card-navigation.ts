import type { ChatMessage } from "../jugglechat/types";
import {
  docsMessageSource,
  type ChatConnectionScope,
  type DocsCardPayload,
} from "../jugglechat/docs-message";

export type DocsAccountScope = Pick<
  ChatConnectionScope,
  "server" | "userId" | "tenantId" | "authFingerprint"
>;
export type DocsPageTarget =
  | { kind: "home" }
  | { kind: "page"; pageId: string; commentId?: string };
const resource = /^[A-Za-z0-9_-]{1,64}$/;

/** 桌面路由只接受原生定位参数，不接受外部 URL、工作区覆盖或可执行动作。 */
export function parseCloudDocsTarget(search: string): DocsPageTarget | null {
  const params = new URLSearchParams(search);
  const pageId = params.get("pageId"),
    commentId = params.get("commentId");
  if (
    params.getAll("pageId").length > 1 ||
    params.getAll("commentId").length > 1
  )
    return null;
  if (pageId === null && commentId === null) return { kind: "home" };
  if (
    !pageId ||
    !resource.test(pageId) ||
    (commentId !== null && !resource.test(commentId))
  )
    return null;
  return { kind: "page", pageId, ...(commentId ? { commentId } : {}) };
}

type Navigation = {
  readAccount: () => DocsAccountScope | null;
  organizations: Array<{ id: string; name: string }>;
  confirmSwitch: (name: string) => boolean | Promise<boolean>;
  switchOrganization: (id: string) => Promise<void>;
  validate: (
    payload: DocsCardPayload & { conversationId: string },
  ) => Promise<{ valid: boolean }>;
  navigate: (path: string) => void;
};

const pendingOpen = new Map<
  string,
  Promise<"opened" | "cancelled" | "source-changed" | "unavailable">
>();

/** 以捕获的来源启动新交接；真实组织切换成功即可使用 Docs，不依赖 IM 是否可用。 */
export async function openDocsCard(
  message: ChatMessage,
  navigation: Navigation,
): Promise<"opened" | "cancelled" | "source-changed" | "unavailable"> {
  const source = docsMessageSource(message);
  if (!source) return "unavailable";
  return openDocsSource(
    source.scope,
    source.payload,
    message.conversationId,
    navigation,
  );
}

/** 使用接收时固定的来源打开系统通知；不依赖当前 IM 全局配置补写来源。 */
export async function openDocsSource(
  sourceScope: DocsAccountScope,
  payload: DocsCardPayload,
  conversationId: string,
  navigation: Navigation,
): Promise<"opened" | "cancelled" | "source-changed" | "unavailable"> {
  const key = `${sourceScope.server}\0${sourceScope.userId}\0${sourceScope.authFingerprint}\0${payload.tenantId}\0${payload.eventId}`;
  const existing = pendingOpen.get(key);
  if (existing) return existing;
  const operation = executeDocsOpen(
    sourceScope,
    payload,
    conversationId,
    navigation,
  );
  pendingOpen.set(key, operation);
  const cleanup = () => {
    if (pendingOpen.get(key) === operation) pendingOpen.delete(key);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

/** 执行单次卡片交接；同一来源事件的并发入口由 openDocsSource 合并。 */
async function executeDocsOpen(
  sourceScope: DocsAccountScope,
  payload: DocsCardPayload,
  conversationId: string,
  navigation: Navigation,
): Promise<"opened" | "cancelled" | "source-changed" | "unavailable"> {
  const sameAccount = (account: DocsAccountScope | null) =>
    !!account &&
    account.server === sourceScope.server &&
    account.userId === sourceScope.userId &&
    account.authFingerprint === sourceScope.authFingerprint;
  let current = navigation.readAccount();
  if (!sameAccount(current)) return "source-changed";
  if (current!.tenantId !== payload.tenantId) {
    const organization = navigation.organizations.find(
      (item) => item.id === payload.tenantId,
    );
    if (!organization) return "unavailable";
    if (!(await navigation.confirmSwitch(organization.name)))
      return "cancelled";
    if (
      !sameAccount(navigation.readAccount()) ||
      navigation.readAccount()?.tenantId !== current!.tenantId
    )
      return "source-changed";
    await navigation.switchOrganization(organization.id);
  }
  current = navigation.readAccount();
  if (!sameAccount(current) || current!.tenantId !== payload.tenantId)
    return "source-changed";
  const result = await navigation.validate({
    ...payload,
    conversationId,
  });
  // TIPS: B 的响应迟到时不能覆盖 C，也不能在新上下文中使用旧 grant。
  if (
    !sameAccount(navigation.readAccount()) ||
    navigation.readAccount()?.tenantId !== current!.tenantId
  )
    return "source-changed";
  if (!result.valid) return "unavailable";
  const query = new URLSearchParams({ pageId: payload.pageId });
  if (payload.commentId) query.set("commentId", payload.commentId);
  navigation.navigate(
    `/cloud-docs/${encodeURIComponent(payload.tenantId)}?${query}`,
  );
  return "opened";
}
