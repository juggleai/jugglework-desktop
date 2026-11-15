import type {
  JuggleWorkSessionMessage,
  JuggleWorkSessionMessagePage,
  JuggleWorkSessionMessagesResponse,
} from "@/app/lib/jugglework-server";

export const SESSION_HISTORY_PAGE_SIZE = 100;

export type SessionHistoryGeneration = {
  pages: JuggleWorkSessionMessagesResponse[];
  pageParams: unknown[];
};

export type SessionHistoryData = {
  pages: JuggleWorkSessionMessagesResponse[];
  pageParams: unknown[];
  rootCursor?: string | null;
  detached?: SessionHistoryGeneration[];
};

export const sessionHistoryKey = (workspaceId: string, sessionId: string) =>
  ["react-session-older-history", workspaceId, sessionId] as const;

export function resolveOlderHistoryCursor(input: {
  initialPage: JuggleWorkSessionMessagePage | null | undefined;
  pages: JuggleWorkSessionMessagesResponse[];
  pageParams: unknown[];
}) {
  const page = input.pages.at(-1)?.page ?? input.initialPage;
  const cursor = page?.hasOlder === true && typeof page.olderCursor === "string" && page.olderCursor
    ? page.olderCursor
    : null;
  if (!cursor) return { cursor: null, loopDetected: false };

  const consumed = new Set(input.pageParams.filter((value): value is string => typeof value === "string"));
  return consumed.has(cursor)
    ? { cursor: null, loopDetected: true }
    : { cursor, loopDetected: false };
}

export function reconcileSessionHistoryRoot(
  data: SessionHistoryData | undefined,
  rootCursor: string | null,
): SessionHistoryData {
  if (!data) return { pages: [], pageParams: [], rootCursor, detached: [] };
  if (data.rootCursor === rootCursor) return data;

  const detached = [...(data.detached ?? [])];
  if (data.pages.length > 0) {
    detached.unshift({ pages: data.pages, pageParams: data.pageParams });
  }
  return { pages: [], pageParams: [], rootCursor, detached };
}

function overlappingPageIndex(
  generation: SessionHistoryGeneration,
  page: JuggleWorkSessionMessagesResponse,
) {
  const ids = new Set(page.items.map((message) => message.info.id));
  return generation.pages.findIndex((candidate) => candidate.items.some((message) => ids.has(message.info.id)));
}

function sameMessageIds(
  left: JuggleWorkSessionMessagesResponse,
  right: JuggleWorkSessionMessagesResponse,
) {
  return left.items.length === right.items.length
    && left.items.every((message, index) => message.info.id === right.items[index]?.info.id);
}

function normalizeNewestFirstPages(entries: Array<{
  page: JuggleWorkSessionMessagesResponse;
  pageParam: unknown;
  stableIndex: number;
}>) {
  return entries.sort((left, right) => {
    const rightIndices = new Map(right.page.items.map((message, index) => [message.info.id, index]));
    const shared = left.page.items.flatMap((message, leftIndex) => {
      const rightIndex = rightIndices.get(message.info.id);
      return rightIndex === undefined ? [] : [{ leftIndex, rightIndex }];
    });
    if (shared.length === 0) return left.stableIndex - right.stableIndex;

    // Pages are internally chronological. Relative prefix lengths around the
    // first shared message reveal which page reaches farther into the past,
    // without relying on optional timestamps or opaque cursor values.
    const first = shared[0]!;
    if (first.leftIndex !== first.rightIndex) {
      return first.leftIndex - first.rightIndex;
    }

    // If both pages begin at the same boundary, the page extending farther
    // after their last shared message is the newer one.
    const last = shared.at(-1)!;
    const leftSuffix = left.page.items.length - last.leftIndex - 1;
    const rightSuffix = right.page.items.length - last.rightIndex - 1;
    if (leftSuffix !== rightSuffix) return rightSuffix - leftSuffix;
    return left.stableIndex - right.stableIndex;
  });
}

export function appendSessionHistoryPage(input: {
  data: SessionHistoryData;
  cursor: string;
  page: JuggleWorkSessionMessagesResponse;
}): SessionHistoryData {
  const entries = input.data.pages.map((page, index) => ({
    page,
    pageParam: input.data.pageParams[index],
    stableIndex: index,
  }));
  entries.push({ page: input.page, pageParam: input.cursor, stableIndex: entries.length });
  const detached = [...(input.data.detached ?? [])];
  const generationIndex = detached.findIndex((generation) => overlappingPageIndex(generation, input.page) >= 0);
  if (generationIndex >= 0) {
    const [overlap] = detached.splice(generationIndex, 1);
    const pageIndex = overlappingPageIndex(overlap!, input.page);
    overlap!.pages.slice(pageIndex).forEach((page, offset) => {
      if (entries.some((entry) => sameMessageIds(entry.page, page))) return;
      entries.push({
        page,
        pageParam: overlap!.pageParams[pageIndex + offset],
        stableIndex: entries.length,
      });
    });
  }

  const normalized = normalizeNewestFirstPages(entries);

  return {
    ...input.data,
    pages: normalized.map((entry) => entry.page),
    pageParams: normalized.map((entry) => entry.pageParam),
    // A complete active chain is authoritative; unreachable archives cannot
    // be joined without inventing ordering or continuity.
    detached: input.page.page.hasOlder ? detached : [],
  };
}

/** Older pages arrive newest-first; each page itself is chronological. */
export function mergeHistoricalSessionMessages(
  pages: JuggleWorkSessionMessagesResponse[],
  currentMessages: JuggleWorkSessionMessage[],
) {
  const chronological = [...pages].reverse().flatMap((page) => page.items);
  const values = new Map<string, JuggleWorkSessionMessage>();
  const order: string[] = [];
  for (const message of [...chronological, ...currentMessages]) {
    if (!values.has(message.info.id)) order.push(message.info.id);
    values.set(message.info.id, message);
  }
  return order.flatMap((id) => {
    const message = values.get(id);
    return message ? [message] : [];
  });
}

export function applyRawMessageRevertCursor(
  messages: JuggleWorkSessionMessage[],
  revertMessageId: string | null | undefined,
  hasUnloadedOlder = false,
) {
  if (!revertMessageId) return messages;
  const index = messages.findIndex((message) => message.info.id === revertMessageId);
  if (index < 0) return hasUnloadedOlder ? [] : messages;
  return messages.slice(0, index);
}

export function removeMessageFromSessionHistory(
  data: SessionHistoryData | undefined,
  messageId: string,
): SessionHistoryData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((message) => message.info.id !== messageId),
    })),
    detached: data.detached?.map((generation) => ({
      ...generation,
      pages: generation.pages.map((page) => ({
        ...page,
        items: page.items.filter((message) => message.info.id !== messageId),
      })),
    })),
  };
}

export function applyRevertToSessionHistory(
  data: SessionHistoryData | undefined,
  revertMessageId: string,
): SessionHistoryData | undefined {
  if (!data) return data;
  const chronological = mergeHistoricalSessionMessages(data.pages, []);
  const index = chronological.findIndex((message) => message.info.id === revertMessageId);
  // The cursor can be in the current snapshot rather than an older page. Keep
  // history until the render layer evaluates the complete merged raw window.
  if (index < 0) return data;
  const retained = new Set(chronological.slice(0, index).map((message) => message.info.id));
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((message) => retained.has(message.info.id)),
    })),
    detached: [],
  };
}
