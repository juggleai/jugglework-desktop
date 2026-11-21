import type { DenCalendarEventCreateInput, DenCalendarSchedulingEventCreateInput } from "@/app/lib/den";
import type { Meeting, MeetingCreate } from "../meeting/types";
import { assertLiveScope, NativeActionError } from "./native-queries";
import type { ChatTarget } from "./native-writes";
import type { NativeActionScope } from "./types";

export type StepStatus = "succeeded" | "failed" | "unknown" | "skipped";
export type ExecutedStep = { name: string; status: StepStatus; error?: string; result?: Record<string, unknown> };

export type ExecuteDeps = {
  liveScope: () => NativeActionScope | null;
  createCalendarEvent: (orgId: string, input: DenCalendarEventCreateInput) => Promise<{ event: { id: string; title: string } }>;
  createSchedulingEvent: (orgId: string, input: DenCalendarSchedulingEventCreateInput) => Promise<{ event: { id: string; title: string } }>;
  createMeeting: (input: MeetingCreate, key: string) => Promise<{ meeting: Meeting }>;
  notifyMeeting: (id: string) => Promise<void>;
  /** Live check that the chat is still reachable by the signed-in user. */
  chatReachable: (target: ChatTarget) => Promise<boolean>;
  sendMessage: (target: ChatTarget, message: { name: string; content: Record<string, unknown>; tid?: string }) => Promise<{ messageId?: string }>;
};

/** Network loss or timeout after the request left: the write may or may not have happened. */
function outcome(error: unknown): { status: "failed" | "unknown"; error: string } {
  const name = (error as { name?: string })?.name;
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError" || error instanceof TypeError)
    return { status: "unknown", error: "结果未确认：请求超时或网络中断，请到对应页面核对，不要重复操作" };
  return { status: "failed", error: message.slice(0, 300) };
}

async function step(name: string, run: () => Promise<Record<string, unknown>>): Promise<ExecutedStep> {
  try { return { name, status: "succeeded", result: await run() }; }
  catch (error) { return { name, ...outcome(error) }; }
}

function meetingCard(meeting: Meeting) {
  return {
    name: "jw:meeting-card",
    content: { schemaVersion: 1, meetingId: meeting.id, orgId: meeting.organizationId, title: meeting.title, code: meeting.code, startAt: meeting.startAt, status: meeting.status, version: meeting.version },
  };
}

/**
 * Runs a confirmed proposal with its frozen payload. The identity is checked
 * before the first step and again before each later one; once something has
 * been written it is never rolled back or retried here.
 */
export async function executeConfirmedProposal(action: string, scope: NativeActionScope, execution: Record<string, unknown>, deps: ExecuteDeps): Promise<ExecutedStep[]> {
  const live = () => assertLiveScope(scope, deps.liveScope());
  try { live(); } catch (error) {
    return [{ name: action, status: "failed", error: error instanceof Error ? error.message : String(error) }];
  }
  if (action === "calendar.create") {
    const key = String(execution.idempotencyKey);
    const input = execution.input as Omit<DenCalendarEventCreateInput, "idempotencyKey">;
    return [await step("calendar.create", async () => {
      const { event } = execution.endpoint === "scheduling"
        ? await deps.createSchedulingEvent(scope.organizationId, { ...(input as Omit<DenCalendarSchedulingEventCreateInput, "idempotencyKey">), idempotencyKey: key })
        : await deps.createCalendarEvent(scope.organizationId, { ...input, idempotencyKey: key });
      return { eventId: event.id, title: event.title };
    })];
  }
  if (action === "im.send") {
    const target = execution.target as ChatTarget;
    return [await step("im.send", async () => {
      if (!(await deps.chatReachable(target))) throw new NativeActionError("chat_unavailable", "收件会话已不可用（已退群、被移出或对方不可见）");
      live();
      const sent = await deps.sendMessage(target, { name: "jg:text", content: { content: String(execution.text) }, tid: String(execution.tid) });
      return { to: target.name, messageId: sent.messageId ?? null };
    })];
  }
  if (action === "meeting.create") {
    const steps: ExecutedStep[] = [];
    let meeting: Meeting | null = null;
    steps.push(await step("meeting.create", async () => {
      ({ meeting } = await deps.createMeeting(execution.input as MeetingCreate, String(execution.idempotencyKey)));
      return { meetingId: meeting!.id, code: meeting!.code, title: meeting!.title, startAt: meeting!.startAt };
    }));
    const shareTo = (execution.shareTo as ChatTarget[] | undefined) ?? [];
    const created = meeting as Meeting | null;
    if (!created) {
      // TIPS: 会议未确认创建时不发任何卡片，避免对方收到一个不存在的会议。
      if (execution.notifyInvitees) steps.push({ name: "meeting.notify", status: "skipped" });
      for (const target of shareTo) steps.push({ name: "meeting.share", status: "skipped", result: { to: target.name } });
      return steps;
    }
    const stillSameUser = () => { try { live(); return true; } catch { return false; } };
    if (execution.notifyInvitees) {
      steps.push(stillSameUser()
        ? await step("meeting.notify", async () => { await deps.notifyMeeting(created.id); return {}; })
        : { name: "meeting.notify", status: "skipped", error: "账号或组织已切换" });
    }
    for (const target of shareTo) {
      if (!stillSameUser()) { steps.push({ name: "meeting.share", status: "skipped", error: "账号或组织已切换", result: { to: target.name } }); continue; }
      const shared = await step("meeting.share", async () => {
        if (!(await deps.chatReachable(target))) throw new NativeActionError("chat_unavailable", "会话已不可用");
        const sent = await deps.sendMessage(target, meetingCard(created));
        return { to: target.name, messageId: sent.messageId ?? null };
      });
      steps.push(shared.status === "succeeded" ? shared : { ...shared, result: { to: target.name } });
    }
    return steps;
  }
  return [{ name: action, status: "failed", error: "不支持的操作" }];
}
