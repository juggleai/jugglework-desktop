import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { UIMessage } from "ai";

import { getMessagesText } from "@/components/chat/utils";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";

const MIN_NAVIGATION_WIDTH_PX = 840;
const MIN_SCROLL_OVERFLOW_PX = 48;
const ACTIVE_LINE_VIEWPORT_RATIO = 0.28;
const ACTIVE_LINE_MAX_PX = 180;
const PREVIEW_MAX_LENGTH = 240;

export type SessionQuickNavigationEntry = {
  messageId: string;
  preview: string;
};

function userMessagePreview(message: UIMessage) {
  const text = getMessagesText([message]).replace(/\s+/g, " ").trim();
  if (text) {
    return text.length > PREVIEW_MAX_LENGTH
      ? `${text.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`
      : text;
  }

  const attachments = message.parts
    .flatMap((part) => part.type === "file" && part.filename?.trim() ? [part.filename.trim()] : [])
    .join(", ");
  return attachments.length > PREVIEW_MAX_LENGTH
    ? `${attachments.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`
    : attachments;
}

/** One timeline stop per visible user-authored task turn. */
export function buildSessionQuickNavigationEntries(messages: UIMessage[]): SessionQuickNavigationEntry[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" || !message.id.trim()) return [];
    const preview = userMessagePreview(message);
    return preview ? [{ messageId: message.id, preview }] : [];
  });
}

/** Resolve the last task turn that has crossed the reading activation line. */
export function resolveActiveQuickNavigationIndex(
  messageTops: number[],
  activationLine: number,
  atBottom: boolean,
) {
  if (messageTops.length === 0) return -1;
  if (atBottom) return messageTops.length - 1;

  let activeIndex = 0;
  for (let index = 0; index < messageTops.length; index += 1) {
    if ((messageTops[index] ?? Number.POSITIVE_INFINITY) > activationLine) break;
    activeIndex = index;
  }
  return activeIndex;
}

function messageElementsById(container: HTMLElement) {
  const elements = new Map<string, HTMLElement>();
  for (const element of container.querySelectorAll('[data-message-role="user"][data-message-id]')) {
    if (!(element instanceof HTMLElement)) continue;
    const messageId = element.dataset.messageId?.trim();
    if (messageId) elements.set(messageId, element);
  }
  return elements;
}

type SessionQuickNavigationProps = {
  messages: UIMessage[];
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onNavigate: (messageId: string, behavior?: ScrollBehavior) => void;
};

export function SessionQuickNavigation({
  messages,
  containerRef,
  contentRef,
  onNavigate,
}: SessionQuickNavigationProps) {
  const entries = useMemo(() => buildSessionQuickNavigationEntries(messages), [messages]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const frameRef = useRef<number | null>(null);
  const zh = currentLocale() === "zh";

  const refresh = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const overflow = container.scrollHeight - container.clientHeight;
    setVisible(
      entries.length > 1 &&
      container.clientWidth >= MIN_NAVIGATION_WIDTH_PX &&
      overflow >= MIN_SCROLL_OVERFLOW_PX,
    );
    if (entries.length === 0) return;

    const containerRect = container.getBoundingClientRect();
    const elements = messageElementsById(container);
    const messageTops = entries.map((entry) =>
      elements.get(entry.messageId)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
    );
    const activationLine = containerRect.top + Math.min(
      ACTIVE_LINE_MAX_PX,
      container.clientHeight * ACTIVE_LINE_VIEWPORT_RATIO,
    );
    const atBottom = overflow - container.scrollTop <= 2;
    const nextIndex = resolveActiveQuickNavigationIndex(messageTops, activationLine, atBottom);
    if (nextIndex >= 0) setActiveIndex(nextIndex);
  }, [containerRef, entries]);

  const scheduleRefresh = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      refresh();
    });
  }, [refresh]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    scheduleRefresh();
    container.addEventListener("scroll", scheduleRefresh, { passive: true });
    window.addEventListener("resize", scheduleRefresh);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleRefresh);
    resizeObserver?.observe(container);
    if (contentRef.current) resizeObserver?.observe(contentRef.current);

    return () => {
      container.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      resizeObserver?.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [containerRef, contentRef, scheduleRefresh]);

  if (!visible) return null;

  const navigationLabel = zh ? "任务快速导航" : "Task quick navigation";
  return (
    <nav
      aria-label={navigationLabel}
      className="pointer-events-none absolute inset-y-5 left-2 z-20 flex w-11 py-1"
      data-testid="session-quick-navigation"
    >
      <div
        className="grid h-full w-full items-center"
        style={{ gridTemplateRows: `repeat(${entries.length}, minmax(0, 1fr))` }}
      >
        {entries.map((entry, index) => {
          const active = index === activeIndex;
          const ratio = entries.length <= 1 ? 0 : index / (entries.length - 1);
          const previewPosition = ratio < 0.2
            ? "top-0"
            : ratio > 0.8
              ? "bottom-0"
              : "top-1/2 -translate-y-1/2";
          const itemLabel = zh
            ? `跳转到第 ${index + 1} 个任务：${entry.preview}`
            : `Jump to task ${index + 1}: ${entry.preview}`;

          return (
            <button
              key={entry.messageId}
              type="button"
              aria-label={itemLabel}
              aria-current={active ? "step" : undefined}
              className="group pointer-events-auto relative flex h-full min-h-1 w-full items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2"
              onClick={() => {
                setActiveIndex(index);
                onNavigate(entry.messageId, "smooth");
              }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "block h-0.5 rounded-full transition-[width,background-color,opacity] duration-200",
                  active
                    ? "w-7 bg-foreground opacity-100"
                    : "w-2.5 bg-muted-foreground/45 group-hover:w-5 group-hover:bg-foreground/70 group-hover:opacity-100 group-focus-visible:w-5 group-focus-visible:bg-foreground/70",
                )}
              />
              <span
                className={cn(
                  "pointer-events-none absolute left-9 z-40 w-[min(22rem,calc(100vw-7rem))] rounded-2xl border border-border/70 bg-popover/95 px-4 py-3 text-left text-popover-foreground opacity-0 shadow-[0_16px_40px_rgba(15,23,42,0.14)] backdrop-blur-xl transition-[opacity,transform] duration-200 group-hover:translate-x-1 group-hover:opacity-100 group-focus-visible:translate-x-1 group-focus-visible:opacity-100 dark:shadow-[0_18px_44px_rgba(0,0,0,0.42)]",
                  previewPosition,
                )}
                role="tooltip"
              >
                <span className="line-clamp-3 block text-sm font-medium leading-6 tracking-[-0.01em]">
                  {entry.preview}
                </span>
                <span className="mt-1.5 block text-[11px] tabular-nums text-muted-foreground">
                  {zh ? `任务 ${index + 1} / ${entries.length}` : `Task ${index + 1} / ${entries.length}`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
