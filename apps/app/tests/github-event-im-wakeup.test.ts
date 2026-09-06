import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_EVENT_IM_MESSAGE_NAME,
  AUTOMATION_EVENT_IM_SENDER_ID,
  AUTOMATION_READINESS_UNBLOCKED_IM_MESSAGE_NAME,
  isAutomationEventPushMessage,
  isAutomationReadinessUnblockedMessage,
  parseAutomationReadinessUnblockedPayload,
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
    // 这条系统会话要从会话列表里过滤掉，不能以"[暂不支持的消息]"的样子进用户收件箱。
    expect(store).toContain("AUTOMATION_EVENT_IM_SENDER_ID");
    expect(store).toMatch(/IGNORED_CONVERSATIONS = new Set\(\[[^\]]*AUTOMATION_EVENT_IM_SENDER_ID[^\]]*\]\)/);
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

  test("parseAutomationReadinessUnblockedPayload extracts the repository, and degrades quietly on bad payloads", () => {
    expect(parseAutomationReadinessUnblockedPayload({ content: { content: '{"repository":"juggleai/skillhub"}' } })).toEqual({ repository: "juggleai/skillhub" });
    expect(parseAutomationReadinessUnblockedPayload({ content: { content: "not json" } })).toBeNull();
    expect(parseAutomationReadinessUnblockedPayload({ content: { content: "{}" } })).toBeNull();
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
