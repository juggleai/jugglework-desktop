import JuggleChat from "./vendor/juggleim-es-1.9.13.js";
import JuggleCall from "./vendor/jugglecall-es-1.0.0.js";

import { getServerSetting } from "./storage";
import type { ChatConversation, ChatMessage, ChatUser } from "./types";

declare global {
  interface Window {
    OSS?: unknown;
    ZegoExpressEngine?: new (appId: number) => unknown;
  }
}

type RuntimeEvent = "state" | "message" | "conversation" | "message-recalled" | "message-updated" | "message-reaction-changed" | "message-read" | "message-removed" | "message-set-top" | "stream-appended" | "stream-completed";
type RuntimeListener = (payload: any) => void;

const CUSTOM_MESSAGES = [
  { name: "jgd:grpntf", isCount: true, isStorage: true },
  { name: "jgd:friendntf", isCount: true, isStorage: true },
  { name: "jgd:friendapply", isCount: true, isStorage: true },
  { name: "jgd:contactcard", isCount: true, isStorage: true },
  { name: "snl:sticker", isCount: true, isStorage: true },
  { name: "snl:typing", isStatus: true },
  { name: "snl:replay", isCount: true, isStorage: true },
  { name: "snl:syncdntf", isCount: true, isStorage: true },
];

function staticUrl(name: string) {
  return new URL(`jugglechat/vendor/${name}`, document.baseURI).href;
}

function loadScript(name: string, ready: () => boolean) {
  if (ready()) return Promise.resolve();
  const src = staticUrl(name);
  const existing = document.querySelector<HTMLScriptElement>(`script[data-jugglechat-vendor="${name}"]`);
  if (existing) {
    return new Promise<void>((resolve, reject) => {
      if (ready()) return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`无法加载 ${name}`)), { once: true });
    });
  }
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.dataset.jugglechatVendor = name;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`无法加载 ${name}`)), { once: true });
    document.head.appendChild(script);
  });
}

function resolveImServers(values: string[]) {
  if (!values.length) return [window.location.origin];
  if (values.every((value) => value.startsWith(":"))) {
    return values.map((value) => `${window.location.protocol}//${window.location.hostname}${value}`);
  }
  return values;
}

class JuggleChatRuntime {
  private client: any = null;
  private callClient: any = null;
  private initialized: Promise<any> | null = null;
  private wiredClient: any = null;
  private listeners = new Map<RuntimeEvent, Set<RuntimeListener>>();

  async initialize() {
    if (this.client) return this.client;
    if (this.initialized) return this.initialized;
    const setting = getServerSetting();
    if (!setting) throw new Error("请先配置 Chat 组织");
    this.initialized = (async () => {
      await loadScript("aliyun-oss-sdk-6.18.1.min.js", () => Boolean(window.OSS));
      await loadScript("tgs-player.js", () => Boolean(customElements.get("tgs-player")));
      const client = JuggleChat.init({
        appkey: setting.app_key,
        upload: window.OSS,
        serverList: resolveImServers(setting.im_servers),
      });
      client.registerMessage(CUSTOM_MESSAGES);
      this.client = client;
      this.wireClientEvents(client);
      return client;
    })();
    try {
      return await this.initialized;
    } catch (error) {
      this.initialized = null;
      throw error;
    }
  }

  private wireClientEvents(client: any) {
    if (this.wiredClient === client) return;
    this.wiredClient = client;
    const event = client.Event;
    client.on(event.STATE_CHANGED, (payload: unknown) => this.emit("state", payload));
    client.on(event.MESSAGE_RECEIVED, (payload: unknown) => this.emit("message", payload));
    client.on(event.CONVERSATION_CHANGED, (payload: unknown) => this.emit("conversation", payload));
    client.on(event.CONVERSATION_ADDED, (payload: unknown) => this.emit("conversation", payload));
    if (event.MESSAGE_RECALLED) {
      client.on(event.MESSAGE_RECALLED, (payload: unknown) => this.emit("message-recalled", payload));
    }
    if (event.MESSAGE_UPDATED) {
      client.on(event.MESSAGE_UPDATED, (payload: unknown) => this.emit("message-updated", payload));
    }
    if (event.MESSAGE_REACTION_CHANGED) {
      client.on(event.MESSAGE_REACTION_CHANGED, (payload: unknown) => this.emit("message-reaction-changed", payload));
    }
    if (event.MESSAGE_READ) client.on(event.MESSAGE_READ, (payload: unknown) => this.emit("message-read", payload));
    if (event.MESSAGE_REMOVED) client.on(event.MESSAGE_REMOVED, (payload: unknown) => this.emit("message-removed", payload));
    if (event.MESSAGE_SET_TOP) client.on(event.MESSAGE_SET_TOP, (payload: unknown) => this.emit("message-set-top", payload));
    if (event.STREAM_APPENDED) client.on(event.STREAM_APPENDED, (payload: unknown) => this.emit("stream-appended", payload));
    if (event.STREAM_COMPLETED) client.on(event.STREAM_COMPLETED, (payload: unknown) => this.emit("stream-completed", payload));
  }

  subscribe(event: RuntimeEvent, listener: RuntimeListener) {
    const listeners = this.listeners.get(event) ?? new Set<RuntimeListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  private emit(event: RuntimeEvent, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  async connect(user: ChatUser) {
    const client = await this.initialize();
    if (client.isConnected()) return client.getCurrentUser();
    return client.connect({ userId: user.id, token: user.token });
  }

  isConnected() {
    return Boolean(this.client?.isConnected?.());
  }

  getClient() {
    return this.client;
  }

  async getConversations(params: Record<string, unknown> = {}) {
    const client = await this.initialize();
    return client.getConversations(params) as Promise<{ conversations: ChatConversation[]; isFinished?: boolean }>;
  }

  async getMessages(conversation: ChatConversation, time = 0) {
    const client = await this.initialize();
    return client.getMessages({
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      time,
    }) as Promise<{ messages: ChatMessage[]; isFinished?: boolean }>;
  }

  async sendText(conversation: ChatConversation, content: string, referMsg?: ChatMessage) {
    const client = await this.initialize();
    return client.sendMessage({
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      name: client.MessageType.TEXT,
      content: { content },
      ...(referMsg ? { referMsg } : {}),
    }) as Promise<ChatMessage>;
  }

  async sendFile(
    conversation: ChatConversation,
    file: File,
    onProgress?: (percent: number) => void,
    draft?: { tid?: string; width?: number; height?: number; duration?: number },
  ) {
    const client = await this.initialize();
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const base = {
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      ...(draft?.tid ? { tid: draft.tid } : {}),
      content: isImage
        ? { file, width: draft?.width, height: draft?.height, type: file.type }
        : isVideo
          ? { file, name: file.name, width: draft?.width, height: draft?.height, duration: draft?.duration, type: file.type, size: file.size }
          : { file, name: file.name, type: file.type, size: file.size },
    };
    const callbacks = {
      onprogress: (progress: { percent?: number; loaded?: number; total?: number } | number) => {
        const rawPercent = typeof progress === "number"
          ? progress
          : progress.percent ?? (progress.total ? Number(progress.loaded || 0) / progress.total * 100 : 0);
        const percent = Math.min(100, Math.max(0, Number(rawPercent) || 0));
        onProgress?.(percent);
      },
    };
    return (isImage
      ? client.sendImageMessage(base, callbacks)
      : isVideo
        ? client.sendVideoMessage(base, callbacks)
        : client.sendFileMessage(base, callbacks)) as Promise<ChatMessage>;
  }

  async clearUnread(conversation: ChatConversation) {
    const client = await this.initialize();
    return client.clearUnreadcount({
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      unreadIndex: conversation.latestUnreadIndex ?? 0,
    });
  }

  async recallMessage(message: ChatMessage) {
    const client = await this.initialize();
    return client.recallMessage(message);
  }

  async removeMessages(messages: ChatMessage[]) {
    const client = await this.initialize();
    if (!messages.length) return;
    return client.removeMessages(messages);
  }

  async resendMessage(message: ChatMessage) {
    const client = await this.initialize();
    return client.sendMessage(message) as Promise<ChatMessage>;
  }

  async updateTextMessage(message: ChatMessage, content: string) {
    const client = await this.initialize();
    await client.updateMessage({
      conversationType: message.conversationType,
      conversationId: message.conversationId,
      messageId: message.messageId,
      sentTime: message.sentTime,
      content: { content },
      msgName: client.MessageType.TEXT,
      tid: message.tid,
    });
  }

  async getMergeMessages(messageId: string) {
    const client = await this.initialize();
    return client.getMergeMessages({ messageId }) as Promise<{ messages?: ChatMessage[]; isFinished?: boolean }>;
  }

  async getTopMessage(conversation: ChatConversation) {
    const client = await this.initialize();
    return client.getTopMessage({
      conversationType: conversation.conversationType,
      conversationId: conversation.conversationId,
    }) as Promise<{ message?: ChatMessage; operator?: ChatUser; createdTime?: number }>;
  }

  async setTopMessage(message: ChatMessage, isTop: boolean) {
    const client = await this.initialize();
    return client.setTopMessage({
      conversationType: message.conversationType,
      conversationId: message.conversationId,
      messageId: message.messageId,
      isTop,
    });
  }

  async toggleReaction(message: ChatMessage, reactionId: string, remove: boolean) {
    const client = await this.initialize();
    const params = {
      conversationType: message.conversationType,
      conversationId: message.conversationId,
      messageId: message.messageId,
      reactionId,
    };
    return remove ? client.removeMessageReaction(params) : client.addMessageReaction(params);
  }

  async addFavorite(message: ChatMessage) {
    const client = await this.initialize();
    return client.addFavoriteMessages({
      messages: [{
        conversationType: message.conversationType,
        conversationId: message.conversationId,
        messageId: message.messageId,
        senderId: message.sender?.id,
      }],
    });
  }

  async removeFavorite(message: ChatMessage) {
    const client = await this.initialize();
    return client.removeFavoriteMessages({
      messages: [{
        conversationType: message.conversationType,
        conversationId: message.conversationId,
        messageId: message.messageId,
        senderId: message.sender?.id,
      }],
    });
  }

  async getFavoriteMessages(offset = "", limit = 20) {
    const client = await this.initialize();
    return client.getFavoriteMessages({ offset, limit }) as Promise<{ list: ChatMessage[]; offset?: string }>;
  }

  async translateMessage(message: ChatMessage, sourceLang = "en", targetLang = "auto") {
    const client = await this.initialize();
    const key = message.messageId || message.tid;
    if (!key || typeof message.content?.content !== "string") throw new Error("当前消息不支持翻译");
    const result = await client.translate({ sourceLang, targetLang, content: { [key]: message.content.content } });
    return String(result?.[key] ?? "");
  }

  async forwardMessage(message: ChatMessage, conversations: ChatConversation[]) {
    const client = await this.initialize();
    return Promise.all(conversations.map((conversation) => client.sendMessage({
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      name: message.name,
      content: message.content,
    }) as Promise<ChatMessage>));
  }

  async forwardMerged(messages: ChatMessage[], conversations: ChatConversation[], title: string) {
    const client = await this.initialize();
    const previewList = messages.map((message) => ({
      content: message.content?.content || message.content?.name || `[${message.name}]`,
      userName: message.sender?.name || message.sender?.id || "用户",
      userId: message.sender?.id,
      portrait: message.sender?.portrait,
    }));
    return Promise.all(conversations.map((conversation) => client.sendMergeMessage({
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      conversationTitle: conversation.conversationTitle,
      conversationPortrait: conversation.conversationPortrait,
      messages,
      previewList,
      title,
    }) as Promise<ChatMessage>));
  }

  async setTopConversation(conversation: ChatConversation, isTop: boolean) {
    const client = await this.initialize();
    return client.setTopConversation({ ...conversation, isTop });
  }

  async disturbConversation(conversation: ChatConversation, undisturbType: number) {
    const client = await this.initialize();
    return client.disturbConversation({ ...conversation, undisturbType });
  }

  async invoke(action: string, args: Record<string, unknown> = {}) {
    const client = await this.initialize();
    const fn = client?.[action];
    if (typeof fn !== "function") throw new Error(`JuggleChat SDK 不支持 ${action}`);
    return fn.call(client, normalizeConversationType(args));
  }

  async getCallClient() {
    if (this.callClient) return this.callClient;
    const client = await this.initialize();
    await loadScript("ZegoExpressWebRTC-3.12.0.js", () => Boolean(window.ZegoExpressEngine));
    if (!window.ZegoExpressEngine) throw new Error("Zego WebRTC 未加载");
    const engine = new window.ZegoExpressEngine(1881186044);
    this.callClient = JuggleCall.init({ client: client.install({ name: "call" }), engine });
    this.callClient.CallEvent = JuggleCall.CallEvent;
    this.callClient.MediaType = JuggleCall.MediaType;
    return this.callClient;
  }

  disconnect() {
    try {
      this.client?.disconnect?.();
    } catch {
      // The SDK can already be disconnected after an unauthorized event.
    }
  }
}

function normalizeConversationType(args: Record<string, unknown>) {
  const raw = args.conversationType;
  if (typeof raw !== "string") return args;
  const value = raw.toLowerCase();
  const conversationType = value === "single" || value === "private" || value === "1"
    ? 1
    : value === "group" || value === "2"
      ? 2
      : value === "chatroom" || value === "3"
        ? 3
        : raw;
  return { ...args, conversationType };
}

export const juggleChatRuntime = new JuggleChatRuntime();
