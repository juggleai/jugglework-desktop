import type { ChatMessage } from "./types";

// TIPS: "jw-automation-events" 是 jugglework-server 那边固定的系统发送方身份
// （services/automation_event_relay.go 的 automationEventIMSenderID），"jw:automation-event-
// delivery" 是它推送的消息类型（automationEventIMMsgType）——两边各自持有这两个字符串，
// 不经共享包同步，改动任一边都要同步改这里。这条推送本身只是"有新投递了，别等轮询定时器"
// 的唤醒信号，不是给人看的聊天消息，见 jugglechat/store.ts 对它的两处处理：从会话列表里
// 过滤掉（IGNORED_CONVERSATIONS），以及在消息订阅里拦下来转发给本地 apps/server（见
// `isAutomationEventPushMessage` 的调用点）。
//
// 单独拆成这个没有其它依赖的小文件，是为了让这条判断逻辑能被直接单测——`store.ts` 会
// 连带引入 `runtime.ts`，而后者在模块顶层就加载浏览器专用的 IM/通话 vendor SDK，在没有
// DOM 的测试环境里没法安全 import。
export const AUTOMATION_EVENT_IM_SENDER_ID = "jw-automation-events";
export const AUTOMATION_EVENT_IM_MESSAGE_NAME = "jw:automation-event-delivery";
// TIPS: 任务 2.3b——仓库绑定解除阻塞的通知，跟投递唤醒推送用的是同一个固定系统发送方
// （jugglework-server services/automation_readiness_requests.go 的
// `sendSystemMessage` 直接复用了 `automationEventIMSenderID`），所以不能靠 sender.id
// 区分这两种消息，必须按 `name` 精确匹配——见下面 `isAutomationReadinessUnblockedMessage`
// 只判断 name，不像 `isAutomationEventPushMessage` 那样也接受纯 sender.id 匹配。
export const AUTOMATION_READINESS_UNBLOCKED_IM_MESSAGE_NAME = "jw:automation-readiness-unblocked";
// TIPS: §4.10——第三种消息，跟前两种共用同一个固定发送方身份，但客户端不拦截它，是真实
// 呈现给用户看的会话消息。只按 name 精确匹配（不接受 sender.id 兜底），理由见下面
// isAutomationEventPushMessage 的 TIPS：这三种消息现在共用同一个 sender.id，任何一个
// 判断函数如果单靠 sender.id 兜底，就会把其它两种也一并错判进来。
export const AUTOMATION_NOTIFICATION_IM_MESSAGE_NAME = "jw:automation-notification";

/**
 * TIPS: sender.id 兜底匹配是这个判断函数的既有行为（在只有两种系统消息共用一个发送方
 * 身份时是安全的），但 §4.10 引入 `jw:automation-notification` 之后，这条兜底会把新的
 * 可见消息也误判成"该转发去唤醒轮询、不显示"——三种消息现在共用同一个 sender.id，只有
 * name 还能精确区分它们。调用方（store.ts）必须先用 isAutomationNotificationMessage
 * 排除掉可见消息，再调用这个函数，不能指望这个函数自己排除；这里不改掉 sender.id 兜底
 * 本身，是因为不确定历史上是不是有 name 字段缺失、只能靠 sender.id 兜底识别的真实场景。
 */
export function isAutomationEventPushMessage(message: Pick<ChatMessage, "name" | "sender">): boolean {
  return message.name === AUTOMATION_EVENT_IM_MESSAGE_NAME || message.sender?.id === AUTOMATION_EVENT_IM_SENDER_ID;
}

/**
 * `jw:automation-notification`（§4.10 新增的真实可见消息）判断。只按 name 精确匹配，
 * 理由同 isAutomationReadinessUnblockedMessage。
 */
export function isAutomationNotificationMessage(message: Pick<ChatMessage, "name">): boolean {
  return message.name === AUTOMATION_NOTIFICATION_IM_MESSAGE_NAME;
}

/**
 * 仓库就绪解除阻塞的系统消息判断。TIPS: 只按 `name` 精确匹配（不像上面那个接受
 * sender.id 兜底）——两种消息共用同一个系统发送方身份，纯按 sender 匹配会把这条也
 * 误判成"该转发去唤醒轮询"，让 store.ts 的分支顺序必须先判它、再判事件推送那条。
 */
export function isAutomationReadinessUnblockedMessage(message: Pick<ChatMessage, "name">): boolean {
  return message.name === AUTOMATION_READINESS_UNBLOCKED_IM_MESSAGE_NAME;
}

/**
 * 从仓库就绪解除阻塞的系统消息里取出仓库全名。
 * @param message 完整消息（只用得到 `content.content` 这一份 JSON 字符串负载）
 * @returns 解析出的 `owner/name`；负载缺失或不是预期形状时返回 null（不是给人看的
 *          聊天消息负载解析失败不该抛错打断消息流，静默忽略即可）
 */
export function parseAutomationReadinessUnblockedPayload(message: Pick<ChatMessage, "content">): { repository: string } | null {
  const raw = message.content?.content;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as { repository?: unknown };
    return typeof parsed.repository === "string" && parsed.repository ? { repository: parsed.repository } : null;
  } catch {
    return null;
  }
}

/** `jw:automation-notification` 的消息内容——跟服务端 automationTriggerNotificationIMContent 一一对应（§4.10）。 */
export type AutomationTriggerNotificationPayload = {
  automationId: string;
  entityRef: string;
  resourceType: string;
  repository?: string;
  eventType: string;
  action?: string;
  actorLogin?: string;
  title?: string;
  excerpt?: string;
};

/**
 * 从 `jw:automation-notification` 消息里取出摘要级内容，供消息气泡渲染用。
 * @param message 完整消息（只用得到 `content.content` 这一份 JSON 字符串负载）
 * @returns 解析出的负载；缺失路由字段（automationId/entityRef/resourceType/eventType）
 *          时返回 null——这几个字段是气泡渲染和点击路由都依赖的，缺了就没法正常展示，
 *          不是给人看的聊天消息负载解析失败不该抛错打断消息流，静默忽略即可。
 */
export function parseAutomationTriggerNotificationPayload(
  message: Pick<ChatMessage, "content">,
): AutomationTriggerNotificationPayload | null {
  const raw = message.content?.content;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AutomationTriggerNotificationPayload>;
    if (!parsed.automationId || !parsed.entityRef || !parsed.resourceType || !parsed.eventType) return null;
    return {
      automationId: parsed.automationId,
      entityRef: parsed.entityRef,
      resourceType: parsed.resourceType,
      eventType: parsed.eventType,
      repository: parsed.repository,
      action: parsed.action,
      actorLogin: parsed.actorLogin,
      title: parsed.title,
      excerpt: parsed.excerpt,
    };
  } catch {
    return null;
  }
}
