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

/** 仅绑定接收连接的组织；卡片点击仍需源服务核验真实事件和实际会话。 */
export function bindDocsMessage(message: ChatMessage, scope: ChatConnectionScope): ChatMessage {
  const result: BoundMessage = { ...message };
  delete result[boundSource];
  const payload = parseDocsCard(message);
  const sender = message.sender?.id;
  // TIPS：普通会话不再查询 Docs 分类；格式和连接组织只决定本地候选动作，不授予文档权限。
  if (!payload || payload.tenantId !== scope.tenantId || !sender || !bot.test(sender) || message.isSender) return result;
  const candidate = payload.part === "group"
    ? message.conversationType === 2 && !!message.conversationId
    : message.conversationType === 1 && message.conversationId === sender;
  if (candidate) result[boundSource] = { scope, payload: Object.freeze(payload) };
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
