import { afterEach, describe, expect, test } from "bun:test";

import {
  APP_NAVIGATION_PINS_STORAGE_KEY,
  appNavigationPinsChangedEvent,
  parsePinnedAppNavigationItems,
  readPinnedAppNavigationItems,
  setAppNavigationItemPinned,
} from "../src/react-app/shell/app-navigation-pins";

const originalWindow = globalThis.window;
const originalCustomEvent = globalThis.CustomEvent;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: originalCustomEvent });
});

describe("app navigation pins", () => {
  test("accepts only known, unique pinnable destinations", () => {
    expect(parsePinnedAppNavigationItems('["reviews","unknown","reviews"]')).toEqual(["reviews"]);
    expect(parsePinnedAppNavigationItems("not json")).toEqual([]);
    expect(parsePinnedAppNavigationItems(null)).toEqual([]);
  });

  test("persists pin changes and broadcasts them in the current window", () => {
    const storage = memoryStorage();
    const events: Array<{ type: string; detail?: unknown }> = [];
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: class<T> {
        type: string;
        detail: T | undefined;
        constructor(type: string, init?: { detail?: T }) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        dispatchEvent: (event: { type: string; detail?: unknown }) => {
          events.push(event);
          return true;
        },
      },
    });

    expect(setAppNavigationItemPinned("reviews", true)).toEqual(["reviews"]);
    expect(readPinnedAppNavigationItems()).toEqual(["reviews"]);
    expect(storage.getItem(APP_NAVIGATION_PINS_STORAGE_KEY)).toBe('["reviews"]');
    expect(events.at(-1)).toEqual({ type: appNavigationPinsChangedEvent, detail: ["reviews"] });

    expect(setAppNavigationItemPinned("reviews", false)).toEqual([]);
    expect(readPinnedAppNavigationItems()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: appNavigationPinsChangedEvent, detail: [] });
  });
});
