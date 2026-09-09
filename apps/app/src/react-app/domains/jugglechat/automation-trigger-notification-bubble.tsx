/** @jsxImportSource react */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { JuggleWorkServerError, type AutomationEntitySessionMapping } from "@/app/lib/jugglework-server";
import { useOptionalJuggleWorkServer } from "@/react-app/domains/connections/jugglework-server-provider";
import { parseAutomationTriggerNotificationPayload, type AutomationTriggerNotificationPayload } from "./automation-event-message";
import type { ChatMessage } from "./types";

// TIPS: §4.10——resourceType 复用 entity_ref 已有的命名空间（见 automation-event-
// message.ts、jugglework-server 的 githubEventKind），单数 "issue" 不是 "issues"。
export type AutomationTriggerBubbleTemplate = "pull_request" | "issue" | "release" | "message" | "generic";

/** 纯函数，不依赖 React——按 resourceType 选模板，未识别值一律落到通用兜底。 */
export function resolveAutomationTriggerBubbleTemplate(resourceType: string): AutomationTriggerBubbleTemplate {
  if (resourceType === "pull_request") return "pull_request";
  if (resourceType === "issue") return "issue";
  if (resourceType === "release") return "release";
  if (resourceType === "telegram:message" || resourceType === "feishu:message") return "message";
  return "generic";
}

type AutomationTriggerActionClient = {
  getAutomationEntitySession: (automationId: string, entityRef: string) => Promise<{ item: AutomationEntitySessionMapping | null }>;
  getAutomation: (automationId: string) => Promise<{ item: unknown }>;
};

/**
 * "打开会话"：按 (automationId, entityRef) 实时查询 4.8 的归属记录，不用消息里的快照——
 * 这样同一实体的会话按 4.8 规则"毕业"到新会话后，旧消息点开仍然指向当前会话。
 * @returns 可导航的目标；查不到（自动化已删除/归属记录缺失或失效/换了台没跑过这次触发
 *          的设备/任何请求失败）统一返回 null，调用方提示"该会话已不存在"，不区分原因。
 */
export async function resolveOpenConversationTarget(
  client: AutomationTriggerActionClient,
  automationId: string,
  entityRef: string,
): Promise<{ workspaceId: string; sessionId: string } | null> {
  try {
    const { item } = await client.getAutomationEntitySession(automationId, entityRef);
    if (!item || item.status !== "active" || !item.sessionId || !item.workspaceId) return null;
    return { workspaceId: item.workspaceId, sessionId: item.sessionId };
  } catch {
    return null;
  }
}

/** 目标自动化是否还存在——"打开运行记录"/"打开重连入口"用它区分"已删除"和其它失败。 */
export async function automationStillExists(client: AutomationTriggerActionClient, automationId: string): Promise<boolean> {
  try {
    await client.getAutomation(automationId);
    return true;
  } catch (error) {
    if (error instanceof JuggleWorkServerError && error.status === 404) return false;
    // 非 404 的失败（网络问题等）保守当作"还在"，不能让一次瞬时故障误报"已删除"。
    return true;
  }
}

/** 纯函数——按模板 + 负载算出气泡文案，跟渲染分开方便单测。 */
export function bubbleCopy(template: AutomationTriggerBubbleTemplate, payload: AutomationTriggerNotificationPayload) {
  switch (template) {
    case "pull_request":
      return { title: "自动化被触发", subtitle: `${payload.repository ?? ""} · PR ${payload.title ? `「${payload.title}」` : payload.entityRef} ${actionText(payload.action)}`.trim() };
    case "issue":
      return { title: "自动化被触发", subtitle: `${payload.repository ?? ""} · Issue ${payload.title ? `「${payload.title}」` : payload.entityRef} ${actionText(payload.action)}`.trim() };
    case "release":
      return { title: "自动化被触发", subtitle: `${payload.repository ?? ""} · 发布了 ${payload.title || payload.entityRef}` };
    case "message":
      return { title: "自动化被触发", subtitle: `${payload.repository ?? payload.resourceType} · 来自 ${payload.actorLogin ?? "对方"}${payload.excerpt ? `："${payload.excerpt}"` : ""}` };
    default:
      // 通用兜底：resourceType 未匹配到已知模板（含 push、未来新增但气泡未同步的类型），
      // 仍要正常显示，不阻断消息——见 PRD §4.10 的 Exception。
      return { title: "自动化通知", subtitle: payload.title || payload.excerpt || payload.repository || payload.entityRef };
  }
}

function actionText(action?: string): string {
  if (action === "opened") return "已打开";
  if (action === "closed") return "已关闭";
  if (action === "reopened") return "已重新打开";
  if (action === "created" || action === "submitted") return "新评论";
  return action ? `${action}` : "有更新";
}

/**
 * `jw:automation-notification` 消息气泡（§4.10）——按 resourceType 分模板渲染，未识别
 * 值（含 push，尚未有发送侧代码路径，见 tasks.md 3.2）落到通用兜底，不阻断消息显示。
 */
export function AutomationTriggerNotificationBubble({ message }: { message: ChatMessage }) {
  const navigate = useNavigate();
  const store = useOptionalJuggleWorkServer();
  const [pending, setPending] = useState(false);
  const payload = parseAutomationTriggerNotificationPayload(message);

  const client = store?.getSnapshot().juggleworkServerClient ?? null;

  // TIPS: 服务端目前只对 PR/Issue/Release 三种触发发 jw:automation-notification（见
  // jugglework-server tasks.md 3.2），三种都对应"打开会话"这一个动作。"打开运行记录"/
  // "打开重连入口"是给 §4.5/§4.7/§4.9 场景（离线丢弃/频率超限/连接器重连）预留的路由，
  // 那几种发送侧还没实现（同一份 tasks.md 里明确标了未实现，不是这里漏做），消息内容目前
  // 也没有字段区分"通用兜底气泡该走哪个动作"——`resolveOpenConversationTarget`/
  // `automationStillExists` 这两个纯函数已经是那两个动作需要的全部读取逻辑，等发送侧
  // 补上后，把 actionLabel/action 换成按内容字段分支即可，不用重新设计。
  const openConversation = useCallback(async () => {
    if (!payload || !client || pending) return;
    setPending(true);
    try {
      const target = await resolveOpenConversationTarget(client, payload.automationId, payload.entityRef);
      if (!target) {
        toast.error("该会话已不存在");
        return;
      }
      navigate(`/workspace/${encodeURIComponent(target.workspaceId)}/session/${encodeURIComponent(target.sessionId)}`);
    } finally {
      setPending(false);
    }
  }, [client, navigate, payload, pending]);

  // 负载解析失败（不含路由字段）：仍然显示消息，不阻断会话，只是没有可点的动作——
  // 跟通用兜底模板"不阻断消息显示"是同一条原则。
  if (!payload) {
    return <div className="tyn-reply-bubble jw-im-automation-notification"><div className="tyn-reply-text jw-im-automation-notification-body">自动化通知</div></div>;
  }

  const template = resolveAutomationTriggerBubbleTemplate(payload.resourceType);
  const copy = bubbleCopy(template, payload);

  return (
    <div className="tyn-reply-bubble jw-im-automation-notification">
      <div className="tyn-reply-text jw-im-automation-notification-body">
        <div className="jw-im-automation-notification-title">{copy.title}</div>
        <div className="jw-im-automation-notification-subtitle">{copy.subtitle}</div>
        <button type="button" className="jw-im-automation-notification-action" disabled={pending} onClick={() => void openConversation()}>打开会话</button>
      </div>
    </div>
  );
}
