export const APP_NAVIGATION_PINS_STORAGE_KEY = "jugglework.navigation.pinnedItems";
export const appNavigationPinsChangedEvent = "jugglework-navigation-pins-changed";

export type PinnableAppNavigationItem = "cloud-docs" | "tasks" | "calendar" | "meetings" | "reviews" | "toon-factory";

const PINNABLE_ITEMS = new Set<PinnableAppNavigationItem>(["cloud-docs", "tasks", "calendar", "meetings", "reviews", "toon-factory"]);

export function parsePinnedAppNavigationItems(raw: string | null | undefined): PinnableAppNavigationItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter(
      (item): item is PinnableAppNavigationItem => (
        typeof item === "string" && PINNABLE_ITEMS.has(item as PinnableAppNavigationItem)
      ),
    )));
  } catch {
    return [];
  }
}

/** 用户从未调整过置顶时，「更多」菜单中的常用入口默认固定到导航栏。 */
export const DEFAULT_PINNED_APP_NAVIGATION_ITEMS: readonly PinnableAppNavigationItem[] = ["tasks", "calendar", "meetings"];

export function readPinnedAppNavigationItems(): PinnableAppNavigationItem[] {
  if (typeof window === "undefined") return [...DEFAULT_PINNED_APP_NAVIGATION_ITEMS];
  const raw = window.localStorage.getItem(APP_NAVIGATION_PINS_STORAGE_KEY);
  // 已保存的选择（包括空列表）优先，只有从未保存过时才使用默认置顶。
  if (raw === null) return [...DEFAULT_PINNED_APP_NAVIGATION_ITEMS];
  return parsePinnedAppNavigationItems(raw);
}

export function setAppNavigationItemPinned(
  item: PinnableAppNavigationItem,
  pinned: boolean,
): PinnableAppNavigationItem[] {
  if (typeof window === "undefined") return pinned ? [item] : [];
  const current = readPinnedAppNavigationItems();
  const next = pinned
    ? Array.from(new Set([...current, item]))
    : current.filter((candidate) => candidate !== item);
  window.localStorage.setItem(APP_NAVIGATION_PINS_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent<PinnableAppNavigationItem[]>(
    appNavigationPinsChangedEvent,
    { detail: next },
  ));
  return next;
}
