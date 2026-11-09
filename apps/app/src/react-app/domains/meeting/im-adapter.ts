import { juggleChatRuntime } from "../jugglechat/runtime";
import type { ChatMessage } from "../jugglechat/types";
export async function joinMeetingChatroom(
  id: string,
  receive: (message: ChatMessage) => void,
) {
  if (!juggleChatRuntime.isConnected())
    throw new Error("聊天连接尚未就绪，请稍后重试。");
  const client = juggleChatRuntime.getClient();
  const stop = juggleChatRuntime.subscribe(
    "message",
    (message: ChatMessage) => {
      if (
        message.conversationType === 3 &&
        message.conversationId === id &&
        message.name === "jw:meeting-chat"
      )
        receive(message);
    },
  );
  try {
    await client.joinChatroom({ id });
  } catch (error) {
    stop();
    throw error;
  }
  return {
    async send(content: string) {
      return client.sendMessage({
        conversationType: 3,
        conversationId: id,
        name: "jw:meeting-chat",
        content: { content },
      }) as Promise<ChatMessage>;
    },
    async leave() {
      stop();
      await client.quitChatroom({ id });
    },
  };
}

// A row invitation targets only that member; it must not notify the whole group.
export async function sendMeetingInvitation(meeting: import("./types").Meeting, userId: string) {
  if (!juggleChatRuntime.isConnected()) throw new Error("聊天连接尚未就绪，请稍后重试");
  await juggleChatRuntime.getClient().sendMessage({
    conversationType: 1, conversationId: userId, name: "jw:meeting-card",
    content: { schemaVersion: 1, meetingId: meeting.id, orgId: meeting.organizationId,
      title: meeting.title, code: meeting.code, startAt: meeting.startAt,
      status: meeting.status, version: meeting.version },
  });
}
