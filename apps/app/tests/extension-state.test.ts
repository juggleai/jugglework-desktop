import { afterEach, describe, expect, mock, test } from "bun:test";

import { JUGGLEWORK_EXTENSION_CATALOG } from "../src/app/constants";
import {
  canSetJuggleWorkExtensionEnabled,
  setJuggleWorkExtensionEnabledWithLifecycle,
} from "../src/react-app/domains/settings/extension-state";

describe("built-in extension catalog lifecycle", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  test("Computer Use enablement connects and removes its MCP instead of writing a passive toggle", async () => {
    const computerUse = JUGGLEWORK_EXTENSION_CATALOG.find((entry) => entry.id === "computer-use")!;
    const connectMcp = mock(async () => true);
    const removeMcp = mock(async () => {});

    expect(canSetJuggleWorkExtensionEnabled(computerUse)).toBe(true);

    await setJuggleWorkExtensionEnabledWithLifecycle(computerUse, true, { connectMcp, removeMcp });
    expect(connectMcp).toHaveBeenCalledWith(computerUse);
    expect(removeMcp).not.toHaveBeenCalled();

    await setJuggleWorkExtensionEnabledWithLifecycle(computerUse, false, { connectMcp, removeMcp });
    expect(removeMcp).toHaveBeenCalledWith("computer-use");
  });

  test.each(["jugglework-voice", "google-workspace", "ollama"])("%s persists a responsive plugin-level enable switch", async (id) => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
        dispatchEvent: mock(() => true),
      },
    });
    const entry = JUGGLEWORK_EXTENSION_CATALOG.find((candidate) => candidate.id === id)!;

    expect(canSetJuggleWorkExtensionEnabled(entry)).toBe(true);
    await setJuggleWorkExtensionEnabledWithLifecycle(entry, true, {
      connectMcp: mock(async () => true),
      removeMcp: mock(async () => {}),
    });

    expect(storage.get(`jugglework.extension.enabled.${id}`)).toBe("1");
  });
});
