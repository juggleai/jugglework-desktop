export const APP_NAVIGATION_PINS_STORAGE_KEY = "jugglework.navigation.pinnedItems";
export const appNavigationPinsChangedEvent = "jugglework-navigation-pins-changed";

export type PinnableAppNavigationItem = "reviews";

const PINNABLE_ITEMS = new Set<PinnableAppNavigationItem>(["reviews"]);

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

export function readPinnedAppNavigationItems(): PinnableAppNavigationItem[] {
  if (typeof window === "undefined") return [];
  return parsePinnedAppNavigationItems(
    window.localStorage.getItem(APP_NAVIGATION_PINS_STORAGE_KEY),
  );
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
