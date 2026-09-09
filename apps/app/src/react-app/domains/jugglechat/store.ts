import { create } from "zustand";

import { readDenIMLoginBootstrap, readDenSettings, type DenUser } from "@/app/lib/den";
import { createJuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { resolveJuggleWorkConnection } from "@/react-app/shell/jugglework-connection";
import { getChatGroupsForContacts, getMembers } from "./api";
import {
  isAutomationEventPushMessage,
  isAutomationNotificationMessage,
  isAutomationReadinessUnblockedMessage,
  parseAutomationReadinessUnblockedPayload,
} from "./automation-event-message";
import { dispatchAutomationReadinessUnblocked } from "@/react-app/domains/automations/automation-readiness-events";
import { juggleChatRuntime } from "./runtime";
import { startJuggleChatSkillBridge } from "./skill-bridge";
import type { ChatContact, ChatConversation, ChatMessage, ChatReaction, ChatUser, ChatView } from "./types";

type ConnectionStatus = "idle" | "initializing" | "signed-out" | "connecting" | "connected" | "disconnected" | "error";

type JuggleChatState = {
  status: ConnectionStatus;
  error: string | null;
  user: ChatUser | null;
  view: ChatView;
  conversations: ChatConversation[];
  activeConversation: ChatConversation | null;
  messages: ChatMessage[];
  messagesFinished: boolean;
  contacts: ChatContact[];
  groups: ChatContact[];
  totalUnreadCount: number;
  loadingConversations: boolean;
  conversationsInitialized: boolean;
  loadingMessages: boolean;
  loadingContacts: boolean;
  sending: boolean;
  uploadProgress: number | null;
  replyTo: ChatMessage | null;
  pinnedMessage: { message: ChatMessage; operator?: Partial<ChatUser>; createdTime?: number } | null;
  bootstrapped: boolean;
  setView: (view: ChatView) => void;
  bootstrap: (identity?: DenUser | null) => Promise<void>;
  acceptLogin: (user: ChatUser) => Promise<void>;
  loadConversations: () => Promise<void>;
  refreshTotalUnreadCount: () => Promise<void>;
  selectConversation: (conversation: ChatConversation, options?: { loadHistory?: boolean }) => Promise<void>;
  loadEarlierMessages: () => Promise<void>;
  loadContacts: () => Promise<void>;
  openContact: (contact: ChatContact) => Promise<void>;
  sendText: (content: string, mentionInfo?: ChatMessage["mentionInfo"]) => Promise<void>;
  sendFile: (file: File) => Promise<void>;
  recallMessage: (message: ChatMessage) => Promise<void>;
  removeMessage: (message: ChatMessage) => Promise<void>;
  toggleReaction: (message: ChatMessage, reactionId: string) => Promise<void>;
  favoriteMessage: (message: ChatMessage) => Promise<void>;
  translateMessage: (message: ChatMessage) => Promise<void>;
  editMessage: (message: ChatMessage, content: string) => Promise<void>;
  resendMessage: (message: ChatMessage) => Promise<void>;
  pinMessage: (message: ChatMessage, isTop?: boolean) => Promise<void>;
  setReplyTo: (message: ChatMessage | null) => void;
  clearError: () => void;
};

// TIPS: 这条系统会话（jugglework-server 事件中继推送唤醒信号的固定发送方身份，见
// automation-event-message.ts 顶部注释）连同其它系统会话（好友申请、动态通知）一起从会话
// 列表里过滤掉，不让它以"[暂不支持的消息]"这种不可读的样子出现在用户的收件箱里。
// TIPS: §4.10——jw-automation-events 这个系统会话不再整体过滤（以前在这——见迁移前的
// AUTOMATION_EVENT_IM_SENDER_ID 那一项），因为它现在会发一种真实要展示的消息
// （jw:automation-notification）。改成在 mergeConversations 里按 latestMessage 精确
// 判断要不要跳过合并，见那里的 TIPS。
const IGNORED_CONVERSATIONS = new Set(["friend_apply", "post_ntf", ""]);
let subscriptionsStarted = false;

function messageKey(message: ChatMessage) {
  return message.messageId || message.tid || `${message.sentTime ?? 0}:${message.sender?.id ?? ""}`;
}

function messageIndex(messages: ChatMessage[], target: ChatMessage) {
  return messages.findIndex((message) => {
    if (target.messageId && message.messageId === target.messageId) return true;
    if (target.tid && message.tid === target.tid) return true;
    return !target.messageId && !target.tid && messageKey(message) === messageKey(target);
  });
}

function mergeMessage(current: ChatMessage, incoming: ChatMessage): ChatMessage {
  return {
    ...current,
    ...incoming,
    content: { ...current.content, ...incoming.content },
    localUrl: incoming.localUrl ?? current.localUrl,
  };
}

function hasMessageIdentity(message?: ChatMessage | null): message is ChatMessage {
  return Boolean(message?.name && message.conversationId && (message.messageId || message.tid));
}

function getImageDimensions(url: string) {
  return new Promise<{ width?: number; height?: number }>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    image.onerror = () => resolve({});
    image.src = url;
  });
}

function getVideoMetadata(url: string) {
  return new Promise<{ width?: number; height?: number; duration?: number }>((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => resolve({
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
      duration: Number.isFinite(video.duration) ? video.duration : undefined,
    });
    video.onerror = () => resolve({});
    video.src = url;
  });
}

function isSameConversation(a: Pick<ChatConversation, "conversationId" | "conversationType"> | null, b: Pick<ChatConversation, "conversationId" | "conversationType"> | null) {
  return Boolean(a && b && a.conversationId === b.conversationId && a.conversationType === b.conversationType);
}

function hasConversationIdentity(value?: Partial<ChatConversation> | null): value is ChatConversation {
  return Boolean(value?.conversationId && typeof value.conversationType === "number");
}

function syncActiveConversation(activeConversation: ChatConversation | null, conversations: ChatConversation[]) {
  if (!activeConversation) return null;
  const updated = conversations.find((conversation) => isSameConversation(conversation, activeConversation));
  return updated ? { ...activeConversation, ...updated } : activeConversation;
}

function appendMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const messages = [...current];
  for (const message of incoming) {
    const index = messageIndex(messages, message);
    if (index >= 0) messages[index] = mergeMessage(messages[index], message);
    else messages.push(message);
  }
  return messages;
}

function prependMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const existing = [...current];
  const history: ChatMessage[] = [];
  for (const message of incoming) {
    const currentIndex = messageIndex(existing, message);
    if (currentIndex >= 0) {
      existing[currentIndex] = mergeMessage(existing[currentIndex], message);
      continue;
    }
    const historyIndex = messageIndex(history, message);
    if (historyIndex >= 0) history[historyIndex] = mergeMessage(history[historyIndex], message);
    else history.push(message);
  }
  return [...history, ...existing];
}

function releaseLocalMediaUrls(messages: ChatMessage[]) {
  const urls = new Set(messages.map((message) => message.localUrl).filter((url): url is string => Boolean(url?.startsWith("blob:"))));
  for (const url of urls) URL.revokeObjectURL(url);
}

// TIPS: §4.10——jw-automation-events 的会话本身不再整体过滤，但它的两种隐藏消息
// （jw:automation-event-delivery/jw:automation-readiness-unblocked）到达时推来的会话
// 更新仍然不能带着这条会话（连带它的原始内容预览）冒出来。这条更新的 latestMessage 正好
// 是判断依据——命中隐藏消息判断函数就跳过这次合并，跟没收到过这次更新一样；没有
// latestMessage（比如置顶/免打扰这类跟消息无关的字段变化）或者是可见消息就正常合并。
function isHiddenConversationUpdate(conversation: ChatConversation): boolean {
  const latestMessage = conversation.latestMessage;
  if (!latestMessage) return false;
  return isAutomationEventPushMessage(latestMessage) || isAutomationReadinessUnblockedMessage(latestMessage);
}

function mergeConversations(current: ChatConversation[], incoming: ChatConversation[], currentUserId?: string) {
  const map = new Map(current.map((conversation) => [`${conversation.conversationType}:${conversation.conversationId}`, conversation]));
  for (const conversation of incoming) {
    if (!conversation.conversationId || conversation.conversationId === currentUserId || IGNORED_CONVERSATIONS.has(conversation.conversationId)) continue;
    if (isHiddenConversationUpdate(conversation)) continue;
    const key = `${conversation.conversationType}:${conversation.conversationId}`;
    map.set(key, { ...map.get(key), ...conversation });
  }
  return [...map.values()].sort((a, b) => {
    const top = Number(Boolean(b.isTop)) - Number(Boolean(a.isTop));
    return top || (b.sortTime ?? b.latestMessage?.sentTime ?? 0) - (a.sortTime ?? a.latestMessage?.sentTime ?? 0);
  });
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object") {
    const value = error as { error?: { msg?: string; message?: string }; message?: string; msg?: string };
    return value.error?.message ?? value.error?.msg ?? value.message ?? value.msg ?? "Chat 操作失败";
  }
  return String(error || "Chat 操作失败");
}

/** 把事件触发自动化的 IM 唤醒推送转发给本地 apps/server；见调用点的 TIPS。 */
async function notifyLocalServerOfGithubEventPush(): Promise<void> {
  try {
    const connection = await resolveJuggleWorkConnection();
    if (!connection.normalizedBaseUrl || !connection.resolvedHostToken) return;
    const client = createJuggleWorkServerClient({
      baseUrl: connection.normalizedBaseUrl,
      token: connection.resolvedToken,
      hostToken: connection.resolvedHostToken,
    });
    await client.notifyGithubEventPushReceived();
  } catch {
    // 静默忽略——见调用点 TIPS，这条推送只是可选的提速信号。
  }
}

function startSubscriptions() {
  if (subscriptionsStarted) return;
  subscriptionsStarted = true;
  juggleChatRuntime.subscribe("state", ({ state, error }: { state: number; error?: { code?: number; message?: string } }) => {
    if (state === 0) {
      useJuggleChatStore.setState({ status: "connected", error: null });
      void useJuggleChatStore.getState().refreshTotalUnreadCount();
    } else if (state === 1 || state === 6) {
      useJuggleChatStore.setState({ status: "connecting" });
    } else if (state === 2 || state === 3) {
      const unauthorized = [11005, 11006, 11011, 11012].includes(Number(error?.code));
      if (unauthorized) {
        useJuggleChatStore.setState({ status: "error", error: "IM 登录状态已失效，请重新登录 JuggleWork" });
      } else {
        useJuggleChatStore.setState({ status: "disconnected", error: error?.message ?? null });
      }
    }
  });
  juggleChatRuntime.subscribe("message", (message: ChatMessage) => {
    if (message.isStatus) return;
    // TIPS: jugglework-server 事件中继在生成一条投递后，会顺手往这台设备的 IM 账号推一条
    // 这个类型的系统消息（见 automation-event-message.ts 顶部注释）——它不是给人
    // 看的聊天消息，不进消息列表、不算未读，只在这里被拦下来转发给本地 apps/server，让它的
    // 事件轮询器跳过剩余等待、立刻拉一轮真实投递。转发失败（apps/server 还没起来、这次改动
    // 之前的旧版本没有这个端点……）只静默忽略——轮询器本来就会在最多一个轮询周期内自己发现
    // 这条投递，这条推送只是个可选的提速信号，不是这条链路的正确性依赖。
    // TIPS: 任务 2.3b——这条判断必须排在事件推送唤醒判断之前。两种系统消息共用同一个
    // 固定发送方身份，事件推送那条的匹配规则接受"仅 sender.id 匹配"兜底，顺序反过来
    // 会让这条也被误判成"该转发去唤醒轮询"，永远走不到下面这个分支。
    if (isAutomationReadinessUnblockedMessage(message)) {
      const payload = parseAutomationReadinessUnblockedPayload(message);
      if (payload) dispatchAutomationReadinessUnblocked(payload);
      return;
    }
    // TIPS: §4.10——jw:automation-notification 是真实要展示的消息，必须在
    // isAutomationEventPushMessage 之前判断、且判断为真时不能 return。isAutomationEventPushMessage
    // 的 sender.id 兜底会把这条也匹配上（三种系统消息现在共用同一个 sender.id），
    // 用 else if 让它在已经识别成可见通知时完全不被调用，而不是指望它自己排除——
    // 这条消息该走下面普通消息的处理路径（追加进消息列表/计未读/刷新会话列表）。
    if (isAutomationNotificationMessage(message)) {
      // 不特殊处理，直接落进下面的普通消息分支。
    } else if (isAutomationEventPushMessage(message)) {
      void notifyLocalServerOfGithubEventPush();
      return;
    }
    const state = useJuggleChatStore.getState();
    if (isSameConversation(state.activeConversation, message)) {
      useJuggleChatStore.setState({ messages: appendMessages(state.messages, [message]) });
      void juggleChatRuntime.clearUnread(state.activeConversation!).then(() => state.refreshTotalUnreadCount());
    } else {
      void state.refreshTotalUnreadCount();
    }
    void state.loadConversations();
  });
  juggleChatRuntime.subscribe("conversation", ({ conversations = [] }: { conversations?: ChatConversation[] }) => {
    const state = useJuggleChatStore.getState();
    const merged = mergeConversations(state.conversations, conversations, state.user?.id);
    useJuggleChatStore.setState({
      conversations: merged,
      activeConversation: syncActiveConversation(state.activeConversation, merged),
    });
  });
  const updateMessage = (message: ChatMessage) => {
    const state = useJuggleChatStore.getState();
    if (isSameConversation(state.activeConversation, message)) {
      useJuggleChatStore.setState({ messages: appendMessages(state.messages, [message]) });
    }
  };
  juggleChatRuntime.subscribe("message-recalled", (notify: ChatMessage) => {
    const state = useJuggleChatStore.getState();
    if (!isSameConversation(state.activeConversation, notify)) return;
    const recalledId = String((notify.content as { messageId?: string } | undefined)?.messageId ?? "");
    useJuggleChatStore.setState({
      messages: state.messages.map((message) => message.messageId === recalledId
        ? { ...notify, name: "jg:recallinfo", messageId: recalledId || notify.messageId }
        : message),
    });
  });
  juggleChatRuntime.subscribe("message-updated", updateMessage);
  juggleChatRuntime.subscribe("message-reaction-changed", (notify: ChatMessage & { reactions?: ChatReaction[] }) => {
    const state = useJuggleChatStore.getState();
    if (!isSameConversation(state.activeConversation, notify)) return;
    const messages = state.messages.map((message) => {
      if (message.messageId !== notify.messageId) return message;
      const reactions = { ...(message.reactions ?? {}) };
      for (const item of notify.reactions ?? []) {
        const list = [...(reactions[item.key] ?? [])];
        const index = list.findIndex((reaction) => reaction.value === item.value);
        if (item.isRemove) {
          if (index >= 0) list.splice(index, 1);
        } else if (index < 0) {
          list.push(item);
        }
        if (list.length) reactions[item.key] = list;
        else delete reactions[item.key];
      }
      return { ...message, reactions };
    });
    useJuggleChatStore.setState({ messages });
  });
  const updateStream = (payload: { message?: ChatMessage; messageId?: string; content?: string }, complete: boolean) => {
    const incoming = payload.message ?? payload as unknown as ChatMessage;
    const id = incoming.messageId || payload.messageId;
    if (!id) return;
    const content = typeof incoming.content?.content === "string" ? incoming.content.content : String(payload.content ?? "");
    const state = useJuggleChatStore.getState();
    if (incoming.conversationId && !isSameConversation(state.activeConversation, incoming)) return;
    useJuggleChatStore.setState({
      messages: state.messages.map((message) => message.messageId === id
        ? { ...message, streamMsg: { isEnd: complete, streams: content } }
        : message),
    });
  };
  juggleChatRuntime.subscribe("stream-appended", (payload) => updateStream(payload, false));
  juggleChatRuntime.subscribe("stream-completed", (payload) => updateStream(payload, true));
  juggleChatRuntime.subscribe("message-read", (notify: { conversationId?: string; conversationType?: number; messages?: Array<{ messageId?: string; msgId?: string; readCount?: number; unreadCount?: number }>; senderId?: string; readTime?: number }) => {
    const state = useJuggleChatStore.getState();
    if (!isSameConversation(state.activeConversation, notify as ChatConversation)) return;
    const reads = new Map((notify.messages ?? []).map((item) => [item.messageId || item.msgId, item]));
    useJuggleChatStore.setState({ messages: state.messages.map((message) => {
      const read = reads.get(message.messageId);
      if (!read) return message;
      if (message.conversationType === 2) return { ...message, readCount: Number(read.readCount) || 0, unreadCount: Number(read.unreadCount) || 0 };
      const lifeTime = Number(message.lifeTimeAfterRead) || 0;
      return { ...message, isRead: true, ...(lifeTime > 0 ? { destroyTime: lifeTime + Number(notify.readTime || Date.now()), lifeCountdownTime: lifeTime } : {}) };
    }) });
  });
  juggleChatRuntime.subscribe("message-removed", (notify: { messages?: ChatMessage[]; messageIds?: string[] }) => {
    const ids = new Set([...(notify.messageIds ?? []), ...(notify.messages ?? []).map((message) => message.messageId || "")]);
    if (ids.size) {
      const messages = useJuggleChatStore.getState().messages;
      releaseLocalMediaUrls(messages.filter((message) => ids.has(message.messageId || "")));
      useJuggleChatStore.setState({ messages: messages.filter((message) => !ids.has(message.messageId || "")) });
    }
  });
  juggleChatRuntime.subscribe("message-set-top", (notify: { message?: ChatMessage; isTop?: boolean; operator?: Partial<ChatUser>; createdTime?: number }) => {
    const state = useJuggleChatStore.getState();
    const conversation = state.activeConversation;
    if (!conversation) return;
    if (!notify.isTop) {
      if (notify.message && !isSameConversation(conversation, notify.message)) return;
      useJuggleChatStore.setState({ pinnedMessage: null });
      return;
    }
    if (!notify.message || !isSameConversation(conversation, notify.message)) return;
    void juggleChatRuntime.getTopMessage(conversation).then((result) => {
      useJuggleChatStore.setState({ pinnedMessage: hasMessageIdentity(result.message) ? { message: result.message, operator: result.operator, createdTime: result.createdTime } : null });
    });
  });
  window.addEventListener("jugglechat:unauthorized", () => {
    useJuggleChatStore.setState({ status: "error", error: "IM 登录状态已失效，请重新登录 JuggleWork" });
  });
}

export const useJuggleChatStore = create<JuggleChatState>((set, get) => ({
  status: "idle",
  error: null,
  user: null,
  view: "conversations",
  conversations: [],
  activeConversation: null,
  messages: [],
  messagesFinished: false,
  contacts: [],
  groups: [],
  totalUnreadCount: 0,
  loadingConversations: false,
  conversationsInitialized: false,
  loadingMessages: false,
  loadingContacts: false,
  sending: false,
  uploadProgress: null,
  replyTo: null,
  pinnedMessage: null,
  bootstrapped: false,

  setView(view) {
    set({ view });
    if (view === "contacts" && !get().contacts.length) void get().loadContacts();
  },

  async bootstrap(identity) {
    if (!get().bootstrapped) {
      set({ bootstrapped: true });
      startSubscriptions();
      startJuggleChatSkillBridge();
    }
    const settings = readDenSettings();
    const im = readDenIMLoginBootstrap();
    if (!settings.authToken) {
      if (get().user) juggleChatRuntime.reset();
      releaseLocalMediaUrls(get().messages);
      set({
        status: "signed-out",
        user: null,
        conversations: [],
        conversationsInitialized: false,
        activeConversation: null,
        messages: [],
        contacts: [],
        groups: [],
        totalUnreadCount: 0,
        messagesFinished: false,
        pinnedMessage: null,
        replyTo: null,
        error: null,
      });
      return;
    }
    if (!im) {
      if (get().user) juggleChatRuntime.reset();
      releaseLocalMediaUrls(get().messages);
      set({
        status: "error",
        user: null,
        conversations: [],
        conversationsInitialized: false,
        activeConversation: null,
        messages: [],
        messagesFinished: false,
        contacts: [],
        groups: [],
        totalUnreadCount: 0,
        pinnedMessage: null,
        replyTo: null,
        error: "当前 JuggleWork 登录状态缺少 IM 凭据，请退出后重新登录",
      });
      return;
    }
    const user: ChatUser = {
      id: im.imUserId,
      token: im.token,
      authorization: `Bearer ${settings.authToken}`,
      name: identity?.name || identity?.account || identity?.email || im.imUserId,
      portrait: identity?.avatar || undefined,
      isUsed: true,
    };
    const currentUser = get().user;
    const usesSameIMCredential = currentUser?.id === user.id && currentUser.token === user.token;
    if (usesSameIMCredential && juggleChatRuntime.isConnected()) {
      set({ user, status: "connected", error: null });
      if (!get().conversationsInitialized) await get().loadConversations();
      return;
    }
    if (currentUser && !usesSameIMCredential) juggleChatRuntime.reset();
    set({ status: "initializing", user });
    try {
      await juggleChatRuntime.connect(user);
      set({ status: "connected", error: null });
      await get().loadConversations();
    } catch (error) {
      set({ status: "error", error: errorMessage(error) });
    }
  },

  async acceptLogin(user) {
    set({ user, status: "connecting", error: null });
    try {
      await juggleChatRuntime.connect(user);
      set({ status: "connected" });
      await get().loadConversations();
    } catch (error) {
      set({ status: "error", error: errorMessage(error) });
      throw error;
    }
  },

  async loadConversations() {
    if (!get().user || !juggleChatRuntime.isConnected()) return;
    set({ loadingConversations: true });
    try {
      const result = await juggleChatRuntime.getConversations({ time: 0, count: 100 });
      const rawConversations = result.conversations ?? [];
      console.log("[JuggleChat] SDK 原始会话列表", result);
      const conversations = mergeConversations([], rawConversations, get().user?.id);
      set({
        conversations,
        conversationsInitialized: true,
        activeConversation: syncActiveConversation(get().activeConversation, conversations),
        loadingConversations: false,
      });
      // TIPS: 会话列表与聊天页顶部的显示名要靠通讯录兜底（引擎给的 conversationTitle
      // 常为空，单聊尤其如此），所以通讯录不能等用户切到「通讯录」页才加载。
      if (!get().contacts.length && !get().loadingContacts) void get().loadContacts();
      await get().refreshTotalUnreadCount();
    } catch (error) {
      set({ loadingConversations: false, error: errorMessage(error) });
    }
  },

  async refreshTotalUnreadCount() {
    if (!get().user || !juggleChatRuntime.isConnected()) {
      set({ totalUnreadCount: 0 });
      return;
    }
    try {
      const result = await juggleChatRuntime.getTotalUnreadCount();
      set({ totalUnreadCount: Math.max(0, Number(result?.count) || 0) });
    } catch {
      // A transient unread-count failure must not disconnect chat.
    }
  },

  async selectConversation(conversation, options) {
    releaseLocalMediaUrls(get().messages);
    if (options?.loadHistory === false) {
      set({
        activeConversation: conversation,
        messages: [],
        loadingMessages: false,
        messagesFinished: true,
        replyTo: null,
        pinnedMessage: null,
        error: null,
      });
      return;
    }
    set({ activeConversation: conversation, messages: [], loadingMessages: true, messagesFinished: false, replyTo: null, pinnedMessage: null });
    try {
      const [result, pinned] = await Promise.all([
        juggleChatRuntime.getMessages(conversation, 0),
        juggleChatRuntime.getTopMessage(conversation).catch(() => null),
      ]);
      if (!isSameConversation(get().activeConversation, conversation)) return;
      set({
        messages: result.messages ?? [],
        loadingMessages: false,
        messagesFinished: Boolean(result.isFinished),
        pinnedMessage: hasMessageIdentity(pinned?.message) ? { message: pinned.message, operator: pinned?.operator, createdTime: pinned?.createdTime } : null,
      });
      await juggleChatRuntime.clearUnread(conversation);
      set({
        conversations: get().conversations.map((item) => isSameConversation(item, conversation) ? { ...item, unreadCount: 0 } : item),
      });
      await get().refreshTotalUnreadCount();
    } catch (error) {
      if (isSameConversation(get().activeConversation, conversation)) {
        set({ loadingMessages: false, error: errorMessage(error) });
      }
    }
  },

  async loadEarlierMessages() {
    const conversation = get().activeConversation;
    const first = get().messages[0];
    if (!conversation || !first || get().loadingMessages || get().messagesFinished) return;
    set({ loadingMessages: true });
    try {
      const result = await juggleChatRuntime.getMessages(conversation, first.sentTime ?? 0);
      if (!isSameConversation(get().activeConversation, conversation)) return;
      set({
        messages: prependMessages(get().messages, result.messages ?? []),
        messagesFinished: Boolean(result.isFinished),
        loadingMessages: false,
      });
    } catch (error) {
      set({ loadingMessages: false, error: errorMessage(error) });
    }
  },

  async loadContacts() {
    set({ loadingContacts: true });
    try {
      const [membersResult, chatGroups] = await Promise.all([getMembers(), getChatGroupsForContacts()]);
      const contacts = membersResult.members.map((member) => ({
        user_id: member.user.imUserId,
        member_id: member.id,
        identity_user_id: member.user.id,
        nickname: member.user.name || member.user.account || member.user.imUserId,
        avatar: member.user.avatar || undefined,
        conversationType: 1,
        role: member.role,
      } satisfies ChatContact)).filter((contact) => contact.user_id && contact.user_id !== get().user?.id);
      const groups = chatGroups.map((group) => {
        return {
          user_id: group.id,
          nickname: group.name || group.id,
          avatar: group.avatar || undefined,
          conversationType: 2,
        } satisfies ChatContact;
      }).filter((item) => item.user_id);
      set({ contacts, groups, loadingContacts: false });
    } catch (error) {
      set({ loadingContacts: false, error: errorMessage(error) });
    }
  },

  async openContact(contact) {
    const client = await juggleChatRuntime.initialize();
    const conversationType = contact.conversationType ?? client.ConversationType.PRIVATE;
    const displayName = contact.friend_display_name || contact.nickname || contact.user_id;
    const existingInMemory = get().conversations.find((item) => (
      item.conversationId === contact.user_id && item.conversationType === conversationType
    ));
    const result = existingInMemory
      ? null
      : await client.getConversation({ conversationId: contact.user_id, conversationType });
    const sdkConversation = hasConversationIdentity(result?.conversation) ? result.conversation : null;
    const existing = existingInMemory ?? sdkConversation;
    // Always prefer the in-memory contact / group name so the conversation
    // list entry shows the right title immediately after navigating.
    const conversation: ChatConversation = {
      ...(existing ?? {}),
      conversationId: contact.user_id,
      conversationType,
      conversationTitle: displayName || existing?.conversationTitle || contact.user_id,
      ...(contact.avatar
        ? { conversationPortrait: contact.avatar }
        : existing?.conversationPortrait
          ? { conversationPortrait: existing.conversationPortrait }
          : {}),
    };
    // Ensure the conversation appears in the list immediately using the
    // in-memory group / contact data — no need to wait for a full list fetch.
    set({
      conversations: mergeConversations(get().conversations, [conversation], get().user?.id),
      view: "conversations",
    });
    await get().selectConversation(conversation, { loadHistory: Boolean(existing) });
  },

  async sendText(content, mentionInfo) {
    const conversation = get().activeConversation;
    const text = content.trim();
    if (!conversation || !text || get().sending) return;
    const replyTo = get().replyTo ?? undefined;
    const tid = globalThis.crypto?.randomUUID?.() ?? `text-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const currentUser = get().user;
    const draft: ChatMessage = {
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      name: "jg:text",
      content: { content: text },
      sender: currentUser ? { id: currentUser.id, name: currentUser.name, portrait: currentUser.portrait } : undefined,
      isSender: true,
      sentTime: Date.now(),
      sentState: 1,
      tid,
      localSendAnimation: true,
      ...(replyTo ? { referMsg: replyTo } : {}),
      ...(mentionInfo ? { mentionInfo, readCount: 0, unreadCount: 1 } : {}),
    };
    set({
      sending: true,
      messages: isSameConversation(get().activeConversation, conversation)
        ? appendMessages(get().messages, [draft])
        : get().messages,
    });
    try {
      const message = await juggleChatRuntime.sendText(conversation, text, replyTo, mentionInfo, tid);
      if (isSameConversation(get().activeConversation, conversation)) {
        const sent = mergeMessage(draft, { ...message, tid: message.tid || tid, sentState: 2 });
        set({ messages: appendMessages(get().messages, [sent]), sending: false, replyTo: null });
      } else {
        set({ sending: false });
      }
      await get().loadConversations();
    } catch (error) {
      set({
        sending: false,
        messages: get().messages.map((message) => message.tid === tid ? { ...message, sentState: 3 } : message),
        error: errorMessage(error),
      });
      throw error;
    }
  },

  async sendFile(file) {
    const conversation = get().activeConversation;
    if (!conversation || get().sending) return;
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const tid = globalThis.crypto?.randomUUID?.() ?? `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const localUrl = isImage || isVideo ? URL.createObjectURL(file) : "";
    const draft: ChatMessage = {
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      name: isImage ? "jg:img" : isVideo ? "jg:video" : "jg:file",
      content: { file, name: file.name, type: file.type, size: file.size },
      sender: get().user ? { id: get().user!.id, name: get().user!.name, portrait: get().user!.portrait } : undefined,
      isSender: true,
      sentTime: Date.now(),
      sentState: 1,
      percent: 0,
      tid,
      localUrl,
      localSendAnimation: true,
    };
    set({ sending: true, uploadProgress: 0 });
    try {
      if (isSameConversation(get().activeConversation, conversation)) {
        set({ messages: appendMessages(get().messages, [draft]) });
      }
      const metadata = isImage
        ? await getImageDimensions(localUrl)
        : isVideo
          ? await getVideoMetadata(localUrl)
          : {};
      draft.content = { ...draft.content, ...metadata };
      set({ messages: get().messages.map((item) => item.tid === tid ? mergeMessage(item, draft) : item) });
      const message = await juggleChatRuntime.sendFile(conversation, file, (uploadProgress) => {
        const nextPercent = Math.min(99.99, Math.max(0, Math.round(Number(uploadProgress) * 100) / 100));
        const currentPercent = Number(get().messages.find((item) => item.tid === tid)?.percent) || 0;
        const percent = Math.max(currentPercent, nextPercent);
        set({
          uploadProgress: percent,
          messages: get().messages.map((item) => item.tid === tid ? { ...item, percent, sentState: 1 } : item),
        });
      }, { tid, ...metadata });
      if (isSameConversation(get().activeConversation, conversation)) {
        const sent = { ...draft, ...message, content: { ...draft.content, ...message.content }, tid: message.tid || tid, localUrl, percent: 100, sentState: 2 };
        set({ messages: appendMessages(get().messages, [sent]), sending: false, uploadProgress: null });
      } else {
        set({ sending: false, uploadProgress: null });
      }
      await get().loadConversations();
    } catch (error) {
      set({
        sending: false,
        uploadProgress: null,
        messages: get().messages.map((item) => item.tid === tid ? { ...item, sentState: 3 } : item),
        error: errorMessage(error),
      });
      throw error;
    }
  },

  async recallMessage(message) {
    try {
      await juggleChatRuntime.recallMessage(message);
      const result = await juggleChatRuntime.getMessages(get().activeConversation!, 0);
      releaseLocalMediaUrls(get().messages);
      set({ messages: result.messages ?? [] });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async removeMessage(message) {
    try {
      await juggleChatRuntime.removeMessages([message]);
      releaseLocalMediaUrls([message]);
      set({ messages: get().messages.filter((item) => messageKey(item) !== messageKey(message)) });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async toggleReaction(message, reactionId) {
    const user = get().user;
    if (!message.messageId || !user) return;
    const previous = get().messages;
    const existing = message.reactions?.[reactionId] ?? [];
    const remove = existing.some((reaction) => reaction.value === user.id);
    const next = previous.map((item) => {
      if (item.messageId !== message.messageId) return item;
      const reactions = { ...(item.reactions ?? {}) };
      const list = [...(reactions[reactionId] ?? [])].filter((reaction) => reaction.value !== user.id);
      if (!remove) list.push({ key: reactionId, value: user.id, user });
      if (list.length) reactions[reactionId] = list;
      else delete reactions[reactionId];
      return { ...item, reactions };
    });
    set({ messages: next });
    try {
      await juggleChatRuntime.toggleReaction(message, reactionId, remove);
    } catch (error) {
      set({ messages: previous, error: errorMessage(error) });
    }
  },

  async favoriteMessage(message) {
    try {
      await juggleChatRuntime.addFavorite(message);
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  async translateMessage(message) {
    if (message.name !== "jg:text") return;
    if (message.translation) {
      set({ messages: get().messages.map((item) => item.messageId === message.messageId ? { ...item, isShowTranslation: !item.isShowTranslation } : item) });
      return;
    }
    set({ messages: get().messages.map((item) => item.messageId === message.messageId ? { ...item, isTranslating: true } : item) });
    try {
      const translation = await juggleChatRuntime.translateMessage(message);
      set({ messages: get().messages.map((item) => item.messageId === message.messageId ? { ...item, translation, isTranslating: false, isShowTranslation: true } : item) });
    } catch (error) {
      set({
        messages: get().messages.map((item) => item.messageId === message.messageId ? { ...item, isTranslating: false } : item),
        error: errorMessage(error),
      });
    }
  },

  async editMessage(message, content) {
    const value = content.trim();
    if (!message.messageId || !value) return;
    try {
      await juggleChatRuntime.updateTextMessage(message, value);
      set({ messages: get().messages.map((item) => messageKey(item) === messageKey(message) ? { ...item, content: { ...item.content, content: value }, isUpdated: true } : item) });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  async resendMessage(message) {
    const key = messageKey(message);
    set({ messages: get().messages.map((item) => messageKey(item) === key ? { ...item, sentState: 1 } : item) });
    try {
      const sent = await juggleChatRuntime.resendMessage(message);
      set({ messages: get().messages.map((item) => messageKey(item) === key ? mergeMessage(item, { ...sent, sentState: 2 }) : item) });
    } catch (error) {
      set({ messages: get().messages.map((item) => messageKey(item) === key ? { ...item, sentState: 3 } : item), error: errorMessage(error) });
    }
  },

  async pinMessage(message, isTop = true) {
    try {
      await juggleChatRuntime.setTopMessage(message, isTop);
      set({ pinnedMessage: isTop ? { message, operator: get().user ?? undefined, createdTime: Date.now() } : null });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  setReplyTo(replyTo) {
    set({ replyTo });
  },

  clearError() {
    set({ error: null });
  },
}));
