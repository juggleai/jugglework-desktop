import { useCallback, useLayoutEffect, useRef, type RefObject, type UIEventHandler } from "react";

export const SESSION_HISTORY_TOP_THRESHOLD_PX = 240;
const USER_SCROLL_INTENT_WINDOW_MS = 600;

export type HistoryThresholdGate = {
  previousScrollTop: number | null;
  consumed: boolean;
};

export function advanceHistoryThresholdGate(input: {
  gate: HistoryThresholdGate;
  scrollTop: number;
  userInitiated: boolean;
  canLoad: boolean;
  threshold?: number;
}): { gate: HistoryThresholdGate; shouldLoad: boolean } {
  const threshold = input.threshold ?? SESSION_HISTORY_TOP_THRESHOLD_PX;
  const previousScrollTop = input.gate.previousScrollTop;
  const inside = input.scrollTop <= threshold;
  const enteredWhileScrollingUp = previousScrollTop !== null
    && previousScrollTop > threshold
    && input.scrollTop < previousScrollTop
    && inside;
  const shouldLoad = input.canLoad
    && input.userInitiated
    && !input.gate.consumed
    && enteredWhileScrollingUp;

  return {
    gate: {
      previousScrollTop: input.scrollTop,
      consumed: inside ? input.gate.consumed || shouldLoad : false,
    },
    shouldLoad,
  };
}

export type VisibleMessageAnchor = {
  messageId: string | null;
  viewportOffset: number;
  scrollHeight: number;
  scrollTop: number;
};

export function firstVisibleMessageAnchor(input: {
  viewportTop: number;
  viewportBottom: number;
  messages: Array<{ messageId: string | null; top: number; bottom: number }>;
}) {
  return input.messages.find((message) =>
    message.messageId !== null
    && message.bottom > input.viewportTop
    && message.top < input.viewportBottom
  ) ?? null;
}

export function resolvePrependScrollTop(input: {
  currentScrollTop: number;
  currentScrollHeight: number;
  anchor: VisibleMessageAnchor;
  currentAnchorOffset: number | null;
}) {
  if (input.currentAnchorOffset !== null && input.anchor.messageId !== null) {
    return input.currentScrollTop + input.currentAnchorOffset - input.anchor.viewportOffset;
  }
  return input.anchor.scrollTop + input.currentScrollHeight - input.anchor.scrollHeight;
}

function messageIdForElement(element: Element) {
  const id = element.getAttribute("data-message-id")?.trim();
  return id ? id : null;
}

function captureVisibleMessageAnchor(container: HTMLElement): VisibleMessageAnchor {
  const viewport = container.getBoundingClientRect();
  const elements = Array.from(container.querySelectorAll("[data-message-id]"));
  const visible = firstVisibleMessageAnchor({
    viewportTop: viewport.top,
    viewportBottom: viewport.bottom,
    messages: elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { messageId: messageIdForElement(element), top: rect.top, bottom: rect.bottom };
    }),
  });

  return {
    messageId: visible?.messageId ?? null,
    viewportOffset: visible ? visible.top - viewport.top : 0,
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
  };
}

function restoreVisibleMessageAnchor(container: HTMLElement, anchor: VisibleMessageAnchor) {
  const viewportTop = container.getBoundingClientRect().top;
  const anchorElement = anchor.messageId
    ? Array.from(container.querySelectorAll("[data-message-id]"))
      .find((element) => messageIdForElement(element) === anchor.messageId)
    : null;
  const currentAnchorOffset = anchorElement
    ? anchorElement.getBoundingClientRect().top - viewportTop
    : null;
  container.scrollTop = resolvePrependScrollTop({
    currentScrollTop: container.scrollTop,
    currentScrollHeight: container.scrollHeight,
    anchor,
    currentAnchorOffset,
  });
}

export function useSessionHistoryScrollController(input: {
  scopeKey: string;
  containerRef: RefObject<HTMLDivElement | null>;
  loadedPageCount: number;
  hasOlder: boolean;
  isLoading: boolean;
  loadOlder: () => Promise<boolean>;
  onBeforeLoad: () => void;
  onAfterRestore: (scrollTop: number) => void;
}) {
  const scopeRef = useRef(input.scopeKey);
  const gateRef = useRef<HistoryThresholdGate>({ previousScrollTop: null, consumed: false });
  const userIntentAtRef = useRef(0);
  const pendingAnchorRef = useRef<VisibleMessageAnchor | null>(null);
  const loadedPageCountRef = useRef(input.loadedPageCount);
  const requestRef = useRef<Promise<boolean> | null>(null);

  if (scopeRef.current !== input.scopeKey) {
    scopeRef.current = input.scopeKey;
    gateRef.current = { previousScrollTop: null, consumed: false };
    userIntentAtRef.current = 0;
    pendingAnchorRef.current = null;
    loadedPageCountRef.current = input.loadedPageCount;
    requestRef.current = null;
  }

  const requestOlder = useCallback(() => {
    if (!input.hasOlder || input.isLoading) return Promise.resolve(false);
    if (requestRef.current) return requestRef.current;
    const container = input.containerRef.current;
    if (!container) return Promise.resolve(false);

    pendingAnchorRef.current = captureVisibleMessageAnchor(container);
    input.onBeforeLoad();
    const request = input.loadOlder().catch(() => false).then((loaded) => {
      if (!loaded) pendingAnchorRef.current = null;
      return loaded;
    }).finally(() => {
      if (requestRef.current === request) requestRef.current = null;
    });
    requestRef.current = request;
    return request;
  }, [input.containerRef, input.hasOlder, input.isLoading, input.loadOlder, input.onBeforeLoad]);

  const markUserScrollIntent = useCallback(() => {
    userIntentAtRef.current = Date.now();
    if (requestRef.current) pendingAnchorRef.current = null;
  }, []);

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    const canLoad = input.hasOlder && !input.isLoading && requestRef.current === null;
    const next = advanceHistoryThresholdGate({
      gate: gateRef.current,
      scrollTop: event.currentTarget.scrollTop,
      userInitiated: Date.now() - userIntentAtRef.current < USER_SCROLL_INTENT_WINDOW_MS,
      canLoad,
    });
    gateRef.current = next.gate;
    if (next.shouldLoad) {
      userIntentAtRef.current = 0;
      void requestOlder();
    }
  }, [input.hasOlder, input.isLoading, requestOlder]);

  useLayoutEffect(() => {
    const previousCount = loadedPageCountRef.current;
    loadedPageCountRef.current = input.loadedPageCount;
    if (input.loadedPageCount <= previousCount) return;
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    const container = input.containerRef.current;
    if (!anchor || !container) return;
    restoreVisibleMessageAnchor(container, anchor);
    input.onAfterRestore(container.scrollTop);
  }, [input.containerRef, input.loadedPageCount, input.onAfterRestore]);

  return { handleScroll, markUserScrollIntent, requestOlder };
}
