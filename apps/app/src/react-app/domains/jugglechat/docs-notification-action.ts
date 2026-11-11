import type { DesktopDocsNotificationAction } from "@jugglework/types/desktop-ipc";

import type { DocsAccountScope } from "../cloud-docs/docs-card-navigation";
import {
  docsMessageSource,
  type DocsCardPayload,
} from "./docs-message";
import type { ChatMessage } from "./types";

const resource = /^[A-Za-z0-9_-]{1,128}$/;
const pageResource = /^[A-Za-z0-9_-]{1,64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprint = /^\d{1,8}:\d{1,10}$/;
const kinds = new Set([
  "page.user_mention",
  "comment.user_mention",
  "comment.created",
  "comment.resolved",
]);

/** 从宿主绑定过的实时消息构造不含凭据的系统通知点击动作。 */
export function createDocsNotificationAction(
  message: ChatMessage,
): DesktopDocsNotificationAction | null {
  const source = docsMessageSource(message);
  if (!source) return null;
  return {
    type: "docs.open",
    contractVersion: 1,
    source: {
      server: source.scope.server,
      userId: source.scope.userId,
      tenantId: source.scope.tenantId,
      authFingerprint: source.scope.authFingerprint,
    },
    payload: source.payload,
    conversationId: message.conversationId,
  };
}

/** 渲染进程再次校验主进程回传动作，拒绝额外字段、跨租户和任意 URL。 */
export function parseDocsNotificationAction(
  value: unknown,
): DesktopDocsNotificationAction | null {
  if (!value || typeof value !== "object") return null;
  const action = value as DesktopDocsNotificationAction;
  if (
    action.type !== "docs.open" ||
    action.contractVersion !== 1 ||
    !pageResource.test(action.conversationId ?? "") ||
    !action.source ||
    !action.payload
  )
    return null;
  const sourceKeys = Object.keys(action.source);
  const payloadKeys = Object.keys(action.payload);
  if (
    Object.keys(action).some(
      (key) =>
        !["type", "contractVersion", "source", "payload", "conversationId"].includes(
          key,
        ),
    ) ||
    sourceKeys.some(
      (key) =>
        !["server", "userId", "tenantId", "authFingerprint"].includes(key),
    ) ||
    payloadKeys.some(
      (key) =>
        ![
          "contractVersion",
          "eventId",
          "tenantId",
          "pageId",
          "commentId",
          "kind",
          "occurredAt",
          "part",
        ].includes(key),
    )
  )
    return null;
  let server: string;
  try {
    const parsed = new URL(action.source.server);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return null;
    server = parsed.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
  const payload = action.payload;
  if (
    !resource.test(action.source.userId ?? "") ||
    !resource.test(action.source.tenantId ?? "") ||
    !fingerprint.test(action.source.authFingerprint ?? "") ||
    payload.contractVersion !== 1 ||
    payload.tenantId !== action.source.tenantId ||
    !uuid.test(payload.eventId ?? "") ||
    !pageResource.test(payload.pageId ?? "") ||
    (payload.commentId !== undefined &&
      !pageResource.test(payload.commentId ?? "")) ||
    !kinds.has(payload.kind) ||
    typeof payload.occurredAt !== "string" ||
    payload.occurredAt.length > 40 ||
    !Number.isFinite(Date.parse(payload.occurredAt)) ||
    !["group", "direct"].includes(payload.part)
  )
    return null;
  return {
    ...action,
    source: { ...action.source, server },
    payload: { ...payload } as DocsCardPayload,
  };
}

export type DocsNotificationOpenSource = DocsAccountScope;
