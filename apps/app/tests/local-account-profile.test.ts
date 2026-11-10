import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  applyStoredAccountProfile,
  writeStoredAccountProfile,
} from "../src/react-app/domains/settings/cloud/local-account-profile";

const originalWindow = globalThis.window;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: memoryStorage() },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("server-authoritative account profile", () => {
  test("does not let a stale local profile override server fields", () => {
    writeStoredAccountProfile("user_one", { name: "Old local name", avatar: "data:image/png;base64,old" });
    const profile = applyStoredAccountProfile({
      id: "user_one",
      email: "alice@example.com",
      name: "Server name",
      avatar: "https://cloud.example/avatar/new",
    });
    expect(profile.name).toBe("Server name");
    expect(profile.avatar).toBe("https://cloud.example/avatar/new");
  });

  test("uses the cache only when an older server omits profile fields", () => {
    writeStoredAccountProfile("user_one", { name: "Cached name", avatar: "https://cache.example/avatar" });
    const profile = applyStoredAccountProfile({
      id: "user_one",
      email: "alice@example.com",
      name: null,
      avatar: null,
    });
    expect(profile.name).toBe("Cached name");
    expect(profile.avatar).toBe("https://cache.example/avatar");
  });
});
