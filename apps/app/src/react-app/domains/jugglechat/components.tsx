/** @jsxImportSource react */
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { isMacPlatform } from "@/app/utils";
import {
  ArrowDown,
  AtSign,
  Check,
  ChevronLeft,
  CircleAlert,
  Crown,
  FileIcon,
  Forward,
  ImageIcon,
  LoaderCircle,
  LogOut,
  Mic,
  MicOff,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Phone,
  PhoneOff,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shield,
  SmilePlus,
  Trash2,
  UserPlus,
  UserMinus,
  Users,
  Video,
  VideoOff,
  X,
} from "lucide-react";

import {
  addGroupAdmins,
  createGroup,
  dismissGroup,
  getGroupAdmins,
  getGroupInfo,
  getGroupMembers,
  getGroupNotice,
  quitGroup,
  removeGroupAdmins,
  removeGroupMembers,
  setGroupDisplayName,
  setGroupHistoryVisible,
  setGroupManagement,
  setGroupMute,
  setGroupNotice,
  transferGroupOwner,
  updateGroup,
  inviteGroupMembers,
} from "./api";
import { useJuggleCallStore } from "./call-store";
import { juggleChatRuntime } from "./runtime";
import { useJuggleChatStore } from "./store";
import type { ApiEnvelope, ChatContact, ChatConversation, ChatGroupInfo, ChatGroupMember, ChatMessage, ChatUser } from "./types";

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function useListSearchShortcut() {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  return inputRef;
}

function toError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; msg?: unknown };
    if (typeof value.message === "string") return value.message;
    if (typeof value.msg === "string") return value.msg;
    try { return JSON.stringify(error); } catch { return "操作失败"; }
  }
  return String(error || "操作失败");
}

function conversationName(conversation: ChatConversation | null) {
  if (!conversation) return "";
  return conversation.conversationAlias || conversation.conversationTitle || conversation.conversationId;
}

function initials(name: string) {
  const value = name.trim();
  return value ? [...value][0]?.toUpperCase() : "?";
}

function avatarColorIndex(value: string) {
  return value.length > 0 ? value.charCodeAt(0) % 6 : 0;
}

export function ChatAvatar(props: { name: string; userId?: string; src?: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const colorClass = `jg-peer-color-${avatarColorIndex(props.userId || props.name)}`;
  const hasPortrait = Boolean(props.src && !failed);
  useEffect(() => setFailed(false), [props.src]);
  return (
    <span
      className={cx("jw-im-avatar tyn-avatar", `is-${props.size ?? "md"}`, props.className)}
      style={hasPortrait ? { backgroundImage: `url(${JSON.stringify(props.src)})` } : undefined}
      aria-hidden="true"
    >
      {hasPortrait ? <img src={props.src} alt="" style={{ display: "none" }} onError={() => setFailed(true)} /> : <span className={cx("inner", colorClass)}>{initials(props.name)}</span>}
    </span>
  );
}

function formatTime(value?: number) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

function formatConversationTime(value?: number) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${date.getMonth() + 1}-${date.getDate()}`;
}

function messagePreview(message?: ChatMessage) {
  if (!message) return "暂无消息";
  if (message.name === "jg:text") return mentionText(message);
  if (message.name === "jg:img") return "[图片]";
  if (message.name === "jg:file") return `[文件] ${message.content?.name || ""}`;
  if (message.name === "jg:video") return "[视频]";
  if (message.name === "jg:voice") return "[语音]";
  if (message.name === "jg:merge") return "[聊天记录]";
  if (message.name === "jg:callfinishntf") return "[通话消息]";
  if (message.name === "jg:streamtext") return message.content?.content || "[智能体消息]";
  if (message.name === "snl:sticker") return "[动态表情]";
  if (message.name === "snl:replay") return "[群接龙消息]";
  if (message.name === "jgd:contactcard") return "[联系人名片]";
  if (message.name === "jgd:grpntf") return "[群通知消息]";
  if (message.name === "jgd:friendntf") return "[添加好友通知]";
  if (message.name === "jg:recallinfo" || message.name === "jg:recall") return "消息已撤回";
  return "[暂不支持的消息]";
}

function ListAddMenu({ onOpen, onCreateGroup }: { onOpen?: () => void; onCreateGroup: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!menuRef.current || event.composedPath().includes(menuRef.current)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) onOpen?.();
  };

  return (
    <div ref={menuRef} className={cx("jw-im-list-add-wrap", open && "is-open")}>
      <button type="button" className="jw-im-list-add" onClick={toggle} title="新增" aria-label="新增" aria-haspopup="menu" aria-expanded={open}><Plus /></button>
      {open ? (
        <div className="jw-im-list-add-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onCreateGroup(); }}><Users /><span>创建群组</span></button>
        </div>
      ) : null}
    </div>
  );
}

export function ConversationList() {
  const conversations = useJuggleChatStore((state) => state.conversations);
  const contacts = useJuggleChatStore((state) => state.contacts);
  const active = useJuggleChatStore((state) => state.activeConversation);
  const select = useJuggleChatStore((state) => state.selectConversation);
  const loading = useJuggleChatStore((state) => state.loadingConversations);
  const initialized = useJuggleChatStore((state) => state.conversationsInitialized);
  const loadContacts = useJuggleChatStore((state) => state.loadContacts);
  const reloadConversations = useJuggleChatStore((state) => state.loadConversations);
  const [query, setQuery] = useState("");
  const [groupOpen, setGroupOpen] = useState(false);
  const searchInputRef = useListSearchShortcut();
  const filtered = useMemo(() => conversations.filter((item) => conversationName(item).toLowerCase().includes(query.trim().toLowerCase())), [conversations, query]);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousRowPositions = useRef(new Map<string, number>());
  const previousOrder = useRef<string | null>(null);
  const rowAnimations = useRef(new Map<string, Animation>());
  const orderKey = filtered.map((conversation) => `${conversation.conversationType}:${conversation.conversationId}`).join("|");
  const captureRowPositions = () => {
    const positions = new Map<string, number>();
    rowRefs.current.forEach((node, key) => positions.set(key, node.getBoundingClientRect().top));
    previousRowPositions.current = positions;
  };
  useLayoutEffect(() => {
    const positions = new Map<string, number>();
    rowRefs.current.forEach((node, key) => positions.set(key, node.getBoundingClientRect().top));
    const orderChanged = previousOrder.current !== null && previousOrder.current !== orderKey;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (orderChanged && !reduceMotion) {
      rowRefs.current.forEach((node, key) => {
        const previousTop = previousRowPositions.current.get(key);
        const offset = previousTop === undefined ? -12 : previousTop - (positions.get(key) ?? previousTop);
        if (previousTop !== undefined && Math.abs(offset) < 1) return;
        rowAnimations.current.get(key)?.cancel();
        const animation = node.animate(
          previousTop === undefined
            ? [{ opacity: 0, transform: `translateY(${offset}px)` }, { opacity: 1, transform: "translateY(0)" }]
            : [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
          { duration: 320, easing: "cubic-bezier(.22, .61, .36, 1)" },
        );
        rowAnimations.current.set(key, animation);
        const clearAnimation = () => { if (rowAnimations.current.get(key) === animation) rowAnimations.current.delete(key); };
        animation.onfinish = clearAnimation;
        animation.oncancel = clearAnimation;
      });
    }
    for (const [key, animation] of rowAnimations.current) {
      if (!positions.has(key)) {
        animation.cancel();
        rowAnimations.current.delete(key);
      }
    }
    previousRowPositions.current = positions;
    previousOrder.current = orderKey;
  }, [orderKey]);
  useEffect(() => () => rowAnimations.current.forEach((animation) => animation.cancel()), []);
  return (
    <>
      <aside className="jw-im-list-pane tyn-aside">
      <header className="jw-im-pane-header jg-conversations-header jw-im-list-filter-header">
        <div className="jw-im-list-filter">
          <Search aria-hidden="true" />
          <input ref={searchInputRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" aria-label="搜索会话" />
          {query ? <button type="button" className="jw-im-list-filter-clear" onClick={() => setQuery("")} title="清除搜索" aria-label="清除搜索"><X /></button> : loading && !initialized ? <span className="jw-im-list-loading" title="数据更新中..."><LoaderCircle className="is-spinning" /><span>数据更新中...</span></span> : <kbd className="jw-im-list-filter-shortcut">{isMacPlatform() ? "⌘⇧F" : "Ctrl+Shift+F"}</kbd>}
        </div>
        <ListAddMenu onOpen={() => { if (!contacts.length) void loadContacts(); }} onCreateGroup={() => setGroupOpen(true)} />
      </header>
      <div className="jg-conversation-body">
        <div className="jg-conver-list">
          <div className="jw-im-list-scroll tyn-aside-body tyn-aside-list newui-conversation-list-anim" onScroll={captureRowPositions}>
        {loading && !conversations.length ? <div className="newui-conversation-skeleton">{Array.from({ length: 6 }, (_, index) => <div className="newui-skeleton-row newui-conversation-card" key={index}><span className="newui-skeleton-avatar" /><span className="newui-conversation-content"><span className="newui-skeleton-line newui-skeleton-line-title" style={{ width: `${52 + index * 4}%` }} /><span className="newui-skeleton-line newui-skeleton-line-preview" style={{ width: `${66 + index * 3}%` }} /></span><span className="newui-conversation-side"><span className="newui-skeleton-line newui-skeleton-line-time" /></span></div>)}</div> : null}
        {!loading && !filtered.length ? <div className="newui-empty-state"><div className="newui-empty-state-icon"><MessageCircle /></div><div className="newui-empty-state-title">暂无会话</div><div className="newui-empty-state-sub">点击右上角 + 创建群组</div></div> : null}
        {filtered.map((conversation) => {
          const name = conversationName(conversation);
          const key = `${conversation.conversationType}:${conversation.conversationId}`;
          return (
            <button ref={(node) => { if (node) rowRefs.current.set(key, node); else rowRefs.current.delete(key); }} key={key} className={cx("jw-im-conversation-row tyn-aside-item newui-conversation-item", Boolean(conversation.isTop) && "is-pinned", isSame(active, conversation) && "is-active active")} onClick={() => void select(conversation)}>
              <span className="newui-conversation-card">
                <span className="newui-conversation-main">
                  <span className="newui-conversation-avatar-wrap"><ChatAvatar className="tyn-s-avatar newui-conversation-avatar" name={name} userId={conversation.conversationId} src={conversation.conversationPortrait} /></span>
                  <span className="jw-im-row-body newui-conversation-content">
                    <span className="jw-im-row-title newui-conversation-title-row"><strong className="newui-conversation-title"><span className="newui-conversation-title-text">{name}</span></strong></span>
                    <span className="newui-conversation-subtitle-row"><span className="jw-im-row-preview newui-conversation-preview">{messagePreview(conversation.latestMessage)}</span></span>
                  </span>
                </span>
                <span className="newui-conversation-side">
                  <span className="newui-conversation-side-top"><time className="newui-conversation-time">{formatConversationTime(conversation.latestMessage?.sentTime)}</time></span>
                  <span className="newui-conversation-side-bottom">{(conversation.unreadCount ?? 0) > 0 ? <span className="jw-im-unread newui-conversation-side-badge">{Math.min(conversation.unreadCount ?? 0, 99)}</span> : <span className="newui-conversation-side-placeholder" />}</span>
                </span>
              </span>
            </button>
          );
        })}
          </div>
        </div>
      </div>
      </aside>
      {groupOpen ? <CreateGroupModal contacts={contacts} onClose={() => setGroupOpen(false)} onCreated={() => { setGroupOpen(false); void loadContacts(); void reloadConversations(); }} /> : null}
    </>
  );
}

function isSame(a: ChatConversation | null, b: ChatConversation | null) {
  return Boolean(a && b && a.conversationId === b.conversationId && a.conversationType === b.conversationType);
}

function messageText(message: ChatMessage) {
  return message.content?.content || message.content?.name || messagePreview(message);
}

const MESSAGE_NAMES = {
  text: "jg:text",
  image: "jg:img",
  voice: "jg:voice",
  video: "jg:video",
  file: "jg:file",
  merge: "jg:merge",
  recall: "jg:recall",
  recallInfo: "jg:recallinfo",
  callFinished: "jg:callfinishntf",
  streamText: "jg:streamtext",
  groupNotify: "jgd:grpntf",
  friendNotify: "jgd:friendntf",
  contactCard: "jgd:contactcard",
  sticker: "snl:sticker",
  chain: "snl:replay",
} as const;

const SUPPORTED_MESSAGE_NAMES = new Set<string>(Object.values(MESSAGE_NAMES));

function messageClock(value?: number) {
  if (!value) return "";
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatFileSize(value?: number) {
  const bytes = Number(value) || 0;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(2)} KB`;
}

function mediaSize(content: ChatMessage["content"], patch = 20) {
  const originalWidth = Number(content.width) || 270;
  const originalHeight = Number(content.height) || 240;
  const landscape = originalWidth >= originalHeight;
  const ratio = landscape && originalWidth > 270 ? 270 / originalWidth : !landscape && originalHeight > 240 ? 240 / originalHeight : 1;
  return { width: Math.round(originalWidth * ratio), height: Math.round(originalHeight * ratio + patch) };
}

function isMarkdownContent(value: string) {
  return [
    /^\s{0,3}```[\s\S]*?```/m,
    /^\s{0,3}#{1,6}\s+.+/m,
    /^\s{0,3}>\s+.+/m,
    /^\s{0,3}(?:[-*+]\s+.+|\d+\.\s+.+)$/m,
    /\[[^\]]+\]\([^\)]+\)/,
    /`[^`\n]+`/,
    /\*\*[^*\n]+\*\*/,
    /(^|[^\w*])\*[^*\n]+\*(?!\*)/,
    /~~[^~\n]+~~/,
    /^\s*\|?[\s\-:|]+\|?\s*$/m,
    /^\s{0,3}(?:---+|\*\*\*+)\s*$/m,
  ].some((pattern) => pattern.test(value));
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Electron pages using file:// may not expose the Clipboard API. Keep the
    // same textarea fallback used by the Vue client.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function mentionText(message: ChatMessage, translated = false) {
  let value = String(translated ? message.translation ?? "" : message.content?.content ?? "");
  const info = message.mentionInfo;
  if (!info) return value;
  if (info.mentionType === 1 || info.mentionType === 3) value = value.replaceAll("{all}", translated ? "@All" : "@所有人");
  for (const member of info.members ?? []) value = value.replaceAll(`{${member.id}}`, `@${member.name || member.id}`);
  return value;
}

function mentionEditorText(message: ChatMessage) {
  let value = String(message.content?.content ?? "");
  const info = message.mentionInfo;
  if (!info) return value;
  if (info.mentionType === 1 || info.mentionType === 3) value = value.replaceAll("{all}", "@所有人 ");
  for (const member of info.members ?? []) value = value.replaceAll(`{${member.id}}`, `@${member.name || member.id} `);
  return value;
}

function mentionEditorContent(message: ChatMessage, content: string) {
  const info = message.mentionInfo;
  if (!info) return content;
  const replacements: Array<{ label: string; token: string }> = [];
  if (info.mentionType === 1 || info.mentionType === 3) replacements.push({ label: "@所有人", token: "{all}" });
  for (const member of info.members ?? []) replacements.push({ label: `@${member.name || member.id}`, token: `{${member.id}}` });
  let value = content;
  for (const { label, token } of replacements.sort((a, b) => b.label.length - a.label.length)) {
    value = value.replaceAll(`${label} `, token).replaceAll(label, token);
  }
  return value;
}

function markdownHtml(value: string) {
  const rendered = marked.parse(value.replace(/</g, "&lt;"), { breaks: true, gfm: true, async: false }) as string;
  return rendered.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer nofollow" href=');
}

function messageHtml(message: ChatMessage, translated = false) {
  const value = mentionText(message, translated);
  let html: string;
  if (isMarkdownContent(value)) {
    html = markdownHtml(value);
  } else {
    html = escapeHtml(value)
      .replace(/(?:(?:https?|ftp):\/\/)?(?:www\.)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/[^\s<]*)?|(?:(?:https?|ftp):\/\/)?(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\d+)?(?:\/[^\s<]*)?/gi, (url) => `<a href="${/^(?:https?|ftp):\/\//i.test(url) ? url : `https://${url}`}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`)
      .replace(/\n/g, "<br/>");
  }
  for (const member of message.mentionInfo?.members ?? []) {
    const label = escapeHtml(`@${member.name || member.id}`);
    html = html.replaceAll(label, `<span class="jg-mention-msg-name">${label}</span>`);
  }
  html = html.replaceAll(translated ? "@All" : "@所有人", `<span class="jg-mention-msg-name">${translated ? "@All" : "@所有人"}</span>`);
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
}

function ReplyReference({ message, senderId }: { message?: ChatMessage; senderId?: string }) {
  if (!message?.sender) return null;
  return <div className={cx("tyn-message-refer wr", `jg-peer-color-${avatarColorIndex(senderId || "")}`)} message-id={message.messageId}>回复 {message.sender.name || message.sender.id || "用户"} : {messageText(message)}</div>;
}

function MessageMeta({ message, overlay, sticker, onResend }: { message: ChatMessage; overlay?: "image" | "video"; sticker?: boolean; onResend?: () => void }) {
  const read = Boolean(message.isRead || (message.conversationType === 2 && Number(message.readCount) > 0));
  return (
    <div className={cx("jg-msg-status-box", overlay === "image" && "jg-imgmsg-stbox", overlay === "video" && "jg-videomsg-stbox")}>
      <span className={cx("jg-message-senttime", sticker && "jg-stickermsg-stbox")}>
        {message.isUpdated ? <span className="tyn-text-modify">（已编辑）</span> : null}
        <span>{messageClock(message.sentTime)}</span>
      </span>
      {message.sentState === 1 ? <span className="message-state message-send-loading message-sending" role="status" aria-label="发送中" title="发送中" /> : null}
      {message.sentState === 3 ? <button className="wr wr-failed message-state message-failed" title="发送失败，点击重试" onClick={(event) => { event.stopPropagation(); onResend?.(); }} /> : null}
      {message.isSender && message.sentState === 2 ? <div className="jg-sent-tip"><div className={cx("wr", read ? "wr-done-all" : "wr-done", "tyn-opacity1")} /></div> : null}
    </div>
  );
}

function TranslationBlock({ message }: { message: ChatMessage }) {
  if (!message.isTranslating && !(message.translation && message.isShowTranslation)) return null;
  return <div className="jg-translate"><div className={cx("jg-translate-content", `jg-peer-color-${avatarColorIndex(message.sender?.id || "")}`)}><div className="wrapper">{message.isTranslating ? <div className="loading-container"><div className="loading-spinner" /></div> : <span className={cx("content", isMarkdownContent(message.translation || "") && "markdown-body")} dangerouslySetInnerHTML={{ __html: messageHtml(message, true) }} />}</div><div className="label">由 JuggleWork 提供翻译支持</div></div></div>;
}

function UploadProgressOverlay({ message }: { message: ChatMessage }) {
  if (message.sentState !== 1 || typeof message.percent !== "number" || message.percent >= 99.99) return null;
  return <div className="jw-im-upload-overlay" aria-label={`上传进度 ${Math.round(message.percent)}%`}><span>{Math.round(message.percent)}%</span></div>;
}

function ImageMessage({ message, onResend }: { message: ChatMessage; onResend?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  const content = message.content || {};
  const localSource = String(message.localUrl || "");
  const source = String(localSource || content.thumbnail || content.url || "");
  const full = String(content.url || message.localUrl || content.thumbnail || "");
  const size = mediaSize(content);
  return <>
    <div className="tyn-reply-bubble tyn-transpant-bubble"><div className="tyn-reply-media tyn-reply-meida-img" style={{ maxWidth: Math.max(60, size.width) }} message-id={message.messageId}>
      {!loaded && !failed ? <div className="tyn-img-loading"><div className="jg-img-loader" /></div> : null}
      <div className="glightbox jw-im-media-trigger" role="button" tabIndex={0} style={{ height: size.height, width: size.width }} onClick={() => full && setPreview(true)} onKeyDown={(event) => { if (event.key === "Enter") setPreview(true); }}>
        {failed || !source ? <div className="jw-im-media-error"><ImageIcon size={24} /><span>图片加载失败</span></div> : <img src={source} style={{ height: size.height, width: size.width }} className={cx("tyn-image", !loaded && "fadein-o")} alt="聊天图片" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
        <UploadProgressOverlay message={message} />
        <MessageMeta message={message} overlay="image" onResend={onResend} />
      </div>
    </div></div>
    {preview ? <div className="jw-im-lightbox" onMouseDown={() => setPreview(false)}><button className="jw-im-lightbox-close" onClick={() => setPreview(false)}><X /></button><img src={full} alt="图片预览" onMouseDown={(event) => event.stopPropagation()} /></div> : null}
  </>;
}

function VideoMessage({ message, onResend }: { message: ChatMessage; onResend?: () => void }) {
  const content = message.content || {};
  const size = mediaSize(content, 25);
  const localSource = String(message.localUrl || "");
  const source = String(localSource || content.url || "");
  return <div className="tyn-reply-bubble tyn-transpant-bubble"><div className="tyn-reply-media wr" message-id={message.messageId || message.tid}><div className="glightbox jw-im-video-message" style={{ height: size.height, width: size.width }}><video src={source} poster={content.snapshotUrl ? String(content.snapshotUrl) : undefined} className="tyn-image" controls /><UploadProgressOverlay message={message} /></div><MessageMeta message={message} overlay="video" onResend={onResend} /></div></div>;
}

function FileMessage({ message, onResend }: { message: ChatMessage; onResend?: () => void }) {
  const content = message.content || {};
  return <div className="tyn-reply-bubble"><div className="tyn-reply-file wr" message-id={message.tid || message.messageId}><a href={content.url ? String(content.url) : undefined} className="tyn-file" download={String(content.name || "文件")} target="_blank" rel="noreferrer"><div className="tyn-media-group"><div className="tyn-filemsg-icon"><div className="wr wr-file tyb-msg-fileicon" /></div><div className="tyn-media-col"><h6 className="name jg-ellipsis">{String(content.name || "文件")}</h6><div className="meta">{formatFileSize(content.size)}</div></div></div></a><UploadProgressOverlay message={message} /><MessageMeta message={message} onResend={onResend} /></div></div>;
}

function StickerMessage({ message, onResend }: { message: ChatMessage; onResend?: () => void }) {
  const rawName = Number(message.content?.name || 0) + 1;
  const path = String(message.content?.path || "");
  const source = String(message.content?.url || new URL(`stickers/sticker_${path}/AnimatedSticker (${rawName}).tgs`, document.baseURI).href);
  return <div className="tyn-reply-bubble tyn-staker-bubble" message-id={message.messageId || message.tid}><div className="tyn-reply-text wr"><div className="jg-msg-animate-box">{createElement("tgs-player", { mode: "normal", autoplay: true, loop: true, style: { width: 120, height: 120 }, src: source })}</div><MessageMeta message={message} sticker onResend={onResend} /></div></div>;
}

function MergeMessage({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const show = async () => {
    setOpen(true);
    if (items.length || !message.messageId) return;
    setLoading(true);
    try { setItems((await juggleChatRuntime.getMergeMessages(message.messageId)).messages ?? []); }
    catch (loadError) { setError(toError(loadError)); }
    finally { setLoading(false); }
  };
  return <>
    <div className="tyn-reply-bubble wr" message-id={message.messageId}><button className="tyn-reply-text tyn-reply-merge" onClick={() => void show()}><div className="tyn-media-row"><span className="tyn-msg-mergetitle">{String(message.content?.title || "聊天记录")}</span></div>{(message.content?.previewList ?? []).map((item, index) => <div className="tyn-media-row tyn-msg-merge-list" key={`${item.userId || item.userName}:${index}`}><span className="sender">{item.userName || "用户"}:</span><span className="message">{item.content}</span></div>)}<div className="tyn-msg-merge-footer"><div className="tip">聊天记录</div><MessageMeta message={message} /></div></button></div>
    {open ? <div className="jw-im-modal-backdrop jw-im-merge-backdrop" onMouseDown={() => setOpen(false)}><section className="jw-im-modal modal-merge-content" onMouseDown={(event) => event.stopPropagation()}><header><h3>消息记录</h3><button onClick={() => setOpen(false)}><X size={18} /></button></header><div className="modal-body tyn-chat-body"><div className="tyn-reply jw-im-merge-list">{loading ? <div className="loading-container"><div className="loading-spinner" /></div> : null}{error ? <div className="jw-im-form-error"><CircleAlert size={15} />{error}</div> : null}{[...items].reverse().map((item) => <MessageItem key={item.messageId || item.tid} message={item} readOnly />)}</div></div></section></div> : null}
  </>;
}

function ContactCardMessage({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const openContact = useJuggleChatStore((state) => state.openContact);
  const id = String(message.content?.user_id || message.content?.id || "");
  const name = String(message.content?.name || id || "联系人");
  const portrait = message.content?.portrait ? String(message.content.portrait) : undefined;
  return <>
    <div className="tyn-reply-bubble"><div className="tyn-reply-text"><button className="jg-contact-card" onClick={() => setOpen(true)}><div className="jg-contact-info"><div className="tyn-media tyn-size-md"><ChatAvatar className="tyn-s-avatar" name={name} userId={id} src={portrait} /></div><div className="jg-contact-card-title jg-ellipsis">{name}</div></div><div className="jg-contact-memo">联系人名片</div></button></div></div>
    {open ? <div className="jw-im-modal-backdrop" onMouseDown={() => setOpen(false)}><section className="jw-im-modal jw-im-contact-card-detail" onMouseDown={(event) => event.stopPropagation()}><header><h3>联系人名片</h3><button onClick={() => setOpen(false)}><X size={18} /></button></header><ChatAvatar name={name} userId={id} src={portrait} size="lg" /><strong>{name}</strong><span>@{id}</span><button className="jw-im-primary-button" disabled={!id} onClick={() => void openContact({ user_id: id, nickname: name, avatar: portrait }).then(() => setOpen(false))}><MessageCircle size={16} />发消息</button></section></div> : null}
  </>;
}

function ChainMessage({ message }: { message: ChatMessage }) {
  const toggleReaction = useJuggleChatStore((state) => state.toggleReaction);
  const currentUser = useJuggleChatStore((state) => state.user);
  const reactionId = message.messageId || "";
  const participants = message.reactions?.[reactionId] ?? [];
  const joined = participants.some((item) => item.value === currentUser?.id);
  return <div className="tyn-reply-bubble" message-id={message.messageId || message.tid}><div className="tyn-reply-text tyn-chain-content"><div className="title">群接龙</div><div className="content">{String(message.content?.content || "")}</div><div className="tyn-chain-reactions">{participants.map((item, index) => { const user = item.user ?? {}; const name = user.name || user.id || item.value; return <div className="tyn-chain-reaction-item" key={item.value}><span className="jg-chain-reaction-num">{index + 1}.</span><div className="tyn-chain-reaction-user"><ChatAvatar className="jg-chain-user-avatar" name={name} userId={user.id} src={user.portrait} size="sm" /><span>{name}</span></div></div>; })}{!joined && reactionId ? <button className="tyn-chain-reaction-item tyn-chain-btn" onClick={() => void toggleReaction(message, reactionId)}><span className="wr wr-add-cirlcle" /><span>参加接龙</span></button> : null}</div><MessageMeta message={message} /></div></div>;
}

function callFinishedText(message: ChatMessage) {
  const duration = Number(message.content?.duration) || 0;
  if (duration > 0) {
    const seconds = Math.floor(duration / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  const reason = Number(message.content?.reason);
  if (reason === 0) return message.isSender ? "已取消" : "对方取消";
  if (reason === 1) return message.isSender ? "对方拒接" : "已拒接";
  if (reason === 2) return message.isSender ? "对方未接听" : "未接听";
  if (reason === 3) return "已挂断";
  return "通话已结束";
}

function MessageBubble({ message, onResend }: { message: ChatMessage; onResend?: () => void }) {
  if (message.name === MESSAGE_NAMES.image) return <ImageMessage message={message} onResend={onResend} />;
  if (message.name === MESSAGE_NAMES.video) return <VideoMessage message={message} onResend={onResend} />;
  if (message.name === MESSAGE_NAMES.file) return <FileMessage message={message} onResend={onResend} />;
  if (message.name === MESSAGE_NAMES.sticker) return <StickerMessage message={message} onResend={onResend} />;
  if (message.name === MESSAGE_NAMES.merge) return <MergeMessage message={message} />;
  if (message.name === MESSAGE_NAMES.contactCard) return <ContactCardMessage message={message} />;
  if (message.name === MESSAGE_NAMES.chain) return <ChainMessage message={message} />;
  if (message.name === MESSAGE_NAMES.callFinished) return <div className="tyn-reply-bubble"><div className="tyn-reply-text tyn-reply-call-text wr wr-rtc-status-hangup">{callFinishedText(message)}</div></div>;
  if (message.name === MESSAGE_NAMES.streamText) {
    const stream = `${String(message.content?.content || "")}${String(message.streamMsg?.streams || "")}`;
    const html = DOMPurify.sanitize(markdownHtml(stream), { ADD_ATTR: ["target", "rel"] });
    return <div className="tyn-reply-bubble" message-id={message.messageId || message.tid}><div className="markdown-body tyn-reply-text jg-stream-text" dangerouslySetInnerHTML={{ __html: html }} /></div>;
  }
  if (message.name === MESSAGE_NAMES.voice && message.content?.url) return <div className="tyn-reply-bubble"><div className="tyn-reply-text jw-im-voice-bubble"><audio className="jw-im-audio-message" controls src={String(message.content.url)} /><MessageMeta message={message} onResend={onResend} /></div></div>;
  return <div className="tyn-reply-bubble" message-id={message.messageId || message.tid}><div className="tyn-reply-text wr"><ReplyReference message={message.referMsg} senderId={message.sender?.id} /><span style={{ wordBreak: "break-all" }} className={cx(isMarkdownContent(String(message.content?.content || "")) && "markdown-body")} dangerouslySetInnerHTML={{ __html: messageHtml(message) }} /><TranslationBlock message={message} /><MessageMeta message={message} onResend={onResend} /></div></div>;
}

function MessageContent({ message }: { message: ChatMessage }) {
  if (message.name === MESSAGE_NAMES.image) return <img className="tyn-image jw-im-favorite-image" src={String(message.content?.thumbnail || message.content?.url || "")} alt="聊天图片" />;
  if (message.name === MESSAGE_NAMES.file) return <span><FileIcon size={18} /> {String(message.content?.name || "文件")}</span>;
  if (message.name === MESSAGE_NAMES.video) return <span>[视频]</span>;
  return <span dangerouslySetInnerHTML={{ __html: message.name === MESSAGE_NAMES.text ? messageHtml(message) : escapeHtml(messagePreview(message)) }} />;
}

const QUICK_REACTIONS = [
  { id: "1f44c", emoji: "👌" },
  { id: "1f44d", emoji: "👍" },
  { id: "1f970", emoji: "🥰" },
  { id: "1fae1", emoji: "🫡" },
  { id: "1f494", emoji: "💔" },
  { id: "1f276", emoji: "❤️" },
  { id: "1f4a9", emoji: "💩" },
  { id: "1f389", emoji: "🎉" },
] as const;

const MESSAGE_EMOJIS = [
  "👌", "😄", "😆", "😅", "😂", "😭", "🥰", "🥳", "🫠",
  "😊", "🫡", "🤫", "🤗", "💔", "❤️", "🤨", "😮", "😴",
  "😡", "😥", "😇", "🥶", "🤧", "💩", "🔥", "🌪", "🌞",
  "💥", "😵", "😎", "🎉", "💯", "💪", "👏", "👍", "🤞",
  "🙏", "🌈", "🌍", "☕", "🎾", "🍻", "🏕",
] as const;

function EmojiPicker({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) {
  return <>
    <div className="tyn-emoji-pn show-aside fadein-o4 jw-im-emoji-picker">
      <div className="tyn-emoji-header"><div className="tyn-emoji-title">所有表情</div></div>
      <div className="tyn-emoni-box"><div className="tyn-emoni-innerbox show"><div className="emojis__grid">
        {MESSAGE_EMOJIS.map((emoji) => <button type="button" className="emoji-item" key={emoji} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(emoji)}>{emoji}</button>)}
      </div></div></div>
      <ul className="tyn-emoji-tools"><li className="tyn-emoji-tool active"><div className="tyn-emojis-btn"><div className="tyn-emoji-icon">😄</div></div></li></ul>
    </div>
    <button type="button" className="dropmenu-backdrop show-menu-back jw-im-emoji-backdrop" aria-label="关闭表情面板" onClick={onClose} />
  </>;
}

function reactionEmoji(id: string) {
  return QUICK_REACTIONS.find((reaction) => reaction.id === id)?.emoji ?? id;
}

function systemMessageText(message: ChatMessage) {
  if (message.name === MESSAGE_NAMES.recall || message.name === MESSAGE_NAMES.recallInfo) return `${message.isSender ? "你" : message.sender?.name || "对方"} 撤回了一条消息`;
  if (message.name === MESSAGE_NAMES.groupNotify) {
    const members = message.content?.members ?? [];
    const names = members.map((member) => member.nickname || member.user_id).filter(Boolean).join("、");
    const owner = message.isSender ? "你" : message.sender?.name || "成员";
    const type = Number(message.content?.type);
    if (type === 1) return `${owner} 邀请 ${names} 加入群组`;
    if (type === 2) {
      const operatorId = message.content?.operator?.user_id;
      return members.some((member) => member.user_id === operatorId) ? `${owner} 退出了群组` : `${owner} 将 ${names} 移除群组`;
    }
    if (type === 4) return `${members[0]?.nickname || members[0]?.user_id || owner} 成为了群主`;
    return `${owner} 修改群名称为 ${String(message.content?.name || "")}`;
  }
  if (message.name === MESSAGE_NAMES.friendNotify) {
    const op = Number(message.content?.type) === 0 ? "添加" : "通过";
    const name = message.conversationTitle || message.sender?.name || "对方";
    return message.isSender ? `你 ${op} ${name} 为好友` : `${name} ${op} 你 为好友`;
  }
  if (message.name === "notify") return timeSeparatorText(message.sentTime);
  return "消息暂不支持";
}

function timeGroup(value?: number) {
  const date = new Date(value || 0);
  const now = new Date();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const difference = Math.floor((day.getTime() - today.getTime()) / 86400000);
  if (difference === 0) return "today";
  if (difference === -1) return "yesterday";
  if (difference > -7 && difference < 0) return `week_${date.getDay() || 7}`;
  if (date.getFullYear() === now.getFullYear()) return `month_day_${date.getMonth()}_${date.getDate()}`;
  return `year_month_day_${date.getFullYear()}_${date.getMonth()}_${date.getDate()}`;
}

function timeSeparatorText(value?: number) {
  const date = new Date(value || 0);
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const sameDay = (left: Date, right: Date) => left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  if (sameDay(date, now)) return "今天";
  if (sameDay(date, yesterday)) return "昨天";
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - ((now.getDay() || 7) - 1));
  if (date >= weekStart) return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function BurnCountdown({ message }: { message: ChatMessage }) {
  const destroyTime = Number(message.destroyTime) || 0;
  const initial = Number(message.lifeCountdownTime) || Number(message.lifeTimeAfterRead) || 0;
  const [remaining, setRemaining] = useState(Math.max(0, initial));
  useEffect(() => {
    const end = destroyTime > 0 ? destroyTime : Date.now() + initial;
    setRemaining(destroyTime > 0 ? Math.max(0, end - Date.now()) : Math.max(0, initial));
    if (initial <= 0 || destroyTime <= 0) return;
    const timer = window.setInterval(() => setRemaining(Math.max(0, end - Date.now())), 1000);
    return () => window.clearInterval(timer);
  }, [destroyTime, initial]);
  if (remaining <= 0) return null;
  const totalSeconds = Math.ceil(remaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return <span className="jg-msg-burn-time"><span className="wr wr-burn-timer" />{days ? <><span className="jg-msg-burn-days">{days}d</span><span className="jg-msg-burn-colon">:</span></> : null}<span className="jg-msg-burn-hours">{String(hours).padStart(2, "0")}</span>h<span className="jg-msg-burn-colon">:</span><span className="jg-msg-burn-minutes">{String(minutes).padStart(2, "0")}</span>m<span className="jg-msg-burn-colon">:</span><span className="jg-msg-burn-seconds">{String(seconds).padStart(2, "0")}</span>s</span>;
}

function MessageReactions({ message }: { message: ChatMessage }) {
  const toggleReaction = useJuggleChatStore((state) => state.toggleReaction);
  const reactions = Object.entries(message.reactions ?? {});
  if (!reactions.length) return null;
  return <ul className="jg-reactions">{reactions.map(([id, list]) => <li className="jg-reaction" key={id} onClick={() => void toggleReaction(message, id)} title={list.map((item) => item.user?.name || item.user?.id || item.value).join("、")}><div className="jg-reaction-inner"><div className="jg-reaction-emoji"><div className="jg-reaction-emoji-img">{reactionEmoji(id)}</div></div><div className="jg-reaction-names">{list.slice(0, 4).map((item, index) => { const name = item.user?.name || item.user?.id || item.value; return <div className="jg-reaction-name" style={{ zIndex: 10 - index }} key={item.value}><ChatAvatar className="jg-reaction-avatar tyn-sd-avatar" name={name} userId={item.user?.id} src={item.user?.portrait} size="sm" /></div>; })}</div></div></li>)}</ul>;
}

type MessageItemProps = { message: ChatMessage; onForward?: (message: ChatMessage) => void; onEdit?: (message: ChatMessage) => void; onReply?: (message: ChatMessage) => void; onStartMultiSelect?: (message: ChatMessage) => void; selectionMode?: boolean; selected?: boolean; onToggleSelected?: (message: ChatMessage) => void; readOnly?: boolean; compact?: boolean };

type MessageMenuPosition = {
  x: number;
  y: number;
  target: HTMLElement;
};

function MessageItem({ message, onEdit, onReply, selectionMode, selected, onToggleSelected, readOnly, compact }: MessageItemProps) {
  const recall = useJuggleChatStore((state) => state.recallMessage);
  const remove = useJuggleChatStore((state) => state.removeMessage);
  const resend = useJuggleChatStore((state) => state.resendMessage);
  const pin = useJuggleChatStore((state) => state.pinMessage);
  const setReply = useJuggleChatStore((state) => state.setReplyTo);
  const toggleReaction = useJuggleChatStore((state) => state.toggleReaction);
  const translate = useJuggleChatStore((state) => state.translateMessage);
  const currentUser = useJuggleChatStore((state) => state.user);
  const [menu, setMenu] = useState<MessageMenuPosition | null>(null);
  const [sendEntering, setSendEntering] = useState(() => Boolean(message.isSender && message.localSendAnimation));
  const [expired, setExpired] = useState(Number(message.destroyTime) > 0 && Number(message.destroyTime) <= Date.now());
  useEffect(() => {
    if (!sendEntering) return;
    const timer = window.setTimeout(() => setSendEntering(false), 420);
    return () => window.clearTimeout(timer);
  }, [sendEntering]);
  useEffect(() => {
    const destroyTime = Number(message.destroyTime) || 0;
    if (!destroyTime) { setExpired(false); return; }
    const delay = destroyTime - Date.now();
    if (delay <= 0) { setExpired(true); return; }
    setExpired(false);
    const timer = window.setTimeout(() => setExpired(true), delay);
    return () => window.clearTimeout(timer);
  }, [message.destroyTime]);
  const senderName = message.sender?.name || message.sender?.id || "用户";
  const system = message.name === "notify" || message.name === MESSAGE_NAMES.recall || message.name === MESSAGE_NAMES.recallInfo || message.name === MESSAGE_NAMES.groupNotify || message.name === MESSAGE_NAMES.friendNotify || !SUPPORTED_MESSAGE_NAMES.has(message.name);
  if (expired) return null;
  if (system) return <div className="tyn-reply-separator"><span className="tyn-separator-item">{systemMessageText(message)}</span></div>;
  const menuAction = (action: () => void) => { action(); setMenu(null); };
  const openMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    event.preventDefault();
    const target = event.currentTarget.closest<HTMLElement>(".jw-im-root");
    if (!target) return;
    const menuWidth = 200;
    const menuHeight = 350;
    const margin = 10;
    let x = event.clientX;
    let y = event.clientY;
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - margin;
    if (x < margin) x = margin;
    if (y + menuHeight > window.innerHeight) y -= menuHeight;
    if (y < margin) y = margin;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - margin;
    setMenu({ x, y, target });
  };
  const menuPortal = menu && !readOnly ? createPortal(
    <>
      <div className="tyn-message-context jw-im-message-context" style={{ left: menu.x, top: menu.y }}>
        <ul className="tyn-reply-tools"><li>
          <div className="dropdown-menu dropdown-menu-xxs fadein-o4 show jw-im-message-menu">
            <div className={cx("jg-reaction-emoji-pn show-aside", message.isSender && "jg-reaction-pn-sender")}>
              <div className="jg-pn-reactions">{QUICK_REACTIONS.map((reaction) => <button className="jg-reaction-item" key={reaction.id} onClick={() => menuAction(() => void toggleReaction(message, reaction.id))}>{reaction.emoji}</button>)}</div>
            </div>
            <ul className="tyn-list-links">
              {message.name === MESSAGE_NAMES.text ? <><li className="tyn-list-link"><button className="wr wr-copy" onClick={() => menuAction(() => void copyText(mentionText(message)))}><span>复制</span></button></li><li className="tyn-list-link"><button className="wr wr-translate" onClick={() => menuAction(() => void translate(message))}><span>{message.translation && message.isShowTranslation ? "取消翻译" : "翻译"}</span></button></li><li className="tyn-list-link"><div className="jg-bottom-line" /></li></> : null}
              {message.isSender ? <li className="tyn-list-link"><button className="wr wr-recall" onClick={() => menuAction(() => void recall(message))}><span>撤回</span></button></li> : null}
              <li className="tyn-list-link"><button className="wr wr-top" onClick={() => menuAction(() => void pin(message))}><span>置顶</span></button></li>
              <li className="tyn-list-link"><button className="wr wr-reply" onClick={() => menuAction(() => { if (onReply) onReply(message); else setReply(message); })}><span>回复</span></button></li>
              <li className="tyn-list-link"><div className="jg-bottom-line" /></li>
              {message.isSender && message.name === MESSAGE_NAMES.text && onEdit ? <li className="tyn-list-link"><button className="wr wr-edit" onClick={() => menuAction(() => onEdit(message))}><span>编辑</span></button></li> : null}
              <li className="tyn-list-link"><button className="wr wr-delete is-danger" onClick={() => menuAction(() => void remove(message))}><span>删除</span></button></li>
            </ul>
          </div>
        </li></ul>
      </div>
      <button className="dropmenu-backdrop show-menu-back jw-im-message-menu-backdrop" aria-label="关闭消息菜单" onClick={() => setMenu(null)} />
    </>,
    menu.target,
  ) : null;
  return (
    <div className={cx("jw-im-message tny-content-msg", message.isSender && "is-sender", sendEntering && "jw-im-message-send-enter", selectionMode && "tny-content-msg-operator", selected && "tny-content-msg-select")} onContextMenu={openMenu}>
      {selectionMode ? <button className="jw-im-message-select" onClick={() => onToggleSelected?.(message)}>{selected ? <Check size={14} /> : null}</button> : null}
      <article className={cx("tyn-reply-item", message.isSender ? "outgoing" : "ingoing", selectionMode && "tny-message", compact && "tyn-force-msg-margin")} onClick={() => { if (selectionMode) onToggleSelected?.(message); }}>
        <div className="tyn-reply-avatar"><div className="tyn-media"><ChatAvatar className="jg-msg-user-avatar" name={message.isSender ? currentUser?.name || currentUser?.id || senderName : senderName} userId={message.isSender ? currentUser?.id : message.sender?.id} src={message.isSender ? currentUser?.portrait : message.sender?.portrait} size="sm" /></div></div>
        <div className="tyn-reply-group">
          {!message.isSender && message.conversationType === 2 ? <span className={cx("jg-sender-name-inner", `jg-peer-color-${avatarColorIndex(message.sender?.id || "")}`)}>{senderName}</span> : null}
          <div className={cx("jg-text-row", message.isSender && "jg-text-row-outgoing")}>
            <div className="jg-text-stack"><MessageBubble message={message} onResend={() => void resend(message)} /><MessageReactions message={message} /></div>
            <BurnCountdown message={message} />
          </div>
        </div>
      </article>
      {menuPortal}
    </div>
  );
}

type MentionCandidate = {
  id: string;
  name: string;
  portrait?: string;
  isAll?: boolean;
};

function canMentionAll(settingRight: number, myRole: number) {
  return settingRight === 7 || (settingRight === 1 && myRole === 1) || (settingRight === 3 && (myRole === 1 || myRole === 2));
}

async function getAllGroupMentionMembers(groupId: string) {
  const members: ChatGroupMember[] = [];
  let offset = "";
  for (let page = 0; page < 50; page += 1) {
    const result = await getGroupMembers(groupId, 100, offset);
    assertSuccess(result, "获取群成员失败");
    const items = extractGroupMembers(result.data);
    members.push(...items);
    if (Array.isArray(result.data)) break;
    const nextOffset = result.data && typeof result.data === "object" && "offset" in result.data ? String(result.data.offset || "") : "";
    if (!nextOffset || nextOffset === offset || !items.length) break;
    offset = nextOffset;
  }
  return members;
}

async function getMentionCandidates(groupId: string): Promise<MentionCandidate[]> {
  const [infoResult, listedMembers] = await Promise.all([
    getGroupInfo(groupId),
    getAllGroupMentionMembers(groupId).catch(() => []),
  ]);
  assertSuccess(infoResult, "获取群资料失败");
  const data = infoResult.data ?? {};
  const memberMap = new Map<string, ChatGroupMember>();
  for (const member of [...extractGroupMembers(data.members), ...listedMembers]) {
    const id = groupMemberId(member);
    if (id) memberMap.set(id, { ...memberMap.get(id), ...member });
  }
  const candidates: MentionCandidate[] = [];
  const management = data.group_management && typeof data.group_management === "object" ? data.group_management as Record<string, unknown> : {};
  if (canMentionAll(Number(management.group_mention_all_right ?? 0), Number(data.my_role ?? 0))) {
    candidates.push({ id: "all", name: "所有人", isAll: true });
  }
  for (const member of memberMap.values()) {
    const id = groupMemberId(member);
    candidates.push({ id, name: groupMemberName(member), portrait: String(member.avatar || member.portrait || "") || undefined });
  }
  return candidates;
}

function mentionTokenAt(value: string, cursor: number) {
  const prefix = value.slice(0, cursor);
  const match = prefix.match(/@([^@\s]*)$/u);
  if (!match || match.index === undefined) return null;
  return { index: match.index, query: match[1] };
}

function buildMentionMessage(content: string, mentions: MentionCandidate[]) {
  let nextContent = content;
  let hasAll = false;
  const members = new Map<string, { id: string; name?: string }>();
  for (const mention of mentions) {
    const visibleText = `@${mention.name} `;
    if (!nextContent.includes(visibleText)) continue;
    nextContent = nextContent.replace(visibleText, mention.isAll ? "{all}" : `{${mention.id}}`);
    if (mention.isAll) hasAll = true;
    else members.set(mention.id, { id: mention.id, name: mention.name });
  }
  if (!hasAll && !members.size) return { content };
  const mentionInfo: NonNullable<ChatMessage["mentionInfo"]> = {
    mentionType: hasAll ? (members.size ? 3 : 1) : 2,
    members: [...members.values()],
  };
  return { content: nextContent, mentionInfo };
}

function MentionPicker({ members, activeIndex, loading, onSelect }: { members: MentionCandidate[]; activeIndex: number; loading: boolean; onSelect: (member: MentionCandidate) => void }) {
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => activeRef.current?.scrollIntoView({ block: "nearest" }), [activeIndex]);
  return (
    <div className="tyn-chat-search tyn-mentions active jw-im-mentions" role="listbox" aria-label="选择要提醒的群成员">
      <ul className="form-control-wrap form-control-plaintext-wrap jg-mentions-warp">
        {loading ? <li className="jw-im-mention-empty">正在加载群成员…</li> : null}
        {!loading && !members.length ? <li className="jw-im-mention-empty">没有匹配的群成员</li> : null}
        {members.map((member, index) => <li ref={index === activeIndex ? activeRef : undefined} className={cx("mention-row", index === activeIndex && "mention-active")} role="option" aria-selected={index === activeIndex} key={`${member.isAll ? "all" : "member"}:${member.id}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(member)}><ChatAvatar className="jw-im-mention-avatar" name={member.isAll ? "@" : member.name} userId={member.id} src={member.portrait} size="sm" /><span className="name">{member.name}</span></li>)}
      </ul>
    </div>
  );
}

function ComposerMessagePanel({ mode, message, onClose }: { mode: "reply" | "edit"; message: ChatMessage | null; onClose: () => void }) {
  const [cachedMessage, setCachedMessage] = useState<ChatMessage | null>(message);
  useEffect(() => {
    if (message) {
      setCachedMessage(message);
      return;
    }
    if (!cachedMessage) return;
    const timer = window.setTimeout(() => setCachedMessage(null), 280);
    return () => window.clearTimeout(timer);
  }, [cachedMessage, message]);
  const renderedMessage = message ?? cachedMessage;
  const senderId = renderedMessage?.sender?.id || "";
  const senderName = renderedMessage?.sender?.name || renderedMessage?.sender?.id || "消息";
  return (
    <div
      className={cx(
        "tyn-replies tyn-form-box jw-im-composer-message-panel",
        message && "active",
        senderId && `jg-peer-color-${avatarColorIndex(senderId)}`,
      )}
      aria-hidden={!message}
    >
      {renderedMessage ? <>
        <div className="flex-grow-1">
          <div className="form-control-wrap form-control-plaintext-wrap">
            <div className="tyn-form-wrapper">
              <div className="tyn-form-wrapper-icon"><span className={cx("wr", mode === "edit" ? "wr-edit" : "wr-reply")} /></div>
              <div className="tyn-form-wrapper-content">
                <div className="title">{mode === "edit" ? "修改消息" : senderName}</div>
                <div className="content">{renderedMessage.name === MESSAGE_NAMES.text ? mentionText(renderedMessage) : messageText(renderedMessage)}</div>
              </div>
            </div>
          </div>
        </div>
        <ul className="tyn-list-inline"><li><button type="button" className="btn wr wr-close" aria-label={mode === "edit" ? "取消编辑" : "取消回复"} onClick={onClose} /></li></ul>
      </> : null}
    </div>
  );
}

export function ConversationSurface() {
  const conversation = useJuggleChatStore((state) => state.activeConversation);
  const conversations = useJuggleChatStore((state) => state.conversations);
  const messages = useJuggleChatStore((state) => state.messages);
  const loading = useJuggleChatStore((state) => state.loadingMessages);
  const loadEarlier = useJuggleChatStore((state) => state.loadEarlierMessages);
  const finished = useJuggleChatStore((state) => state.messagesFinished);
  const sendText = useJuggleChatStore((state) => state.sendText);
  const sendFile = useJuggleChatStore((state) => state.sendFile);
  const sending = useJuggleChatStore((state) => state.sending);
  const replyTo = useJuggleChatStore((state) => state.replyTo);
  const setReply = useJuggleChatStore((state) => state.setReplyTo);
  const pinnedMessage = useJuggleChatStore((state) => state.pinnedMessage);
  const pinMessage = useJuggleChatStore((state) => state.pinMessage);
  const editMessage = useJuggleChatStore((state) => state.editMessage);
  const [text, setText] = useState("");
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionMembers, setMentionMembers] = useState<MentionCandidate[]>([]);
  const [selectedMentions, setSelectedMentions] = useState<MentionCandidate[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionTriggerIndex, setMentionTriggerIndex] = useState(-1);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [forwarding, setForwarding] = useState<ChatMessage[] | null>(null);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const actionsMenuRef = useRef<HTMLLIElement>(null);
  const lastConversation = useRef<string | null>(null);
  const lastMessage = useRef<string | null>(null);
  const lastScrollTopRef = useRef(0);
  const loadingEarlierRef = useRef(false);
  const historyAnchorRef = useRef<{ node: HTMLDivElement; height: number; top: number; oldestKey: string } | null>(null);

  const loadEarlierPreservingViewport = async (node: HTMLDivElement) => {
    if (loading || finished || loadingEarlierRef.current || !messages.length) return;
    loadingEarlierRef.current = true;
    const oldest = messages[0];
    const anchor = {
      node,
      height: node.scrollHeight,
      top: node.scrollTop,
      oldestKey: oldest ? oldest.tid || oldest.messageId || `${oldest.sentTime ?? 0}:${oldest.sender?.id ?? ""}` : "",
    };
    historyAnchorRef.current = anchor;
    try {
      await loadEarlier();
      window.requestAnimationFrame(() => {
        if (historyAnchorRef.current !== anchor) return;
        if (scrollRef.current === node) {
          node.scrollTop = anchor.top + (node.scrollHeight - anchor.height);
          lastScrollTopRef.current = node.scrollTop;
        }
        historyAnchorRef.current = null;
        loadingEarlierRef.current = false;
      });
    } catch {
      historyAnchorRef.current = null;
      loadingEarlierRef.current = false;
    }
  };

  useLayoutEffect(() => {
    const key = conversation ? `${conversation.conversationType}:${conversation.conversationId}` : null;
    const latest = messages.at(-1);
    const latestKey = latest ? latest.tid || latest.messageId || `${latest.sentTime ?? 0}:${latest.sender?.id ?? ""}` : null;
    const conversationChanged = key !== lastConversation.current;
    if (conversationChanged) {
      lastMessage.current = null;
      historyAnchorRef.current = null;
    }
    const shouldScrollToLatest = conversationChanged || (Boolean(latestKey) && lastMessage.current === null) || (latestKey !== lastMessage.current && Boolean(latest?.isSender));
    lastConversation.current = key;
    lastMessage.current = latestKey;
    const historyAnchor = historyAnchorRef.current;
    if (historyAnchor && scrollRef.current === historyAnchor.node) {
      const oldest = messages[0];
      const oldestKey = oldest ? oldest.tid || oldest.messageId || `${oldest.sentTime ?? 0}:${oldest.sender?.id ?? ""}` : "";
      if (oldestKey !== historyAnchor.oldestKey) {
        historyAnchor.node.scrollTop = historyAnchor.top + (historyAnchor.node.scrollHeight - historyAnchor.height);
        lastScrollTopRef.current = historyAnchor.node.scrollTop;
        historyAnchorRef.current = null;
        loadingEarlierRef.current = false;
      }
      return;
    }
    if (!shouldScrollToLatest) return;
    const firstFrame = window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
      lastScrollTopRef.current = node.scrollTop;
      window.requestAnimationFrame(() => {
        if (scrollRef.current === node) {
          node.scrollTop = node.scrollHeight;
          lastScrollTopRef.current = node.scrollTop;
        }
      });
    });
    return () => window.cancelAnimationFrame(firstFrame);
  }, [conversation, messages]);

  useEffect(() => {
    setEditingMessage(null);
    setText("");
    setActionsOpen(false);
    setEmojiOpen(false);
    setSelectedMentions([]);
    setMentionOpen(false);
    setMentionQuery("");
    setMentionTriggerIndex(-1);
    setMentionActiveIndex(0);
    loadingEarlierRef.current = false;
    historyAnchorRef.current = null;
    lastScrollTopRef.current = 0;
  }, [conversation?.conversationId, conversation?.conversationType]);

  useEffect(() => {
    if (!actionsOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!actionsMenuRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [actionsOpen]);

  useEffect(() => {
    let cancelled = false;
    setMentionMembers([]);
    setMentionLoading(conversation?.conversationType === 2);
    if (!conversation || conversation.conversationType !== 2) return () => { cancelled = true; };
    void getMentionCandidates(conversation.conversationId).then((members) => {
      if (!cancelled) setMentionMembers(members);
    }).catch(() => {
      if (!cancelled) setMentionMembers([]);
    }).finally(() => {
      if (!cancelled) setMentionLoading(false);
    });
    return () => { cancelled = true; };
  }, [conversation?.conversationId, conversation?.conversationType]);

  const filteredMentionMembers = useMemo(() => {
    const query = mentionQuery.trim().toLocaleLowerCase();
    if (!query) return mentionMembers;
    return mentionMembers.filter((member) => member.name.toLocaleLowerCase().includes(query) || member.id.toLocaleLowerCase().includes(query));
  }, [mentionMembers, mentionQuery]);

  useEffect(() => setMentionActiveIndex(0), [mentionQuery, mentionMembers]);

  useEffect(() => {
    if (!conversation || loading || finished || !messages.length) return;
    const frame = window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node && node.scrollHeight <= node.clientHeight + 300) void loadEarlierPreservingViewport(node);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversation?.conversationId, conversation?.conversationType, finished, loading, messages.length]);

  if (!conversation) return <main className="jw-im-empty-surface tyn-main tyn-chat-content aside-collapsed"><div className="tyn-chat-body tyn-chat-none-box"><div className="tyn-chat-none-bg"><div className="blank-main-box"><div className="blank-main-icon" /><div className="blank-main-title fontcolor-title">欢迎来到您的私密聊天空间</div><div className="blank-main-content fontcolor-second">从列表中选择一个聊天，开始浏览您的消息，或开启一段新的对话</div></div></div></div></main>;
  const name = conversationName(conversation);
  const selectionMode = selectedMessageIds.length > 0;
  const selectKey = (message: ChatMessage) => message.tid || message.messageId || "";
  const toggleSelected = (message: ChatMessage) => {
    const key = selectKey(message);
    if (!key) return;
    setSelectedMessageIds((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };
  const submit = async () => {
    if (!text.trim()) return;
    if (!editingMessage && sending) return;
    const value = text;
    const mentionMessage = conversation.conversationType === 2 ? buildMentionMessage(value, selectedMentions) : { content: value };
    setText("");
    if (editingMessage) {
      try {
        await editMessage(editingMessage, mentionEditorContent(editingMessage, value));
        setEditingMessage(null);
      } catch { setText(value); }
      return;
    }
    setEmojiOpen(false);
    setMentionOpen(false);
    const sendingTask = sendText(mentionMessage.content, mentionMessage.mentionInfo);
    setSelectedMentions([]);
    window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
      lastScrollTopRef.current = node.scrollTop;
    });
    try { await sendingTask; } catch { /* Failed optimistic messages remain available for resend. */ }
  };
  const beginEdit = (message: ChatMessage) => {
    setReply(null);
    setMentionOpen(false);
    setSelectedMentions([]);
    setEditingMessage(message);
    setText(mentionEditorText(message));
  };
  const cancelEdit = () => {
    setEditingMessage(null);
    setSelectedMentions([]);
    setMentionOpen(false);
    setText("");
  };
  const beginReply = (message: ChatMessage) => {
    if (editingMessage) {
      setEditingMessage(null);
      setSelectedMentions([]);
      setText("");
    }
    setMentionOpen(false);
    setReply(message);
  };
  const selectMention = (member: MentionCandidate) => {
    const cursor = inputRef.current?.selectionStart ?? text.length;
    const token = mentionTokenAt(text, cursor);
    const triggerIndex = token?.index ?? mentionTriggerIndex;
    if (triggerIndex < 0) return;
    const tokenEnd = token ? cursor : triggerIndex + 1;
    const inserted = `@${member.name} `;
    const nextText = `${text.slice(0, triggerIndex)}${inserted}${text.slice(tokenEnd)}`;
    const nextCursor = triggerIndex + inserted.length;
    setText(nextText);
    setSelectedMentions((current) => [...current, member]);
    setMentionOpen(false);
    setMentionQuery("");
    setMentionTriggerIndex(-1);
    setMentionActiveIndex(0);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };
  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const cursor = event.target.selectionStart ?? value.length;
    setText(value);
    setSelectedMentions((current) => value ? current.filter((member) => value.includes(`@${member.name} `)) : []);
    const token = !editingMessage && conversation.conversationType === 2 ? mentionTokenAt(value, cursor) : null;
    if (token) {
      setMentionOpen(true);
      setMentionQuery(token.query);
      setMentionTriggerIndex(token.index);
    } else {
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTriggerIndex(-1);
    }
  };
  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (mentionOpen && filteredMentionMembers.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionActiveIndex((current) => (current + 1) % filteredMentionMembers.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionActiveIndex((current) => (current - 1 + filteredMentionMembers.length) % filteredMentionMembers.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        selectMention(filteredMentionMembers[Math.min(mentionActiveIndex, filteredMentionMembers.length - 1)]);
        return;
      }
    }
    if (event.key === "Escape" && mentionOpen) {
      setMentionOpen(false);
      return;
    }
    if (event.key === "Escape" && editingMessage) {
      cancelEdit();
    } else if (event.key === "Escape" && emojiOpen) {
      setEmojiOpen(false);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      setMentionOpen(false);
      void submit();
    }
  };
  const insertEmoji = (emoji: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    const nextCursor = start + emoji.length;
    setText((current) => `${current.slice(0, start)}${emoji}${current.slice(end)}`);
    window.requestAnimationFrame(() => {
      const currentInput = inputRef.current;
      currentInput?.focus();
      currentInput?.setSelectionRange(nextCursor, nextCursor);
    });
  };
  const handleMessageScroll = async (event: React.UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    const scrollingUp = node.scrollTop < lastScrollTopRef.current || node.scrollTop === 0;
    lastScrollTopRef.current = node.scrollTop;
    if (!scrollingUp || node.scrollTop > 300 || loading || finished || loadingEarlierRef.current || !messages.length) return;
    await loadEarlierPreservingViewport(node);
  };
  const orderedMessages = messages;
  const visiblePinnedMessage = pinnedMessage?.message?.name && (pinnedMessage.message.messageId || pinnedMessage.message.tid) ? pinnedMessage : null;
  return (
    <main className="jw-im-chat-surface tyn-main tyn-chat-content aside-collapsed">
      <div className="jg-chat-root">
      <header className="jw-im-chat-header tyn-chat-head">
        <div className="tyn-media-group"><ChatAvatar className="tyn-size-md jg-size-md tyn-conver-avatar" name={name} userId={conversation.conversationId} src={conversation.conversationPortrait} size="sm" />
        <div className="jw-im-chat-title tyn-media-col tyn-conver-header-title"><div className="tyn-media-row"><h2 className="name">{name}</h2></div><div className="tyn-media-row"><span className="meta">{conversation.conversationType === 2 ? "群聊" : `@${name}`}</span></div></div></div>
        <ul className="jw-im-chat-actions tyn-list-inline gap gap-1 ms-auto jg-conversation-header-tools">
          <li ref={actionsMenuRef}><button type="button" className="tool btn btn-icon btn-light wr wr-more-dot" onClick={(event) => { event.stopPropagation(); setActionsOpen((current) => !current); }} title="会话设置" aria-expanded={actionsOpen}><MoreHorizontal aria-hidden="true" /></button>
            {actionsOpen ? <ConversationActions conversation={conversation} onClose={() => setActionsOpen(false)} /> : null}
          </li>
        </ul>
        {visiblePinnedMessage ? <div className="jg-pinned-box"><div className="jg-pinned-info"><div className="jg-pinned-icon wr wr-top-s" /><ul className="jg-pinned-content"><li className="jg-pinned-item content"><ChatAvatar className="jg-top-avatar" name={visiblePinnedMessage.message.sender?.name || visiblePinnedMessage.message.sender?.id || "用户"} userId={visiblePinnedMessage.message.sender?.id} src={visiblePinnedMessage.message.sender?.portrait} /><div>{visiblePinnedMessage.message.sender?.name || "用户"}：<span>{messageText(visiblePinnedMessage.message)}</span></div></li><li className="jg-pinned-item operator">由 <span className="name">{visiblePinnedMessage.operator?.name || "你"}</span> 置顶</li></ul></div><ul className="jg-pinned-tools"><li><button type="button" className="jg-pinned-item wr wr-close" title="取消置顶" aria-label="取消置顶" onClick={() => void pinMessage(visiblePinnedMessage.message, false)}><span className="sr-only">取消置顶</span></button></li></ul></div> : null}
      </header>
      <div className="jw-im-message-scroll tyn-chat-body scroll-container" ref={scrollRef} onScroll={(event) => void handleMessageScroll(event)}>
        <div className="tyn-reply">
        {finished && messages.length ? <div className="tyn-reply-separator tyn-without"><span className="tyn-separator-item">没有更多啦</span></div> : null}
        {!loading && !messages.length ? <EmptyState icon={<MessageCircle />} title="开始聊天" description={`向 ${name} 发送第一条消息`} /> : null}
        {orderedMessages.flatMap((message, index) => {
          const key = selectKey(message) || `${message.sentTime}:${message.sender?.id}`;
          const previous = orderedMessages[index - 1];
          const showTimeline = message.name !== "notify" && (!previous || timeGroup(message.sentTime) !== timeGroup(previous.sentTime));
          return [
            showTimeline ? <div className="tyn-reply-separator" key={`${key}:timeline`}><span className="tyn-separator-item">{timeSeparatorText(message.sentTime)}</span></div> : null,
            <MessageItem key={key} message={message} compact={index === orderedMessages.length - 1 || orderedMessages[index + 1]?.sender?.id === message.sender?.id} onForward={(item) => setForwarding([item])} onEdit={beginEdit} onReply={beginReply} onStartMultiSelect={(item) => setSelectedMessageIds([selectKey(item)])} selectionMode={selectionMode} selected={selectedMessageIds.includes(selectKey(message))} onToggleSelected={toggleSelected} />,
          ];
        })}
        </div>
      </div>
      {!selectionMode ? <div className="jw-im-composer-message-panels">
        <ComposerMessagePanel mode="edit" message={editingMessage} onClose={cancelEdit} />
        <ComposerMessagePanel mode="reply" message={replyTo} onClose={() => setReply(null)} />
      </div> : null}
      {selectionMode ? <footer className="jw-im-selection-bar"><button onClick={() => setSelectedMessageIds([])}><X size={16} />取消</button><span>已选择 {selectedMessageIds.length} 条消息</span><button className="is-primary" onClick={() => setForwarding(messages.filter((message) => selectedMessageIds.includes(selectKey(message))))}><Forward size={16} />转发</button></footer> : <footer className="jw-im-composer tyn-chat-form" style={{ "--composer-height": "180px" } as React.CSSProperties}>
        <div className="tyn-composer-shell"><div className="tyn-composer-resize-handle" />
        {mentionOpen ? <MentionPicker members={filteredMentionMembers} activeIndex={mentionActiveIndex} loading={mentionLoading} onSelect={selectMention} /> : null}
        <div className="jw-im-composer-row tyn-chat-form-enter tyn-conversation-input">
          <div className="tyn-composer-toolbar"><div className="tyn-composer-left tyn-composer-toolbar-left">
          <input ref={fileRef} className="sr-only" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void sendFile(file); event.target.value = ""; }} />
          <div className="tyn-toolbar-icon-wrap tyn-toolbar-emoji-wrap">
            <button className="btn btn-icon btn-light btn-md wr wr-smile tyn-toolbar-icon" title="表情" aria-expanded={emojiOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => setEmojiOpen((current) => !current)}><SmilePlus size={20} /></button>
            {emojiOpen ? <EmojiPicker onClose={() => setEmojiOpen(false)} onSelect={insertEmoji} /> : null}
          </div>
          <button className="btn btn-icon btn-light btn-md wr wr-huixing tyn-toolbar-icon" onClick={() => fileRef.current?.click()} disabled={sending} title="发送文件"><Paperclip size={19} /></button>
          </div></div>
          <div className="tyn-chat-form-inner"><div className="tyn-composer-editor"><textarea ref={inputRef} className="tyn-chat-form-input" value={text} onChange={handleComposerChange} placeholder={editingMessage ? "修改消息" : `发送消息给 ${name}`} onKeyDown={handleComposerKeyDown} /></div></div>
        </div>
        </div>
      </footer>}
      {forwarding ? <ForwardModal messages={forwarding} conversations={conversations} onClose={() => { setForwarding(null); setSelectedMessageIds([]); }} /> : null}
      {groupManagerOpen ? <GroupManagementModal conversation={conversation} onClose={() => setGroupManagerOpen(false)} /> : null}
      </div>
    </main>
  );
}

function ConversationActions({ conversation, onClose, onManageGroup }: { conversation: ChatConversation; onClose: () => void; onManageGroup?: () => void }) {
  const reload = useJuggleChatStore((state) => state.loadConversations);
  const [busy, setBusy] = useState(false);
  const applyConversationPatch = (patch: Partial<ChatConversation>) => {
    useJuggleChatStore.setState((state) => {
      const matches = (item: ChatConversation | null) => Boolean(item && item.conversationId === conversation.conversationId && item.conversationType === conversation.conversationType);
      return {
        conversations: state.conversations.map((item) => matches(item) ? { ...item, ...patch } : item),
        activeConversation: matches(state.activeConversation) ? { ...state.activeConversation!, ...patch } : state.activeConversation,
      };
    });
  };
  const run = async (action: () => Promise<unknown>, patch: Partial<ChatConversation>) => {
    setBusy(true);
    try {
      await action();
      applyConversationPatch(patch);
      await reload();
      onClose();
    } finally { setBusy(false); }
  };
  const nextIsTop = !Boolean(conversation.isTop);
  const nextUndisturbType = conversation.undisturbType === 1 ? 0 : 1;
  return (
    <div className="jw-im-conversation-actions">
      {onManageGroup ? <button onClick={onManageGroup}>群管理</button> : null}
      <button disabled={busy} onClick={() => void run(
        () => juggleChatRuntime.setTopConversation(conversation, nextIsTop),
        { isTop: nextIsTop },
      )}>{conversation.isTop ? "取消置顶" : "置顶会话"}</button>
      <button disabled={busy} onClick={() => void run(
        () => juggleChatRuntime.disturbConversation(conversation, nextUndisturbType),
        { undisturbType: nextUndisturbType },
      )}>{conversation.undisturbType === 1 ? "关闭免打扰" : "消息免打扰"}</button>
    </div>
  );
}

function ForwardModal({ messages, conversations, onClose }: { messages: ChatMessage[]; conversations: ChatConversation[]; onClose: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"single" | "merge">("single");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filtered = conversations.filter((conversation) => conversationName(conversation).toLowerCase().includes(query.trim().toLowerCase()));
  const submit = async () => {
    const targets = conversations.filter((conversation) => selected.includes(`${conversation.conversationType}:${conversation.conversationId}`));
    if (!targets.length) return setError("请选择至少一个会话");
    setBusy(true);
    setError(null);
    try {
      if (mode === "merge" && messages.length > 1) {
        await juggleChatRuntime.forwardMerged(messages, targets, "聊天记录");
      } else {
        for (const message of messages) await juggleChatRuntime.forwardMessage(message, targets);
      }
      onClose();
    } catch (forwardError) {
      setError(toError(forwardError));
      setBusy(false);
    }
  };
  return <div className="jw-im-modal-backdrop" onMouseDown={onClose}><section className="jw-im-modal" onMouseDown={(event) => event.stopPropagation()}><header><h3>转发消息</h3><button onClick={onClose}><X size={18} /></button></header>
    {messages.length > 1 ? <div className="jw-im-contact-tabs"><button className={mode === "single" ? "is-active" : ""} onClick={() => setMode("single")}>逐条转发</button><button className={mode === "merge" ? "is-active" : ""} disabled={messages.length > 20} title={messages.length > 20 ? "合并转发最多支持 20 条" : undefined} onClick={() => setMode("merge")}>合并转发</button></div> : null}
    <label className="jw-im-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" /></label>
    <div className="jw-im-member-picker">{filtered.map((conversation) => { const key = `${conversation.conversationType}:${conversation.conversationId}`; const checked = selected.includes(key); const label = conversationName(conversation); return <button key={key} className={checked ? "is-selected" : ""} onClick={() => setSelected(checked ? selected.filter((item) => item !== key) : [...selected, key])}><ChatAvatar name={label} userId={conversation.conversationId} src={conversation.conversationPortrait} size="sm" /><span>{label}</span><span className="jw-im-check">{checked ? <Check size={14} /> : null}</span></button>; })}</div>
    {error ? <div className="jw-im-form-error"><CircleAlert size={16} />{error}</div> : null}
    <button className="jw-im-primary-button" disabled={busy || !selected.length} onClick={() => void submit()}>{busy ? <LoaderCircle className="is-spinning" size={17} /> : <Forward size={17} />}转发给 {selected.length || 0} 个会话</button>
  </section></div>;
}

export function FavoritesSurface() {
  const conversations = useJuggleChatStore((state) => state.conversations);
  const setView = useJuggleChatStore((state) => state.setView);
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [offset, setOffset] = useState("");
  const [loading, setLoading] = useState(false);
  const [finished, setFinished] = useState(false);
  const [forwarding, setForwarding] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ message: ChatMessage; x: number; y: number } | null>(null);
  const load = async (reset = false) => {
    if (loading || (!reset && finished)) return;
    setLoading(true);
    setError(null);
    try {
      const result = await juggleChatRuntime.getFavoriteMessages(reset ? "" : offset, 20);
      const incoming = result.list ?? [];
      setItems(reset ? incoming : [...items, ...incoming]);
      setOffset(result.offset ?? "");
      setFinished(incoming.length < 20 || !result.offset);
    } catch (loadError) { setError(toError(loadError)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(true); }, []);
  const remove = async (message: ChatMessage) => {
    try {
      await juggleChatRuntime.removeFavorite(message);
      setItems((current) => current.filter((item) => item.messageId !== message.messageId));
    } catch (removeError) { setError(toError(removeError)); }
  };
  return <aside className="jw-im-favorites-surface tyn-common-aside show-caside"><header className="tyn-common-header tyn-settings-header"><ul className="tools"><li className="tool close" onClick={() => setView("settings")}><span className="tyn-aside-back-icon" /></li></ul><div className="title">我的收藏</div><div className="title-none" /></header>
    <div className="tyn-common-body tyn-settings-body"><div className="jg-aside-favorite-body">{loading && !items.length ? <div className="loading-container"><div className="loading-spinner" /><div className="loading-text">加载中</div></div> : null}{!loading && !items.length && !error ? <div className="favorite-body-none"><div className="tyn-blank-box"><div className="icon" /><div className="title">没有收藏消息</div></div></div> : null}<ul className="jg-fav-list">{items.map((message) => <li className="jg-fav-item" key={message.messageId || message.tid} onContextMenu={(event) => { event.preventDefault(); setMenu({ message, x: event.clientX, y: event.clientY }); }}><div className="jg-fav-msg"><div className="jg-fav-msg-text"><MessageContent message={message} /></div></div><div className="jg-fav-info"><div className="jg-fav-title"><ChatAvatar className="jg-fav-avatar tyn-sd-avatar" name={message.sender?.name || message.sender?.id || "用户"} userId={message.sender?.id} src={message.sender?.portrait} size="sm" /><div className="jg-fav-label jg-ellipsis">{message.sender?.name || message.sender?.id || "用户"} | 收藏消息</div></div><div className="jg-fav-time">{formatTime(message.sentTime)}</div></div></li>)}{!finished ? <li><button className="jw-im-load-earlier" disabled={loading} onClick={() => void load()}>{loading ? <LoaderCircle className="is-spinning" size={14} /> : null}加载更多</button></li> : null}</ul></div></div>
    {menu ? <><div className="fade-bg fade-bg-conversationlist" onClick={() => setMenu(null)} /><div className="dropdown-menu dropdown-menu-xxs fadein-o4 jg-fav-context-menu show" style={{ left: menu.x, top: menu.y }}><ul className="tyn-list-links"><li className="tyn-list-link"><button className="wr wr-share" onClick={() => { setForwarding([menu.message]); setMenu(null); }}><span>转发…</span></button></li><li className="tyn-list-link"><button className="wr wr-delete" onClick={() => { void remove(menu.message); setMenu(null); }}><span>删除</span></button></li></ul></div></> : null}
    {forwarding ? <ForwardModal messages={forwarding} conversations={conversations} onClose={() => setForwarding(null)} /> : null}
  </aside>;
}

const GROUP_PERMISSIONS = [
  ["group_add_member_right", "添加成员"],
  ["group_top_msg_right", "置顶消息"],
  ["group_mention_all_right", "@ 所有人"],
  ["group_edit_msg_right", "编辑群消息"],
  ["group_send_msg_right", "在群内发言"],
  ["group_set_msg_life_right", "设置消息定时删除"],
] as const;

function groupMemberId(member: ChatGroupMember) {
  return String(member.user_id || member.id || "");
}

function groupMemberName(member: ChatGroupMember) {
  return String(member.group_display_name || member.name || member.nickname || groupMemberId(member));
}

function extractGroupMembers(data: unknown): ChatGroupMember[] {
  if (Array.isArray(data)) return data as ChatGroupMember[];
  if (!data || typeof data !== "object") return [];
  const value = data as Record<string, unknown>;
  const list = value.items ?? value.members ?? value.administrators ?? value.admins ?? value.list;
  return Array.isArray(list) ? list as ChatGroupMember[] : [];
}

function assertSuccess(result: ApiEnvelope<unknown>, fallback: string) {
  if (result.code !== 0) throw new Error(result.msg || `${fallback}：${result.code}`);
}

function GroupManagementModal({ conversation, onClose }: { conversation: ChatConversation; onClose: () => void }) {
  const contacts = useJuggleChatStore((state) => state.contacts);
  const currentUser = useJuggleChatStore((state) => state.user);
  const reloadContacts = useJuggleChatStore((state) => state.loadContacts);
  const reloadConversations = useJuggleChatStore((state) => state.loadConversations);
  const [group, setGroup] = useState<ChatGroupInfo | null>(null);
  const [notice, setNotice] = useState("");
  const [admins, setAdmins] = useState<string[]>([]);
  const [name, setName] = useState(conversationName(conversation));
  const [displayName, setDisplayName] = useState("");
  const [picker, setPicker] = useState<"invite" | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [infoResult, membersResult, noticeResult, adminsResult] = await Promise.all([
        getGroupInfo(conversation.conversationId),
        getGroupMembers(conversation.conversationId),
        getGroupNotice(conversation.conversationId),
        getGroupAdmins(conversation.conversationId).catch(() => ({ code: 0, data: [] } as ApiEnvelope<ChatGroupMember[]>)),
      ]);
      assertSuccess(infoResult, "获取群资料失败");
      assertSuccess(membersResult, "获取群成员失败");
      const data = infoResult.data ?? {};
      const members = extractGroupMembers(membersResult.data);
      const initialMembers = members.length ? members : extractGroupMembers((data as Record<string, unknown>).members);
      const next: ChatGroupInfo = {
        id: conversation.conversationId,
        nickname: String(data.group_name ?? conversationName(conversation)),
        avatar: data.group_portrait ? String(data.group_portrait) : undefined,
        members: initialMembers,
        member_count: Number(data.member_count ?? initialMembers.length),
        member_offset: data.member_offset ? String(data.member_offset) : undefined,
        my_role: Number(data.my_role ?? 0),
        grp_display_name: data.grp_display_name ? String(data.grp_display_name) : "",
        group_management: data.group_management && typeof data.group_management === "object" ? data.group_management as Record<string, number> : {},
      };
      setGroup(next);
      setName(next.nickname);
      setDisplayName(next.grp_display_name ?? "");
      if (noticeResult.code === 0) setNotice(noticeResult.data?.content ?? "");
      if (adminsResult.code === 0) setAdmins(extractGroupMembers(adminsResult.data).map(groupMemberId).filter(Boolean));
    } catch (loadError) { setError(toError(loadError)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [conversation.conversationId]);

  const run = async (action: () => Promise<ApiEnvelope<unknown>>, label: string, refresh = true) => {
    setBusy(true);
    setError(null);
    try {
      assertSuccess(await action(), `${label}失败`);
      if (refresh) await load();
      await Promise.all([reloadContacts(), reloadConversations()]);
      return true;
    } catch (runError) { setError(toError(runError)); return false; }
    finally { setBusy(false); }
  };

  if (loading && !group) return <div className="jw-im-modal-backdrop"><section className="jw-im-modal jw-im-modal-loading"><LoaderCircle className="is-spinning" /><span>正在加载群资料…</span></section></div>;
  if (!group) return <div className="jw-im-modal-backdrop" onMouseDown={onClose}><section className="jw-im-modal" onMouseDown={(event) => event.stopPropagation()}><header><h3>群管理</h3><button onClick={onClose}><X size={18} /></button></header>{error ? <div className="jw-im-form-error"><CircleAlert size={16} />{error}</div> : null}<button className="jw-im-primary-button" onClick={() => void load()}>重试</button></section></div>;

  const canManage = group.my_role === 1 || group.my_role === 2;
  const isOwner = group.my_role === 1;
  const existingIds = new Set(group.members.map(groupMemberId));
  const availableContacts = contacts.filter((contact) => !existingIds.has(contact.user_id));
  const groupMuted = Number(group.group_management.group_mute ?? 0) === 1;
  const historyVisible = Number(group.group_management.group_his_msg_visible ?? 0) === 1;

  return <div className="jw-im-modal-backdrop" onMouseDown={onClose}><section className="jw-im-modal jw-im-group-modal" onMouseDown={(event) => event.stopPropagation()}><header><h3>群管理</h3><button onClick={onClose}><X size={18} /></button></header>
    <div className="jw-im-group-summary"><ChatAvatar name={group.nickname} userId={group.id} src={group.avatar} size="lg" /><div><strong>{group.nickname}</strong><span>{group.member_count} 位成员 · {isOwner ? "群主" : group.my_role === 2 ? "管理员" : "成员"}</span></div></div>
    {error ? <div className="jw-im-form-error"><CircleAlert size={16} />{error}</div> : null}
    <section className="jw-im-group-section"><h4>群资料</h4><label className="jw-im-field"><span>群名称</span><span className="jw-im-inline-field"><input value={name} disabled={!canManage} onChange={(event) => setName(event.target.value)} /><button disabled={!canManage || busy || !name.trim()} onClick={() => void run(() => updateGroup(group.id, { group_name: name.trim(), group_portrait: group.avatar || "" }), "更新群名称")}>保存</button></span></label><label className="jw-im-field"><span>我的群昵称</span><span className="jw-im-inline-field"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><button disabled={busy} onClick={() => void run(() => setGroupDisplayName(group.id, displayName.trim()), "更新群昵称")}>保存</button></span></label><label className="jw-im-field"><span>群公告</span><textarea value={notice} disabled={!canManage} onChange={(event) => setNotice(event.target.value)} rows={3} /><button className="jw-im-secondary-button" disabled={!canManage || busy} onClick={() => void run(() => setGroupNotice(group.id, notice), "更新群公告")}>保存群公告</button></label></section>
    <section className="jw-im-group-section"><div className="jw-im-group-section-title"><h4>群成员（{group.members.length}）</h4>{canManage ? <button onClick={() => { setPicker("invite"); setSelected([]); }}><UserPlus size={14} />邀请</button> : null}</div><div className="jw-im-group-members">{group.members.map((member) => { const id = groupMemberId(member); const admin = admins.includes(id); const self = id === currentUser?.id; return <div key={id}><ChatAvatar name={groupMemberName(member)} userId={id} src={String(member.avatar || member.portrait || "") || undefined} size="sm" /><span><strong>{groupMemberName(member)}</strong><small>{admin ? "管理员" : id === currentUser?.id ? "我" : id}</small></span>{isOwner && !self ? <span className="jw-im-member-actions"><button title={admin ? "取消管理员" : "设为管理员"} disabled={busy} onClick={() => void run(() => admin ? removeGroupAdmins(group.id, [id]) : addGroupAdmins(group.id, [id]), admin ? "取消管理员" : "设置管理员")}><Shield size={14} /></button><button title="转让群主" disabled={busy} onClick={() => { if (window.confirm(`确定将群主转让给 ${groupMemberName(member)}？`)) void run(() => transferGroupOwner(group.id, id), "转让群主"); }}><Crown size={14} /></button></span> : null}{canManage && !self ? <button className="jw-im-member-remove" title="移出群聊" disabled={busy} onClick={() => { if (window.confirm(`确定移除 ${groupMemberName(member)}？`)) void run(() => removeGroupMembers(group.id, [id]), "移除成员"); }}><UserMinus size={14} /></button> : null}</div>; })}</div></section>
    {canManage ? <section className="jw-im-group-section"><h4>群设置</h4><label className="jw-im-switch-row"><span>全员禁言</span><input type="checkbox" checked={groupMuted} disabled={busy} onChange={(event) => void run(() => setGroupMute(group.id, event.target.checked), "设置群禁言")} /></label><label className="jw-im-switch-row"><span>新成员可查看历史消息</span><input type="checkbox" checked={historyVisible} disabled={busy} onChange={(event) => void run(() => setGroupHistoryVisible(group.id, event.target.checked), "设置历史消息权限")} /></label>{isOwner ? GROUP_PERMISSIONS.map(([key, label]) => <label className="jw-im-select-row" key={key}><span>谁可以{label}</span><select value={Number(group.group_management[key] ?? 7)} disabled={busy} onChange={(event) => void run(() => setGroupManagement(group.id, key, Number(event.target.value)), `设置${label}`)}><option value={7}>全部成员</option><option value={1}>仅群主</option><option value={3}>群主和管理员</option></select></label>) : null}</section> : null}
    <section className="jw-im-group-danger">{isOwner ? <button disabled={busy} onClick={() => { if (window.confirm("解散后群聊将不可恢复，确定继续？")) void run(() => dismissGroup(group.id), "解散群聊", false).then((ok) => { if (ok) onClose(); }); }}><Trash2 size={15} />解散群聊</button> : <button disabled={busy} onClick={() => { if (window.confirm("确定退出当前群聊？")) void run(() => quitGroup(group.id), "退出群聊", false).then((ok) => { if (ok) onClose(); }); }}><LogOut size={15} />退出群聊</button>}</section>
    {picker === "invite" ? <div className="jw-im-submodal"><header><h4>邀请群成员</h4><button onClick={() => setPicker(null)}><X size={16} /></button></header><div className="jw-im-member-picker">{availableContacts.map((contact) => { const checked = selected.includes(contact.user_id); const label = contact.friend_display_name || contact.nickname || contact.user_id; return <button key={contact.user_id} className={checked ? "is-selected" : ""} onClick={() => setSelected(checked ? selected.filter((id) => id !== contact.user_id) : [...selected, contact.user_id])}><ChatAvatar name={label} userId={contact.user_id} src={contact.avatar} size="sm" /><span>{label}</span><span className="jw-im-check">{checked ? <Check size={14} /> : null}</span></button>; })}</div><button className="jw-im-primary-button" disabled={busy || !selected.length} onClick={() => void run(() => inviteGroupMembers(group.id, selected), "邀请成员").then((ok) => { if (ok) setPicker(null); })}><UserPlus size={16} />邀请 {selected.length} 人</button></div> : null}
  </section></div>;
}

export function CallOverlay() {
  const phase = useJuggleCallStore((state) => state.phase);
  const session = useJuggleCallStore((state) => state.session);
  const peerName = useJuggleCallStore((state) => state.peerName);
  const peerPortrait = useJuggleCallStore((state) => state.peerPortrait);
  const mediaType = useJuggleCallStore((state) => state.mediaType);
  const mutedMic = useJuggleCallStore((state) => state.mutedMic);
  const mutedCamera = useJuggleCallStore((state) => state.mutedCamera);
  const error = useJuggleCallStore((state) => state.error);
  const accept = useJuggleCallStore((state) => state.accept);
  const reject = useJuggleCallStore((state) => state.reject);
  const hangup = useJuggleCallStore((state) => state.hangup);
  const toggleMic = useJuggleCallStore((state) => state.toggleMic);
  const toggleCamera = useJuggleCallStore((state) => state.toggleCamera);
  const clearError = useJuggleCallStore((state) => state.clearError);
  const videoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase === "idle" || mediaType !== 1 || !session || !videoRef.current) return;
    const member = session.members?.find((item: { id?: string }) => item.id && item.id !== session.currentUser?.id)
      ?? session.members?.find((item: { id?: string }) => item.id);
    if (member?.id) session.setVideoView?.([{ userId: member.id, videoElement: videoRef.current }]);
  }, [mediaType, phase, session]);

  if (phase === "idle" && !error) return null;
  if (error && phase === "idle") return <div className="jw-im-call-error"><CircleAlert size={16} /><span>{error}</span><button onClick={clearError}><X size={15} /></button></div>;
  const incoming = phase === "incoming";
  return (
    <div className="jw-im-call-backdrop">
      <section className={cx("jw-im-call-panel", mediaType === 1 && "is-video")}>
        {mediaType === 1 ? <div className="jw-im-call-video" ref={videoRef} /> : null}
        <div className="jw-im-call-person"><ChatAvatar name={peerName} src={peerPortrait} size="lg" /><h3>{peerName}</h3><p>{incoming ? "邀请你进行通话" : phase === "connected" ? "通话中" : "正在连接…"}</p></div>
        <div className="jw-im-call-controls">
          {incoming ? <><button className="is-accept" onClick={accept}><Phone size={20} /></button><button className="is-hangup" onClick={reject}><PhoneOff size={20} /></button></> : <><button onClick={toggleMic}>{mutedMic ? <MicOff size={19} /> : <Mic size={19} />}</button>{mediaType === 1 ? <button onClick={toggleCamera}>{mutedCamera ? <VideoOff size={19} /> : <Video size={19} />}</button> : null}<button className="is-hangup" onClick={hangup}><PhoneOff size={20} /></button></>}
        </div>
      </section>
    </div>
  );
}

export function ContactsSurface() {
  const contacts = useJuggleChatStore((state) => state.contacts);
  const groups = useJuggleChatStore((state) => state.groups);
  const loading = useJuggleChatStore((state) => state.loadingContacts);
  const reload = useJuggleChatStore((state) => state.loadContacts);
  const open = useJuggleChatStore((state) => state.openContact);
  const [selected, setSelected] = useState<ChatContact | null>(null);
  const [query, setQuery] = useState("");
  const [groupOpen, setGroupOpen] = useState(false);
  const [tab, setTab] = useState<"friends" | "groups">("friends");
  const searchInputRef = useListSearchShortcut();
  const source = tab === "friends" ? contacts : tab === "groups" ? groups : [];
  const filtered = source.filter((contact) => `${contact.friend_display_name || ""}${contact.nickname || ""}${contact.user_id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const grouped = useMemo(() => {
    const values = new Map<string, ChatContact[]>();
    for (const contact of filtered) {
      const name = contact.friend_display_name || contact.nickname || contact.user_id;
      const letter = /^[a-z]/i.test(name) ? name[0]!.toUpperCase() : "#";
      values.set(letter, [...(values.get(letter) ?? []), contact]);
    }
    return [...values.entries()].sort(([left], [right]) => left === "#" ? 1 : right === "#" ? -1 : left.localeCompare(right));
  }, [filtered]);
  const categories = [
    { id: "friends" as const, name: "组织内联系人", icon: "jg-tab-icon--contact" },
    { id: "groups" as const, name: "群组", icon: "jg-tab-icon--group" },
  ];
  const currentCategory = categories.find((item) => item.id === tab)!;
  return (
    <div className="jw-im-contacts-layout tyn-contact tyn-content tyn-content-full-height tyn-chat has-aside-base show-content">
      <aside className="jw-im-list-pane tyn-aside tyn-contact-aside">
        <header className="jw-im-pane-header jg-conversations-header jw-im-list-filter-header">
          <div className="jw-im-list-filter">
            <Search aria-hidden="true" />
            <input ref={searchInputRef} type="search" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null); }} placeholder="搜索通讯录" aria-label="搜索通讯录" />
            {query ? <button type="button" className="jw-im-list-filter-clear" onClick={() => setQuery("")} title="清除搜索" aria-label="清除搜索"><X /></button> : <kbd className="jw-im-list-filter-shortcut">{isMacPlatform() ? "⌘⇧F" : "Ctrl+Shift+F"}</kbd>}
          </div>
          <ListAddMenu onCreateGroup={() => setGroupOpen(true)} />
        </header>
        <div className="tyn-aside-body"><ul className="tyn-aside-list jw-im-contact-categories">{categories.map((item) => <li key={item.id} className={cx("tyn-aside-item tyn-aside-contact-item", tab === item.id && "active")} onClick={() => { setTab(item.id); setSelected(null); setQuery(""); }}><div className="tyn-media-group"><span className={cx("jg-tab-icon", item.icon)} /><span className="name">{item.name}</span></div><div className="jg-item-right"><div className="jg-arrow" /></div></li>)}</ul></div>
      </aside>
      <main className="jw-im-contact-main tyn-main tyn-chat-content aside-collapsed">
        <header className="jw-im-pane-header jg-conversations-header jw-im-contact-main-header"><ul className="jg-convers-tools"><li className="jg-conversation-tool">{selected ? <button className="jw-im-contact-back" onClick={() => setSelected(null)}><ChevronLeft size={17} /></button> : null}{selected ? selected.friend_display_name || selected.nickname || selected.user_id : currentCategory.name}</li></ul></header>
        <div className="tyn-chat-body tyn-contact-body">
          {selected ? <div className="jw-im-contact-detail"><ChatAvatar className="jg-size-rg tyn-conver-avatar" size="lg" name={selected.friend_display_name || selected.nickname || selected.user_id} userId={selected.user_id} src={selected.avatar} /><h2>{selected.friend_display_name || selected.nickname || selected.user_id}</h2><p>ID: @{selected.user_id}</p><button className="jw-im-primary-button contact-send-msg" onClick={() => void open(selected)}><MessageCircle size={17} />发消息</button></div> : <div className="tyn-contact-wrapper">{loading ? <div className="newui-empty-state"><LoaderCircle className="is-spinning" /></div> : grouped.map(([letter, items]) => <section className="jg-contact-group" key={letter}><div className="jg-group-letter">{letter}</div><ul className="jg-group-list">{items.map((contact) => { const name = contact.friend_display_name || contact.nickname || contact.user_id; return <li className="jg-group-item" key={contact.user_id} onClick={() => setSelected(contact)}><ChatAvatar className="tyn-size-md jg-size-md" name={name} userId={contact.user_id} src={contact.avatar} /><div className="jg-contact-info"><div className="jg-contact-name">{name}</div></div></li>; })}</ul></section>)}</div>}
        </div>
      </main>
      {groupOpen ? <CreateGroupModal contacts={contacts} onClose={() => setGroupOpen(false)} onCreated={() => { setGroupOpen(false); void reload(); setTab("groups"); }} /> : null}
    </div>
  );
}

function CreateGroupModal({ contacts, onClose, onCreated }: { contacts: ChatContact[]; onClose: () => void; onCreated: () => void }) {
  const [selected, setSelected] = useState<ChatContact[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchResults, setSearchResults] = useState<ChatContact[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const toggleContact = (contact: ChatContact) => {
    setError(null);
    setSelected((prev) => {
      const exists = prev.some((c) => c.user_id === contact.user_id);
      return exists ? prev.filter((c) => c.user_id !== contact.user_id) : [...prev, contact];
    });
  };

  const removeContact = (userId: string) => {
    setSelected((prev) => prev.filter((c) => c.user_id !== userId));
  };

  const isSelected = (userId: string) => selected.some((c) => c.user_id === userId);

  const contactLabel = (contact: ChatContact) => contact.friend_display_name || contact.nickname || contact.user_id;

  const groupedContacts = useMemo(() => {
    const list = showSearch ? searchResults : contacts;
    const map = new Map<string, ChatContact[]>();
    for (const contact of list) {
      const name = contactLabel(contact);
      const letter = /^[a-z]/i.test(name) ? name[0]!.toUpperCase() : "#";
      map.set(letter, [...(map.get(letter) ?? []), contact]);
    }
    return [...map.entries()].sort((a, b) => a[0] === "#" ? 1 : b[0] === "#" ? -1 : a[0].localeCompare(b[0]));
  }, [contacts, searchResults, showSearch]);

  const onSearchChange = (value: string) => {
    setQuery(value);
    if (!value.trim()) {
      setShowSearch(false);
      setSearchResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const keyword = value.trim().toLowerCase();
      const results = contacts.filter((c) => contactLabel(c).toLowerCase().includes(keyword));
      setSearchResults(results);
      setShowSearch(true);
    }, 300);
  };

  const groupName = useMemo(() => {
    if (!selected.length) return "";
    const names = selected.map(contactLabel).join(", ");
    return names.length > 20 ? `${names.slice(0, 20)}...` : names;
  }, [selected]);

  const submit = async () => {
    if (!selected.length) return setError("请至少选择一位联系人");
    setBusy(true);
    try {
      await createGroup(groupName, selected);
      onCreated();
    } catch (createError) { setError(toError(createError)); setBusy(false); }
  };

  const checkboxClass = (userId: string) => {
    if (isSelected(userId)) return "wr-checkbox-checked jw-im-checkbox-checked";
    return "wr-checkbox-empty";
  };

  return (
    <div className="jw-im-modal-backdrop" onMouseDown={onClose}>
      <section className="jw-im-modal jw-im-create-group-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header><h3>创建群组</h3><button onClick={onClose}><X size={18} /></button></header>
        <div className="jw-im-create-group-layout">
          <div className="jw-im-create-group-left">
            <div className="jw-im-create-group-search">
              <Search size={15} />
              <input
                type="text"
                placeholder="搜索成员"
                value={query}
                onChange={(e) => onSearchChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setQuery(""); setShowSearch(false); setSearchResults([]); }
                }}
              />
              {query ? <button type="button" className="jw-im-create-group-search-clear" onClick={() => { setQuery(""); setShowSearch(false); setSearchResults([]); }}><X size={14} /></button> : null}
            </div>
            <div className="jw-im-create-group-contacts">
              {!contacts.length ? (
                <div className="jw-im-create-group-empty">
                  <LoaderCircle className="is-spinning" size={20} />
                  <span>加载中...</span>
                </div>
              ) : groupedContacts.length === 0 ? (
                <div className="jw-im-create-group-empty">
                  <span>暂无搜索结果</span>
                </div>
              ) : (
                groupedContacts.map(([letter, items]) => (
                  <div className="jw-im-create-group-letter-group" key={letter}>
                    <div className="jw-im-create-group-letter">{letter}</div>
                    {items.map((contact) => {
                      const label = contactLabel(contact);
                      return (
                        <button
                          key={contact.user_id}
                          className={cx("jw-im-create-group-contact", isSelected(contact.user_id) && "is-selected")}
                          onClick={() => toggleContact(contact)}
                        >
                          <span className={checkboxClass(contact.user_id)} />
                          <ChatAvatar name={label} userId={contact.user_id} src={contact.avatar} size="sm" />
                          <span className="jw-im-create-group-contact-name">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="jw-im-create-group-right">
            <div className="jw-im-create-group-right-header">
              <div className="jw-im-create-group-right-title">已选择联系人</div>
              <div className="jw-im-create-group-right-count">
                {selected.length === 0 ? "未选择联系人" : `已选择 (${selected.length}) 人`}
              </div>
            </div>
            <div className="jw-im-create-group-right-body">
              {selected.map((contact) => {
                const label = contactLabel(contact);
                return (
                  <div className="jw-im-create-group-selected-item" key={contact.user_id}>
                    <ChatAvatar name={label} userId={contact.user_id} src={contact.avatar} size="sm" />
                    <span className="jw-im-create-group-selected-name">{label}</span>
                    <button className="jw-im-create-group-selected-remove" onClick={() => removeContact(contact.user_id)} title="移除">
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
            {error ? <div className="jw-im-form-error"><CircleAlert size={16} />{error}</div> : null}
            <div className="jw-im-create-group-footer">
              <button className="jw-im-secondary-button" onClick={onClose} disabled={busy}>取消</button>
              <button className="jw-im-primary-button" onClick={() => void submit()} disabled={busy || !selected.length}>
                {busy ? <><LoaderCircle className="is-spinning" size={16} />创建中...</> : "确定"}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export function SettingsSurface() {
  const user = useJuggleChatStore((state) => state.user);
  const setView = useJuggleChatStore((state) => state.setView);
  const settingGroups: Array<Array<{ label: string; icon: string; action?: () => void; value?: string }>> = [
    [
      { label: "通用设置", icon: "jg-setting-row-icon--general" },
      { label: "我的收藏", icon: "jg-setting-row-icon--favorite", action: () => setView("favorites") },
      { label: "我的二维码", icon: "jg-setting-row-icon--qrcode" },
    ],
    [{ label: "账号管理", icon: "jg-setting-row-icon--account" }],
    [
      { label: "用户协议", icon: "jg-setting-row-icon--agreement" },
      { label: "隐私协议", icon: "jg-setting-row-icon--privacy" },
      { label: "版本信息", icon: "jg-setting-row-icon--version", value: "2.5.12" },
    ],
  ];
  return (
    <aside className="jw-im-settings-surface tyn-common-aside show-caside jg-aside-ust-box">
      <header className="tyn-common-header tyn-settings-header"><ul className="tools"><li className="tool close" onClick={() => setView("conversations")}><span className="tyn-aside-back-icon" /></li></ul><div className="title">用户设置</div><div className="title-none" /></header>
      <div className="tyn-common-body tyn-settings-body"><div className="jg-aside-userst-body jg-setting-aside"><div className="jg-setting-panel">
        <section className="jg-setting-profile-card">
          <div className="jg-setting-profile-main"><div className="jg-setting-profile-avatar-wrap"><ChatAvatar className="tyn-ss-avatar jg-setting-profile-avatar" name={user?.name || user?.id || "?"} userId={user?.id} src={user?.portrait} size="lg" /><button className="jg-setting-profile-avatar-action" title="更换头像"><ImageIcon size={13} /></button></div><div className="jg-setting-profile-namebox"><div className="jg-setting-profile-name-row"><div className="jg-setting-profile-name-tooltip"><div className="jg-setting-profile-name" data-title={user?.name || user?.id}>{user?.name || "JuggleChat 用户"}</div></div><button className="jg-setting-profile-name-action" title="编辑昵称"><span className="wr wr-edit" /></button></div></div></div>
          <div className="jg-setting-profile-meta"><span className="jg-setting-profile-label">用户 ID</span><span className="jg-setting-profile-id">{user?.id}</span></div>
        </section>
        {settingGroups.map((group, index) => <section className="jg-setting-group" key={index}>{group.map((item) => <div className={cx("jg-setting-row", item.value && "jg-setting-row-info")} key={item.label} onClick={item.action}><div className="jg-setting-row-main"><span className={cx("jg-setting-row-icon", item.icon)} /><span className="jg-setting-row-text">{item.label}</span></div>{item.value ? <span className="jg-setting-row-value">{item.value}</span> : <span className="jg-setting-row-chevron" />}</div>)}</section>)}
      </div></div></div>
    </aside>
  );
}

export function ConnectionBanner() {
  const status = useJuggleChatStore((state) => state.status);
  const error = useJuggleChatStore((state) => state.error);
  const user = useJuggleChatStore((state) => state.user);
  const acceptLogin = useJuggleChatStore((state) => state.acceptLogin);
  const clearError = useJuggleChatStore((state) => state.clearError);
  if (status !== "disconnected" && status !== "error" && !error) return null;
  return <div className="jw-im-connection-banner"><CircleAlert size={16} /><span>{error || "Chat 网络连接已断开"}</span>{status === "disconnected" && user ? <button onClick={() => void acceptLogin(user)}><RefreshCw size={14} />重连</button> : <button onClick={clearError}><X size={14} /></button>}</div>;
}

function EmptyState(props: { icon: React.ReactNode; title: string; description: string }) {
  return <div className="jw-im-empty"><span>{props.icon}</span><strong>{props.title}</strong><p>{props.description}</p></div>;
}
