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

export function isAutomationEventPushMessage(message: Pick<ChatMessage, "name" | "sender">): boolean {
  return message.name === AUTOMATION_EVENT_IM_MESSAGE_NAME || message.sender?.id === AUTOMATION_EVENT_IM_SENDER_ID;
}
