import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import {
  automationStillExists,
  bubbleCopy,
  resolveAutomationTriggerBubbleTemplate,
  resolveOpenConversationTarget,
} from "../src/react-app/domains/jugglechat/automation-trigger-notification-bubble";
import type { AutomationTriggerNotificationPayload } from "../src/react-app/domains/jugglechat/automation-event-message";

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function payload(overrides: Partial<AutomationTriggerNotificationPayload> = {}): AutomationTriggerNotificationPayload {
  return {
    automationId: "auto-1", entityRef: "github:pull_request:482", resourceType: "pull_request",
    eventType: "pull_request", ...overrides,
  };
}

// TIPS: §4.10 任务 5——消息气泡按 resourceType 分模板，未识别值落到通用兜底，不阻断
// 消息显示。resourceType 的实际取值是 "issue"（单数），不是 "issues"——见
// automation-trigger-notification-bubble.tsx 顶部 TIPS，跟 jugglework-server 的
// githubEventKind、桌面端 github-event-payload.ts 已有的 entity_ref 约定保持一致。
describe("automation trigger notification bubble — template dispatch (5.1/5.2)", () => {
  test("resolveAutomationTriggerBubbleTemplate maps known resourceType values to dedicated templates", () => {
    expect(resolveAutomationTriggerBubbleTemplate("pull_request")).toBe("pull_request");
    expect(resolveAutomationTriggerBubbleTemplate("issue")).toBe("issue");
    expect(resolveAutomationTriggerBubbleTemplate("release")).toBe("release");
    expect(resolveAutomationTriggerBubbleTemplate("telegram:message")).toBe("message");
    expect(resolveAutomationTriggerBubbleTemplate("feishu:message")).toBe("message");
  });

  test("unrecognized or future resourceType values (including push) fall back to the generic template", () => {
    expect(resolveAutomationTriggerBubbleTemplate("push")).toBe("generic");
    expect(resolveAutomationTriggerBubbleTemplate("issues")).toBe("generic"); // 常见的错误写法，不能被当成 issue 模板
    expect(resolveAutomationTriggerBubbleTemplate("some-future-type-nobody-taught-this-function-yet")).toBe("generic");
    expect(resolveAutomationTriggerBubbleTemplate("")).toBe("generic");
  });

  test("bubbleCopy produces distinct, non-empty copy for each known template", () => {
    const pr = bubbleCopy("pull_request", payload({ repository: "juggleai/skillhub", title: "Fix the thing", action: "opened" }));
    expect(pr.subtitle).toContain("juggleai/skillhub");
    expect(pr.subtitle).toContain("Fix the thing");
    expect(pr.subtitle).toContain("已打开");

    const issue = bubbleCopy("issue", payload({ resourceType: "issue", repository: "juggleai/skillhub", title: "Bug 分诊", action: "created" }));
    expect(issue.subtitle).toContain("Issue");
    expect(issue.subtitle).toContain("Bug 分诊");

    const release = bubbleCopy("release", payload({ resourceType: "release", repository: "juggleai/jugglework-desktop", title: "v2.4.0" }));
    expect(release.subtitle).toContain("发布了");
    expect(release.subtitle).toContain("v2.4.0");

    const message = bubbleCopy("message", payload({ resourceType: "telegram:message", actorLogin: "alice", excerpt: "订单还没到" }));
    expect(message.subtitle).toContain("alice");
    expect(message.subtitle).toContain("订单还没到");
  });

  test("generic fallback still renders a title and subtitle, not blocking message display", () => {
    const fallback = bubbleCopy("generic", payload({ resourceType: "push", title: undefined, excerpt: undefined, repository: "juggleai/skillhub" }));
    expect(fallback.title).toBeTruthy();
    expect(fallback.subtitle).toBeTruthy();

    // 极端情况：连 repository/title/excerpt 都没有，只剩 entityRef——也不能是空字符串。
    const bare = bubbleCopy("generic", payload({ resourceType: "some-unknown-type" }));
    expect(bare.subtitle).toBe("github:pull_request:482");
  });
});

describe("automation trigger notification bubble — click-time action resolution (6.1–6.3)", () => {
  test("resolveOpenConversationTarget returns the live mapping when the session is active", async () => {
    const client = {
      getAutomationEntitySession: async () => ({
        item: { automationId: "a", entityRef: "e", workspaceId: "ws-1", sessionId: "session-1", status: "active" as const, createdAt: 0, lastUsedAt: 0 },
      }),
      getAutomation: async () => ({ item: {} }),
    };
    expect(await resolveOpenConversationTarget(client, "a", "e")).toEqual({ workspaceId: "ws-1", sessionId: "session-1" });
  });

  // 6.1/6.2：两次不同时间点点击，映射被改写（比如按 4.8 的规则毕业到新会话），两次解析
  // 出不同的会话——证明确实是每次点击都实时查询，不是用消息里的某个固定值。
  test("two resolutions against a mutated mapping return different sessions — proves this is a live, click-time lookup", async () => {
    let currentSessionId = "session-old";
    const client = {
      getAutomationEntitySession: async () => ({
        item: { automationId: "a", entityRef: "e", workspaceId: "ws-1", sessionId: currentSessionId, status: "active" as const, createdAt: 0, lastUsedAt: 0 },
      }),
      getAutomation: async () => ({ item: {} }),
    };
    const first = await resolveOpenConversationTarget(client, "a", "e");
    currentSessionId = "session-graduated"; // 模拟 4.8 的会话毕业
    const second = await resolveOpenConversationTarget(client, "a", "e");
    expect(first?.sessionId).toBe("session-old");
    expect(second?.sessionId).toBe("session-graduated");
  });

  test("resolveOpenConversationTarget returns null for all three no-resolvable-session causes, without throwing", async () => {
    // 原因一：归属记录不存在（自动化还在，只是没触发过这个实体）。
    const noMapping = { getAutomationEntitySession: async () => ({ item: null }), getAutomation: async () => ({ item: {} }) };
    expect(await resolveOpenConversationTarget(noMapping, "a", "e")).toBeNull();

    // 原因二：归属记录已失效（4.8 的 invalidateEntitySessionMapping）。
    const invalidMapping = {
      getAutomationEntitySession: async () => ({ item: { automationId: "a", entityRef: "e", workspaceId: "ws-1", sessionId: "s", status: "invalid" as const, createdAt: 0, lastUsedAt: 0 } }),
      getAutomation: async () => ({ item: {} }),
    };
    expect(await resolveOpenConversationTarget(invalidMapping, "a", "e")).toBeNull();

    // 原因三：自动化已被删除，或者是在没跑过这次触发的设备上打开——服务端统一 404，
    // 客户端捕获异常统一返回 null，不崩溃、不向上抛。
    const deleted = {
      getAutomationEntitySession: async () => { throw new JuggleWorkServerError(404, "automation_not_found", "not found"); },
      getAutomation: async () => ({ item: {} }),
    };
    expect(await resolveOpenConversationTarget(deleted, "a", "e")).toBeNull();
  });

  test("automationStillExists distinguishes a genuine 404 (deleted) from other failures (network etc.)", async () => {
    const deleted = { getAutomationEntitySession: async () => ({ item: null }), getAutomation: async () => { throw new JuggleWorkServerError(404, "automation_not_found", "not found"); } };
    expect(await automationStillExists(deleted, "a")).toBe(false);

    const networkError = { getAutomationEntitySession: async () => ({ item: null }), getAutomation: async () => { throw new Error("network down"); } };
    // 非 404 的失败不能误报"已删除"——保守当作"还在"，跟 6.4/6.5 的设计一致。
    expect(await automationStillExists(networkError, "a")).toBe(true);

    const found = { getAutomationEntitySession: async () => ({ item: null }), getAutomation: async () => ({ item: {} }) };
    expect(await automationStillExists(found, "a")).toBe(true);
  });
});

describe("automation trigger notification bubble — wiring into the message renderer", () => {
  test("MESSAGE_NAMES registers jw:automation-notification so it doesn't fall into the unsupported-system-message branch", () => {
    const components = readSource("src/react-app/domains/jugglechat/components.tsx");
    expect(components).toContain('automationNotification: "jw:automation-notification"');
    expect(components).toContain("if (message.name === MESSAGE_NAMES.automationNotification) return <AutomationTriggerNotificationBubble message={message} />;");
    // 必须排在 SUPPORTED_MESSAGE_NAMES 的定义（Object.values(MESSAGE_NAMES)）之前登记，
    // 否则会被判成"不支持"，渲染成一条"消息暂不支持"的灰色分隔行，见 736 行附近的
    // system 判断——这里锁定它确实是 MESSAGE_NAMES 的一员，而不是单独硬编码在别处。
    const namesBlock = components.slice(components.indexOf("const MESSAGE_NAMES ="), components.indexOf("const SUPPORTED_MESSAGE_NAMES ="));
    expect(namesBlock).toContain("automationNotification");
  });

  // TIPS: 拿真实服务端 + 真实桌面 App 走一遍才发现的两个真实问题（不是设计阶段能想到的）：
  // 1) messagePreview 有自己独立的 message.name 分发表，没登记会退回"[暂不支持的消息]"，
  //    跟 MESSAGE_NAMES/SUPPORTED_MESSAGE_NAMES 是两套完全不相关的机制；
  // 2) conversationName 的通讯录查找找不到系统发送方（它不是真实好友/成员），会话列表
  //    标题退回显示原始 sender id，而不是已经注册好的昵称。
  test("messagePreview and conversationName both handle jw:automation-notification instead of falling back to raw ids/unsupported text", () => {
    const components = readSource("src/react-app/domains/jugglechat/components.tsx");
    const previewFn = components.slice(components.indexOf("function messagePreview("), components.indexOf("function ListAddMenu("));
    expect(previewFn).toContain("if (message.name === MESSAGE_NAMES.automationNotification) {");
    expect(previewFn).toContain("parseAutomationTriggerNotificationPayload(message)");
    expect(previewFn).toContain("bubbleCopy(resolveAutomationTriggerBubbleTemplate(payload.resourceType), payload)");

    const nameFn = components.slice(components.indexOf("function conversationName("), components.indexOf("function initials("));
    expect(nameFn).toContain("conversation.latestMessage?.sender?.name");
    // 通讯录查不到时才轮到这条兜底，不能排在通讯录前面——通讯录里的真实姓名应该优先。
    const directoryIndex = nameFn.indexOf("directory?.get(");
    const senderNameIndex = nameFn.indexOf("conversation.latestMessage?.sender?.name");
    expect(directoryIndex).toBeGreaterThan(-1);
    expect(directoryIndex).toBeLessThan(senderNameIndex);
  });
});
