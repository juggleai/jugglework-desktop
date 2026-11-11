import { notifyDesktopEvent } from "@/react-app/shell/desktop-notifications";

import { docsMessageSource } from "./docs-message";
import { createDocsNotificationAction } from "./docs-notification-action";
import type { ChatMessage } from "./types";

const delivered = new Map<string, number>();
const maxDelivered = 512;

/** 仅为已绑定当前来源的实时卡片显示系统通知，并按来源＋业务事件去重。 */
export function notifyDocsDesktopMessage(message: ChatMessage): boolean {
  const source = docsMessageSource(message);
  const action = createDocsNotificationAction(message);
  if (!source || !action) return false;
  const key = `${source.scope.key}\0${source.payload.eventId}`;
  if (delivered.has(key)) return false;
  delivered.set(key, Date.now());
  if (delivered.size > maxDelivered) {
    const oldest = delivered.keys().next().value;
    if (oldest) delivered.delete(oldest);
  }
  notifyDesktopEvent({
    type: "docs.collaboration",
    action,
    important:
      source.payload.part === "direct" &&
      source.payload.kind.endsWith("user_mention"),
  });
  return true;
}
