import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../jugglechat/types";
import { MeetingIcon } from "./meeting-icons";

const messageKeys = (message: ChatMessage) => [
  message.messageId ? `message:${message.messageId}` : "",
  message.tid ? `tid:${message.tid}` : "",
].filter(Boolean);
type Toast = { id: number; message: ChatMessage; exiting?: boolean };

function MessageToast({ toast, onDismiss, onRemove, onOpen }: {
  toast: Toast; onDismiss: (id: number) => void; onRemove: (id: number) => void; onOpen: () => void;
}) {
  useEffect(() => {
    // Keep the row until its exit transition finishes; this also cleans up when
    // reduced motion disables animation or the window is backgrounded.
    const timer = setTimeout(() => toast.exiting ? onRemove(toast.id) : onDismiss(toast.id), toast.exiting ? 220 : 6000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.exiting, onDismiss, onRemove]);
  const name = toast.message.sender?.name || "参会人";
  return <div className="meeting-toast-slot" data-exiting={!!toast.exiting} aria-hidden={toast.exiting || undefined} inert={toast.exiting || undefined}>
    <div className="meeting-toast-clip"><div className="meeting-message-toast">
    <button className="toast-message" onClick={onOpen} aria-label={`打开聊天，${name}：${toast.message.content.content}`}>
      <span className="toast-avatar" aria-hidden="true">{name.slice(0, 1)}
        {toast.message.sender?.portrait ? <img src={toast.message.sender.portrait} alt="" onError={e => { e.currentTarget.style.display = "none"; }} /> : null}
      </span>
      <span className="toast-copy"><strong>{name}</strong><span>{String(toast.message.content.content)}</span></span>
    </button>
    <button className="toast-close" aria-label="关闭消息提示" onClick={() => onDismiss(toast.id)}><MeetingIcon name="close" width={14} height={14} /></button>
    </div></div>
  </div>;
}

// Keep this mounted while the chat panel changes. Opening chat consumes queued
// messages, so closing it never replays history. Remount for each new meeting.
export function MeetingChatToasts({ messages, open, userId, onOpen }: {
  messages: ChatMessage[]; open: boolean; userId: string; onOpen: () => void;
}) {
  const [cursor] = useState(() => ({
    keys: new Set(messages.flatMap(messageKeys)), objects: new WeakSet(messages),
  }));
  const nextId = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts(items => items.map(item => item.id === id ? { ...item, exiting: true } : item)), []);
  const remove = useCallback((id: number) => setToasts(items => items.filter(item => item.id !== id)), []);
  useEffect(() => {
    const added: Toast[] = [];
    for (const message of messages) {
      const keys = messageKeys(message);
      const seen = cursor.objects.has(message) || keys.some(key => cursor.keys.has(key));
      cursor.objects.add(message);
      keys.forEach(key => cursor.keys.add(key));
      if (!seen && !open && !message.isSender && message.sender?.id !== userId
        && typeof message.content?.content === "string" && message.content.content.trim()) {
        added.push({ id: ++nextId.current, message });
      }
    }
    // The meeting store keeps 300 messages; keep identities bounded as well.
    if (cursor.keys.size > 1200) cursor.keys = new Set(messages.flatMap(messageKeys));
    if (open) setToasts(items => items.length ? [] : items);
    else if (added.length) setToasts(items => {
      const live = [...items.filter(item => !item.exiting), ...added].slice(-3);
      const retained = new Set(live.map(item => item.id));
      return [...items.filter(item => !retained.has(item.id)).map(item => item.exiting ? item : { ...item, exiting: true }), ...live].slice(-6);
    });
  }, [messages, open, userId, cursor]);
  return <div className="meeting-message-toasts" style={open ? { display: "none" } : undefined} role="log" aria-label="会议新消息" aria-live="polite" aria-relevant="additions">
    {toasts.map(toast => <MessageToast key={toast.id} toast={toast} onDismiss={dismiss} onRemove={remove} onOpen={onOpen} />)}
  </div>;
}
