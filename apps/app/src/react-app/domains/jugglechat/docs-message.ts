import type { ChatConversation, ChatMessage } from "./types";

export const DOCS_MESSAGE_NAME = "jw:docs-notification";
const id = /^[A-Za-z0-9_-]{1,64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bot = /^jw_docs_[0-9a-f]{32}$/;
const kinds = new Set([
  "page.user_mention",
  "comment.user_mention",
  "comment.created",
  "comment.resolved",
]);
const fields = new Set([
  "contractVersion",
  "eventId",
  "tenantId",
  "pageId",
  "commentId",
  "kind",
  "occurredAt",
  "part",
]);

export type DocsCardPayload = {
  contractVersion: 1;
  eventId: string;
  tenantId: string;
  pageId: string;
  commentId?: string;
  kind: string;
  occurredAt: string;
  part: "group" | "direct";
};
export type ChatConnectionScope = Readonly<{
  key: string;
  server: string;
  userId: string;
  tenantId: string;
  authFingerprint: string;
  imUserId: string;
}>;
export type DocsConversationContext = {
  tenantId: string;
  botIMUserId: string;
  groupId: string | null;
  groups: Array<{
    conversationId: string;
    managed: boolean;
    currentTenant: boolean;
  }>;
};
export type DocsMessageSource = {
  scope: ChatConnectionScope;
  payload: DocsCardPayload;
};
// TIPS: SDK JSON 无法伪造这个宿主本地 Symbol；对象合并会保留它，序列化和转发不会携带它。
const boundSource = Symbol("jugglework-docs-source");
type BoundMessage = ChatMessage & { [boundSource]?: DocsMessageSource };

/** 解析固定定位卡片，未知版本、URL、任意展示 schema 或非法路径均不启用动作。 */
export function parseDocsCard(
  message: Pick<ChatMessage, "name" | "content">,
): DocsCardPayload | null {
  const c = message.content;
  if (
    message.name !== DOCS_MESSAGE_NAME ||
    !c ||
    Object.keys(c).some((key) => !fields.has(key))
  )
    return null;
  if (
    c.contractVersion !== 1 ||
    typeof c.eventId !== "string" ||
    !uuid.test(c.eventId) ||
    typeof c.tenantId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(c.tenantId) ||
    typeof c.pageId !== "string" ||
    !id.test(c.pageId) ||
    (c.commentId !== undefined &&
      (typeof c.commentId !== "string" || !id.test(c.commentId))) ||
    typeof c.kind !== "string" ||
    !kinds.has(c.kind) ||
    typeof c.occurredAt !== "string" ||
    c.occurredAt.length > 40 ||
    !Number.isFinite(Date.parse(c.occurredAt)) ||
    (c.part !== "group" && c.part !== "direct")
  )
    return null;
  return {
    contractVersion: 1,
    eventId: c.eventId,
    tenantId: c.tenantId,
    pageId: c.pageId,
    ...(c.commentId ? { commentId: c.commentId as string } : {}),
    kind: c.kind,
    occurredAt: c.occurredAt,
    part: c.part,
  };
}

/** 核对源服务分类的完整性，缺页或其他组织响应不当作普通群放行。 */
export function parseDocsConversationContext(
  value: unknown,
  tenantId: string,
  requested: string[],
): DocsConversationContext {
  const c = value as DocsConversationContext;
  if (
    !c ||
    c.tenantId !== tenantId ||
    typeof c.botIMUserId !== "string" ||
    (c.botIMUserId !== "" && !bot.test(c.botIMUserId)) ||
    (c.groupId !== null &&
      (typeof c.groupId !== "string" || !id.test(c.groupId))) ||
    !Array.isArray(c.groups)
  )
    throw new Error("invalid_docs_context");
  const seen = new Set<string>();
  for (const item of c.groups) {
    if (
      !item ||
      !requested.includes(item.conversationId) ||
      seen.has(item.conversationId) ||
      typeof item.managed !== "boolean" ||
      typeof item.currentTenant !== "boolean" ||
      (item.currentTenant && !item.managed)
    )
      throw new Error("invalid_docs_context");
    seen.add(item.conversationId);
  }
  if (seen.size !== requested.length)
    throw new Error("incomplete_docs_context");
  return c;
}

/** 分类整个会话；群名、最新消息类型和 AppKey 都不能替代源归属。 */
export function docsConversationVisible(
  conversation: Pick<ChatConversation, "conversationId" | "conversationType">,
  context: DocsConversationContext | null,
): boolean {
  if (conversation.conversationType === 1)
    return (
      !bot.test(conversation.conversationId) ||
      conversation.conversationId === context?.botIMUserId
    );
  if (conversation.conversationType !== 2) return true;
  const group = context?.groups.find(
    (item) => item.conversationId === conversation.conversationId,
  );
  return !!group && (!group.managed || group.currentTenant);
}

/** 在历史或实时消息进入当前组织状态之前绑定已核对来源；转发消息只保留通用兜底。 */
export function bindDocsMessage(
  message: ChatMessage,
  scope: ChatConnectionScope,
  context: DocsConversationContext | null,
): ChatMessage {
  const result: BoundMessage = { ...message };
  delete result[boundSource];
  const payload = parseDocsCard(message);
  if (
    !context ||
    !payload ||
    payload.tenantId !== scope.tenantId ||
    context.tenantId !== scope.tenantId ||
    message.sender?.id !== context.botIMUserId ||
    message.isSender
  )
    return result;
  const expected =
    payload.part === "group"
      ? message.conversationType === 2 &&
        message.conversationId === context.groupId
      : message.conversationType === 1 &&
        message.conversationId === context.botIMUserId;
  if (expected && docsConversationVisible(message, context))
    result[boundSource] = { scope, payload: Object.freeze(payload) };
  return result;
}

/** 仅取得宿主绑定过的来源，点击时仍须由 Server 和 Docs 重新核对。 */
export function docsMessageSource(message: ChatMessage): DocsMessageSource | null {
  return (message as BoundMessage)[boundSource] ?? null;
}

/** 当前连接／组织内按业务事件去重，保留第一条原生 IM 消息供未读操作使用。 */
export function dedupeDocsMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const source = docsMessageSource(message);
    if (!source) return true;
    const key = `${source.scope.key}\0${source.payload.eventId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
