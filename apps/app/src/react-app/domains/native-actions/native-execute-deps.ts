import { createDenClient, readDenSettings } from "@/app/lib/den";
import { getChatGroupsForContacts, getMembers } from "../jugglechat/api";
import { juggleChatRuntime } from "../jugglechat/runtime";
import { meetingAPI } from "../meeting/api";
import type { ExecuteDeps } from "./native-execute";
import { NativeActionError } from "./native-queries";
import type { NativeActionScope } from "./types";

/** Production wiring for executeConfirmedProposal. */
export function defaultExecuteDeps(liveScope: () => NativeActionScope | null): ExecuteDeps {
  const den = () => {
    const settings = readDenSettings();
    return createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken });
  };
  return {
    liveScope,
    createCalendarEvent: (orgId, input) => den().createCalendarEvent(orgId, input),
    createSchedulingEvent: (orgId, input) => den().createCalendarSchedulingEvent(orgId, input),
    createMeeting: (input, key) => meetingAPI.create(input, key),
    notifyMeeting: (id) => meetingAPI.notify(id),
    async chatReachable(target) {
      if (target.kind === "group") return (await getChatGroupsForContacts()).some((group) => group.id === target.conversationId);
      const { members } = await getMembers();
      return members.some((member) => member.user.imUserId === target.conversationId);
    },
    async sendMessage(target, message) {
      if (!juggleChatRuntime.isConnected()) throw new NativeActionError("chat_not_connected", "聊天连接尚未就绪，请稍后重试");
      const client = juggleChatRuntime.getClient();
      return client.sendMessage({ conversationType: target.conversationType, conversationId: target.conversationId, ...message }) as Promise<{ messageId?: string }>;
    },
  };
}
