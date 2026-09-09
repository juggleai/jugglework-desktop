import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_EVENT_IM_MESSAGE_NAME,
  AUTOMATION_EVENT_IM_SENDER_ID,
  AUTOMATION_NOTIFICATION_IM_MESSAGE_NAME,
  AUTOMATION_READINESS_UNBLOCKED_IM_MESSAGE_NAME,
  isAutomationEventPushMessage,
  isAutomationNotificationMessage,
  isAutomationReadinessUnblockedMessage,
  isHiddenAutomationConversationMessage,
  parseAutomationReadinessUnblockedPayload,
  parseAutomationTriggerNotificationPayload,
} from "../src/react-app/domains/jugglechat/automation-event-message";

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// TIPS: jugglework-server 在生成一条事件投递后会顺手推一条 IM 系统消息，唯一真正连着 IM
// 的一方是渲染进程（apps/server 从没建立过 IM 连接）——这条消息之前落地就是"[暂不支持的
// 消息]"，桌面端完全没接它，跟自动化能不能提速执行没有任何关系。这次改动补上两件事：
// 1）渲染进程收到这条消息后转发一个"立刻拉一轮"的信号给本地 apps/server；2）这条系统
// 会话从聊天列表里过滤掉，不再以不可读的样子出现在用户收件箱里。
//
// isAutomationEventPushMessage 单独拆到一个没有 DOM 依赖的小文件里（automation-
// event-message.ts），可以直接单测；store.ts/jugglework-server.ts 体量太大、依赖太重
// （IM vendor SDK 在模块顶层就要 window/document），跟 github-event-auth-sync.test.ts
// 同一套约定——读源码断言关键接线点。
describe("automation event IM push → local poll wakeup", () => {
  test("isAutomationEventPushMessage matches by message name or by the fixed system sender id", () => {
    expect(isAutomationEventPushMessage({ name: AUTOMATION_EVENT_IM_MESSAGE_NAME })).toBe(true);
    expect(isAutomationEventPushMessage({ sender: { id: AUTOMATION_EVENT_IM_SENDER_ID } })).toBe(true);
    expect(isAutomationEventPushMessage({ name: AUTOMATION_EVENT_IM_MESSAGE_NAME, sender: { id: AUTOMATION_EVENT_IM_SENDER_ID } })).toBe(true);
    expect(isAutomationEventPushMessage({ name: "TIMTextElem", sender: { id: "member1" } })).toBe(false);
    expect(isAutomationEventPushMessage({})).toBe(false);
  });

  test("the local server client exposes a poll-now method hitting the right endpoint", () => {
    const client = readSource("src/app/lib/jugglework-server.ts");
    expect(client).toContain("notifyGithubEventPushReceived: ()");
    expect(client).toContain('"/automations/github-event-poll-now"');
    expect(client).toMatch(/method: "POST"[\s\S]{0,200}\/automations\/github-event-poll-now|\/automations\/github-event-poll-now"[\s\S]{0,300}method: "POST"/);
  });

  test("the chat store forwards a matching message to the local server instead of treating it as a real chat message", () => {
    const store = readSource("src/react-app/domains/jugglechat/store.ts");
    expect(store).toContain("if (isAutomationEventPushMessage(message)) {");
    expect(store).toContain("void notifyLocalServerOfGithubEventPush();");
    expect(store).toContain("client.notifyGithubEventPushReceived()");
    // 转发之后必须 return，不能再落进正常的消息处理分支（追加进消息列表/计未读/刷会话列表）。
    expect(store).toMatch(/if \(isAutomationEventPushMessage\(message\)\) \{\s*void notifyLocalServerOfGithubEventPush\(\);\s*return;\s*\}/);
    // §4.10 之后，这个会话不再整体从列表里过滤（它现在也发真实要展示的消息）——
    // 过滤规则变成按消息精确判断，见下面 "automation trigger notification" 那组测试。
  });

  test("apps/server exposes pollNow() on the event poller and a route that forwards to it", () => {
    const poller = readSource("../server/src/automation/event-poller.ts");
    expect(poller).toContain("pollNow(): void {");
    const routes = readSource("../server/src/routes/automations.ts");
    expect(routes).toContain('"/automations/github-event-poll-now"');
    expect(routes).toContain("poller.pollNow();");
  });
});

// TIPS: 任务 2.3b——仓库绑定解除阻塞的通知复用同一个系统发送方身份（见
// automation-event-message.ts 顶部新增的 TIPS），所以必须按 name 精确匹配，不能像
// 事件推送唤醒那样接受纯 sender.id 兜底，否则会被上面那条判断先吞掉。
describe("automation readiness-unblocked IM notification → list resume prompt", () => {
  test("isAutomationReadinessUnblockedMessage matches only by exact message name, not by sender id alone", () => {
    expect(isAutomationReadinessUnblockedMessage({ name: AUTOMATION_READINESS_UNBLOCKED_IM_MESSAGE_NAME })).toBe(true);
    expect(isAutomationReadinessUnblockedMessage({ name: AUTOMATION_EVENT_IM_MESSAGE_NAME })).toBe(false);
    expect(isAutomationReadinessUnblockedMessage({})).toBe(false);
  });

  // TIPS: 字段直接在 content 上，不是嵌套的 JSON 字符串——见 automation-event-message.ts
  // 里这个函数的 TIPS：原来的写法是从没被真实消息验证过的错误假设，跟 §4.10 那条消息
  // 共用同一条发送通道，同一个错误，用真实服务端+真实桌面 App 验证时一起发现并改正。
  test("parseAutomationReadinessUnblockedPayload extracts the repository, and degrades quietly on bad payloads", () => {
    expect(parseAutomationReadinessUnblockedPayload({ content: { repository: "juggleai/skillhub" } })).toEqual({ repository: "juggleai/skillhub" });
    expect(parseAutomationReadinessUnblockedPayload({ content: { repository: "" } })).toBeNull();
    expect(parseAutomationReadinessUnblockedPayload({ content: {} })).toBeNull();
    expect(parseAutomationReadinessUnblockedPayload({})).toBeNull();
  });

  test("the chat store checks the readiness-unblocked message before the event-push wakeup, and dispatches a window event instead of treating it as chat", () => {
    const store = readSource("src/react-app/domains/jugglechat/store.ts");
    const readinessIndex = store.indexOf("if (isAutomationReadinessUnblockedMessage(message)) {");
    const pushIndex = store.indexOf("if (isAutomationEventPushMessage(message)) {");
    expect(readinessIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(-1);
    // 必须先判断更具体的那条，理由见上面 describe 块的 TIPS。
    expect(readinessIndex).toBeLessThan(pushIndex);
    expect(store).toContain("dispatchAutomationReadinessUnblocked(payload)");
  });

  test("the automation list listens for the resume event and the readiness badge polls checkGithubEventReadiness", () => {
    const events = readSource("src/react-app/domains/automations/automation-readiness-events.ts");
    expect(events).toContain('export const automationReadinessUnblockedEvent = "jugglework-automation-readiness-unblocked"');

    const badge = readSource("src/react-app/domains/automations/automation-readiness-badge.tsx");
    expect(badge).toContain("client.checkGithubEventReadiness({ owner, name })");
    expect(badge).toContain("automationReadinessUnblockedEvent");

    const page = readSource("src/react-app/domains/automations/automation-page.tsx");
    expect(page).toContain("window.addEventListener(automationReadinessUnblockedEvent, onUnblocked)");
    expect(page).toContain("useEventTriggerReadinessBadge(");
  });
});

// TIPS: §4.10——jw:automation-notification 是第三种共用同一个固定发送方身份的系统消息，
// 但客户端不拦截它，是真实呈现给用户看的会话消息。这里覆盖两类风险：(a) 它自己的判断
// 函数只按 name 精确匹配；(b) isAutomationEventPushMessage 的既有 sender.id 兜底会
// 把它也匹配上——这条不是理论风险，是这次改动过程中实测会命中的真实 bug，见
// automation-event-message.ts 里 isAutomationEventPushMessage 的 TIPS。
describe("automation trigger notification (§4.10) — a real, visible system message", () => {
  test("isAutomationNotificationMessage matches only by exact message name", () => {
    expect(isAutomationNotificationMessage({ name: AUTOMATION_NOTIFICATION_IM_MESSAGE_NAME })).toBe(true);
    expect(isAutomationNotificationMessage({ name: AUTOMATION_EVENT_IM_MESSAGE_NAME })).toBe(false);
    expect(isAutomationNotificationMessage({ name: AUTOMATION_READINESS_UNBLOCKED_IM_MESSAGE_NAME })).toBe(false);
    expect(isAutomationNotificationMessage({})).toBe(false);
  });

  // 9 种组合：3 个消息 name × 3 个判断函数，锁定"每个判断函数只认自己的消息"这件事——
  // 尤其是 isAutomationEventPushMessage 的 sender.id 兜底不能被这次改动波及。
  test("all three message names cross-checked against all three type guards", () => {
    const notification = { name: AUTOMATION_NOTIFICATION_IM_MESSAGE_NAME, sender: { id: AUTOMATION_EVENT_IM_SENDER_ID } };
    const delivery = { name: AUTOMATION_EVENT_IM_MESSAGE_NAME, sender: { id: AUTOMATION_EVENT_IM_SENDER_ID } };
    const readinessUnblocked = { name: AUTOMATION_READINESS_UNBLOCKED_IM_MESSAGE_NAME, sender: { id: AUTOMATION_EVENT_IM_SENDER_ID } };

    expect(isAutomationNotificationMessage(notification)).toBe(true);
    expect(isAutomationNotificationMessage(delivery)).toBe(false);
    expect(isAutomationNotificationMessage(readinessUnblocked)).toBe(false);

    expect(isAutomationReadinessUnblockedMessage(notification)).toBe(false);
    expect(isAutomationReadinessUnblockedMessage(delivery)).toBe(false);
    expect(isAutomationReadinessUnblockedMessage(readinessUnblocked)).toBe(true);

    // isAutomationEventPushMessage 的 sender.id 兜底确实会把另外两种也匹配上——这就是
    // 为什么 store.ts 必须先判断 isAutomationNotificationMessage/isAutomationReadinessUnblockedMessage
    // 再决定要不要调用这个函数，见下面 "dispatch ordering" 那条测试。这里如实断言这个
    // 兜底的真实行为，不是在验证一个"理想中不该发生"的结果。
    expect(isAutomationEventPushMessage(notification)).toBe(true);
    expect(isAutomationEventPushMessage(delivery)).toBe(true);
    expect(isAutomationEventPushMessage(readinessUnblocked)).toBe(true);
  });

  // TIPS: 字段直接就在 content 上，不是嵌套的 JSON 字符串——见 automation-event-message.ts
  // 里 parseAutomationTriggerNotificationPayload 的 TIPS：这是拿真实服务端+真实桌面 App
  // 抓到的真实消息对象改的，之前的写法（content.content 是一份 JSON 字符串）从来没有用
  // 真实消息验证过，实际是错的——IM vendor SDK 会把 msg_content 解析后摊平合并进 content，
  // 不是包一层。
  test("parseAutomationTriggerNotificationPayload extracts routing + summary fields, and degrades quietly on incomplete payloads", () => {
    const full = {
      automationId: "auto-1", entityRef: "github:pull_request:482", resourceType: "pull_request",
      eventType: "pull_request", action: "opened", repository: "juggleai/skillhub",
      actorLogin: "octocat", title: "Fix the thing", excerpt: "looks good to me",
    };
    expect(parseAutomationTriggerNotificationPayload({ content: full })).toEqual(full);
    // 缺路由字段（这里缺 resourceType）时整体判定失败，不是"部分渲染"。
    expect(parseAutomationTriggerNotificationPayload({ content: { automationId: "a", entityRef: "e", eventType: "pull_request" } })).toBeNull();
    expect(parseAutomationTriggerNotificationPayload({ content: {} })).toBeNull();
    expect(parseAutomationTriggerNotificationPayload({ content: undefined as never })).toBeNull();
  });

  test("the chat store treats jw:automation-notification as a real message, not a forwarded wakeup signal", () => {
    const store = readSource("src/react-app/domains/jugglechat/store.ts");
    const readinessIndex = store.indexOf("if (isAutomationReadinessUnblockedMessage(message)) {");
    const notificationIndex = store.indexOf("if (isAutomationNotificationMessage(message)) {");
    const pushIndex = store.indexOf("} else if (isAutomationEventPushMessage(message)) {");
    expect(readinessIndex).toBeGreaterThan(-1);
    expect(notificationIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(-1);
    expect(readinessIndex).toBeLessThan(notificationIndex);
    expect(notificationIndex).toBeLessThan(pushIndex);
    // isAutomationEventPushMessage 必须在 else if 分支里，不能是独立的 if——独立的 if
    // 会让它在消息已经被识别成可见通知之后仍然被调用，而它的 sender.id 兜底会把这条
    // 可见消息也匹配上、错误地转发+return，见上面 "all three message names" 测试。
    expect(store).toMatch(/if \(isAutomationNotificationMessage\(message\)\) \{\s*\/\/[^\n]*\n\s*\} else if \(isAutomationEventPushMessage\(message\)\) \{/);
  });

  test("the conversation list no longer blanket-filters the automation sender id; store.ts delegates the per-message decision instead of reimplementing it", () => {
    const store = readSource("src/react-app/domains/jugglechat/store.ts");
    // IGNORED_CONVERSATIONS 不再整体过滤这个发送方 id——它现在会发真实要展示的消息。
    expect(store).not.toMatch(/IGNORED_CONVERSATIONS = new Set\(\[[^\]]*AUTOMATION_EVENT_IM_SENDER_ID[^\]]*\]\)/);
    expect(store).toContain("isHiddenAutomationConversationMessage(conversation.latestMessage)");
    expect(store).toContain("if (isHiddenConversationUpdate(conversation)) continue;");
  });

  // TIPS: 这条曾经在 store.ts 里直接写错——`isAutomationEventPushMessage(latestMessage) ||
  // isAutomationReadinessUnblockedMessage(latestMessage)`，没有先排除可见通知，导致
  // isAutomationEventPushMessage 的 sender.id 兜底把 jw:automation-notification 自己的会话
  // 更新也判成"隐藏"，会话永远不出现在列表里——用真实服务端 + 真实桌面 App 点击验证时
  // 才暴露出来，因为之前的测试只断言了源码字符串，没有拿一条同时带 name 和 sender.id
  // 的完整消息真的调用一次这个函数。拆到 automation-event-message.ts 后这里能直接调用
  // 真实函数，不再是"看起来对"。
  test("isHiddenAutomationConversationMessage does not classify the visible notification as hidden, even though it shares the hidden messages' sender id", () => {
    const visibleWithSenderId = { name: AUTOMATION_NOTIFICATION_IM_MESSAGE_NAME, sender: { id: AUTOMATION_EVENT_IM_SENDER_ID } };
    expect(isHiddenAutomationConversationMessage(visibleWithSenderId)).toBe(false);

    const wakeSignal = { name: AUTOMATION_EVENT_IM_MESSAGE_NAME, sender: { id: AUTOMATION_EVENT_IM_SENDER_ID } };
    expect(isHiddenAutomationConversationMessage(wakeSignal)).toBe(true);

    const readinessUnblocked = { name: AUTOMATION_READINESS_UNBLOCKED_IM_MESSAGE_NAME, sender: { id: AUTOMATION_EVENT_IM_SENDER_ID } };
    expect(isHiddenAutomationConversationMessage(readinessUnblocked)).toBe(true);

    // 没有 latestMessage（比如置顶/免打扰这类跟消息无关的更新）：不算隐藏，正常合并。
    expect(isHiddenAutomationConversationMessage(undefined)).toBe(false);

    // 一条真实的、非自动化系统消息的普通聊天消息：也不算隐藏。
    expect(isHiddenAutomationConversationMessage({ name: "jg:text", sender: { id: "member1" } })).toBe(false);
  });

  // TIPS: 真实点击验证时发现的第五个问题——两种隐藏消息之前只在实时推送那条路径上被
  // 拦截（"message" 订阅收到就 return），但历史消息加载（打开会话/往上翻）是完全不同的
  // 另一条路径，直接从 IM 拉历史、根本不经过那个拦截点。这条会话过去只发过哑信号，
  // 累积了大量历史消息，会话不再整体过滤之后，用户一打开就看到一堆"消息暂不支持"的
  // 历史哑信号行——这条测试锁定 appendMessages/prependMessages/selectConversation 的
  // 初始加载都在真正过滤，不只是实时推送那一条路径。
  test("history loading (selectConversation's initial fetch, loadEarlierMessages, appendMessages/prependMessages) also filters hidden messages, not just the live push subscription", () => {
    const store = readSource("src/react-app/domains/jugglechat/store.ts");
    expect(store).toContain("function filterVisibleMessages(messages: ChatMessage[]) {");
    expect(store).toContain("return messages.filter((message) => !isHiddenAutomationConversationMessage(message));");
    // appendMessages/prependMessages 内部过滤，覆盖实时推送 + 往上翻历史两条路径。
    expect(store).toContain("for (const message of filterVisibleMessages(incoming)) {");
    // selectConversation 的首次加载是直接 set messages，不经过 appendMessages，得单独过滤。
    expect(store).toContain("messages: filterVisibleMessages(result.messages ?? []),");
  });
});
