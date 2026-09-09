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
 * 一条会话更新的 latestMessage 是不是三种系统消息里该隐藏的那两种——供 store.ts 的
 * `mergeConversations` 判断要不要跳过合并（§4.10：会话本身不再整体过滤，但隐藏消息
 * 的到达不能把这条会话带出来，见 store.ts `isHiddenConversationUpdate` 调用点）。
 *
 * TIPS: 这条判断单独拆出来、能被直接单测，是因为 store.ts 里同名逻辑曾经真的写错过——
 * 之前的实现直接调用 `isAutomationEventPushMessage(latestMessage) ||
 * isAutomationReadinessUnblockedMessage(latestMessage)`，但 `isAutomationEventPushMessage`
 * 的 sender.id 兜底会把 `jw:automation-notification` 也匹配上，导致这条真实可见消息的
 * 会话更新被错误当成"隐藏消息"跳过合并——这条 bug 只有拿一条同时带 name 和 sender.id
 * 的完整消息真的跑一遍这个函数才会暴露，纯读源码断言字符串是否出现看不出来。见
 * §4.10 现场用真实服务端+真实桌面 App 验证时发现并修复。
 */
export function isHiddenAutomationConversationMessage(message: Pick<ChatMessage, "name" | "sender"> | undefined): boolean {
  if (!message) return false;
  if (isAutomationNotificationMessage(message)) return false;
  return isAutomationEventPushMessage(message) || isAutomationReadinessUnblockedMessage(message);
}

/**
 * 从仓库就绪解除阻塞的系统消息里取出仓库全名。
 *
 * TIPS: 字段直接就在 `message.content` 上（`content.repository`），不是嵌套在
 * `content.content` 里再 JSON.parse 一层——这里原来的写法假设 IM vendor SDK 会把
 * `msg_content`（服务端 marshal 出来的 JSON 字符串）包一层塞进 `content.content`，
 * 但拿真实服务端 + 真实桌面 App 验证 §4.10 新增的 `jw:automation-notification`
 * （走同一条 `SendSystemMsg` 通道、同样的服务端 marshal 方式）时发现：SDK 实际上是把
 * 解析后的字段**摊平合并**进 `content` 对象本身，不是包一层。这条消息共用同一条发送
 * 通道，此前从没有用真实消息验证过这个假设，是同一个错误。
 * @param message 完整消息
 * @returns 解析出的 `owner/name`；负载缺失或不是预期形状时返回 null（不是给人看的
 *          聊天消息负载解析失败不该抛错打断消息流，静默忽略即可）
 */
export function parseAutomationReadinessUnblockedPayload(message: Pick<ChatMessage, "content">): { repository: string } | null {
  const repository = message.content?.repository;
  return typeof repository === "string" && repository ? { repository } : null;
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
 *
 * TIPS: 字段直接就在 `message.content` 上，不是嵌套在 `content.content` 里再 JSON.parse
 * 一层——跟 `parseAutomationReadinessUnblockedPayload` 那种"content.content 是一份 JSON
 * 字符串"的写法不一样。IM vendor SDK 会把 `SendSystemMsg` 传的 `msg_content`（服务端
 * marshal 出来的 JSON 字符串）自动解析后**摊平合并**进 `content` 对象本身，不是包一层——
 * 这是拿真实服务端 + 真实桌面 App 完整跑一遍、抓真实消息对象时才发现的：之前照抄
 * readiness-unblocked 那个函数的写法是没有事实依据的假设，两份消息都没有真的用真实
 * 消息验证过这个形状。
 * @param message 完整消息
 * @returns 解析出的负载；缺失路由字段（automationId/entityRef/resourceType/eventType）
 *          时返回 null——这几个字段是气泡渲染和点击路由都依赖的，缺了就没法正常展示，
 *          不是给人看的聊天消息负载解析失败不该抛错打断消息流，静默忽略即可。
 */
export function parseAutomationTriggerNotificationPayload(
  message: Pick<ChatMessage, "content">,
): AutomationTriggerNotificationPayload | null {
  const content = message.content;
  if (!content) return null;
  const automationId = content.automationId;
  const entityRef = content.entityRef;
  const resourceType = content.resourceType;
  const eventType = content.eventType;
  if (typeof automationId !== "string" || !automationId) return null;
  if (typeof entityRef !== "string" || !entityRef) return null;
  if (typeof resourceType !== "string" || !resourceType) return null;
  if (typeof eventType !== "string" || !eventType) return null;
  const optionalString = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
  return {
    automationId, entityRef, resourceType, eventType,
    repository: optionalString(content.repository),
    action: optionalString(content.action),
    actorLogin: optionalString(content.actorLogin),
    title: optionalString(content.title),
    excerpt: optionalString(content.excerpt),
  };
}
