import { create } from "zustand";

import { getFriends, getGroups } from "./api";
import { clearChatUser, getChatUser, getServerSetting, setChatUser } from "./storage";
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
  loadingConversations: boolean;
  loadingMessages: boolean;
  loadingContacts: boolean;
  sending: boolean;
  uploadProgress: number | null;
  replyTo: ChatMessage | null;
  pinnedMessage: { message: ChatMessage; operator?: Partial<ChatUser>; createdTime?: number } | null;
  bootstrapped: boolean;
  setView: (view: ChatView) => void;
  bootstrap: () => Promise<void>;
  acceptLogin: (user: ChatUser) => Promise<void>;
  logout: () => void;
  loadConversations: () => Promise<void>;
  selectConversation: (conversation: ChatConversation) => Promise<void>;
  loadEarlierMessages: () => Promise<void>;
  loadContacts: () => Promise<void>;
  openContact: (contact: ChatContact) => Promise<void>;
  sendText: (content: string) => Promise<void>;
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

function mergeConversations(current: ChatConversation[], incoming: ChatConversation[], currentUserId?: string) {
  const map = new Map(current.map((conversation) => [`${conversation.conversationType}:${conversation.conversationId}`, conversation]));
  for (const conversation of incoming) {
    if (!conversation.conversationId || conversation.conversationId === currentUserId || IGNORED_CONVERSATIONS.has(conversation.conversationId)) continue;
    const key = `${conversation.conversationType}:${conversation.conversationId}`;
    map.set(key, { ...map.get(key), ...conversation });
  }
  return [...map.values()].sort((a, b) => {
    const top = Number(Boolean(b.isTop)) - Number(Boolean(a.isTop));
    return top || (b.sortTime ?? b.latestMessage?.sentTime ?? 0) - (a.sortTime ?? a.latestMessage?.sentTime ?? 0);
  });
}

function extractContacts(data: unknown): ChatContact[] {
  if (Array.isArray(data)) return data as ChatContact[];
  if (!data || typeof data !== "object") return [];
  const value = data as Record<string, unknown>;
  const list = value.items ?? value.users ?? value.friends ?? value.list;
  return Array.isArray(list) ? list as ChatContact[] : [];
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object") {
    const value = error as { error?: { msg?: string; message?: string }; message?: string; msg?: string };
    return value.error?.message ?? value.error?.msg ?? value.message ?? value.msg ?? "Chat 操作失败";
  }
  return String(error || "Chat 操作失败");
}

function startSubscriptions() {
  if (subscriptionsStarted) return;
  subscriptionsStarted = true;
  juggleChatRuntime.subscribe("state", ({ state, error }: { state: number; error?: { code?: number; message?: string } }) => {
    if (state === 0) {
      useJuggleChatStore.setState({ status: "connected", error: null });
    } else if (state === 1 || state === 6) {
      useJuggleChatStore.setState({ status: "connecting" });
    } else if (state === 2 || state === 3) {
      const unauthorized = [11005, 11006, 11011, 11012].includes(Number(error?.code));
      if (unauthorized) {
        clearChatUser();
        useJuggleChatStore.setState({ status: "signed-out", user: null, error: "登录状态已失效，请重新登录" });
      } else {
        useJuggleChatStore.setState({ status: "disconnected", error: error?.message ?? null });
      }
    }
  });
  juggleChatRuntime.subscribe("message", (message: ChatMessage) => {
    if (message.isStatus) return;
    const state = useJuggleChatStore.getState();
    if (isSameConversation(state.activeConversation, message)) {
      useJuggleChatStore.setState({ messages: appendMessages(state.messages, [message]) });
      void juggleChatRuntime.clearUnread(state.activeConversation!);
    }
    void state.loadConversations();
  });
  juggleChatRuntime.subscribe("conversation", ({ conversations = [] }: { conversations?: ChatConversation[] }) => {
    const state = useJuggleChatStore.getState();
    useJuggleChatStore.setState({ conversations: mergeConversations(state.conversations, conversations, state.user?.id) });
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
    clearChatUser();
    releaseLocalMediaUrls(useJuggleChatStore.getState().messages);
    useJuggleChatStore.setState({ status: "signed-out", user: null, error: "登录状态已失效，请重新登录" });
  });
}

export const useJuggleChatStore = create<JuggleChatState>((set, get) => ({
  status: "idle",
  error: null,
  user: getChatUser(),
  view: "conversations",
  conversations: [],
  activeConversation: null,
  messages: [],
  messagesFinished: false,
  contacts: [],
  groups: [],
  loadingConversations: false,
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

  async bootstrap() {
    if (get().bootstrapped) return;
    set({ bootstrapped: true });
    startSubscriptions();
    startJuggleChatSkillBridge();
    if (!getServerSetting()) {
      set({ status: "signed-out", user: null });
      return;
    }
    const user = getChatUser();
    if (!user) {
      set({ status: "signed-out", user: null });
      return;
    }
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
    setChatUser(user);
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

  logout() {
    juggleChatRuntime.disconnect();
    clearChatUser();
    releaseLocalMediaUrls(get().messages);
    set({
      status: "signed-out",
      user: null,
      conversations: [],
      activeConversation: null,
      messages: [],
      pinnedMessage: null,
      contacts: [],
      groups: [],
      error: null,
    });
  },

  async loadConversations() {
    if (!get().user || !juggleChatRuntime.isConnected()) return;
    set({ loadingConversations: true });
    try {
      const result = await juggleChatRuntime.getConversations({ time: 0, count: 100 });
      const conversations = mergeConversations([], result.conversations ?? [], get().user?.id);
      set({ conversations, loadingConversations: false });
      if (!get().activeConversation && conversations[0]) void get().selectConversation(conversations[0]);
    } catch (error) {
      set({ loadingConversations: false, error: errorMessage(error) });
    }
  },

  async selectConversation(conversation) {
    releaseLocalMediaUrls(get().messages);
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
      const [friendsResult, groupsResult] = await Promise.all([getFriends(), getGroups()]);
      const groupsData = groupsResult.data && typeof groupsResult.data === "object"
        ? (groupsResult.data as Record<string, unknown>).items ?? groupsResult.data
        : groupsResult.data;
      const groups = (Array.isArray(groupsData) ? groupsData : []).map((item) => {
        const group = item as Record<string, unknown>;
        return {
          user_id: String(group.group_id ?? ""),
          nickname: String(group.group_name ?? group.group_id ?? ""),
          avatar: group.group_portrait ? String(group.group_portrait) : undefined,
          conversationType: 2,
        } satisfies ChatContact;
      }).filter((item) => item.user_id);
      set({ contacts: extractContacts(friendsResult.data), groups, loadingContacts: false });
    } catch (error) {
      set({ loadingContacts: false, error: errorMessage(error) });
    }
  },

  async openContact(contact) {
    const client = await juggleChatRuntime.initialize();
    const conversationType = contact.conversationType ?? client.ConversationType.PRIVATE;
    const result = await client.getConversation({ conversationId: contact.user_id, conversationType });
    const conversation = result?.conversation ?? {
      conversationId: contact.user_id,
      conversationType,
      conversationTitle: contact.friend_display_name || contact.nickname || contact.user_id,
      conversationPortrait: contact.avatar,
    };
    set({ view: "conversations" });
    await get().selectConversation(conversation);
  },

  async sendText(content) {
    const conversation = get().activeConversation;
    const text = content.trim();
    if (!conversation || !text || get().sending) return;
    set({ sending: true });
    try {
      const message = await juggleChatRuntime.sendText(conversation, text, get().replyTo ?? undefined);
      if (isSameConversation(get().activeConversation, conversation)) {
        set({ messages: appendMessages(get().messages, [message]), sending: false, replyTo: null });
      }
      await get().loadConversations();
    } catch (error) {
      set({ sending: false, error: errorMessage(error) });
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
