import { beforeEach, describe, expect, test } from "bun:test";
import { readReadOnlyAutomationMirrors, toReadOnlyAutomationMirror, writeReadOnlyAutomationMirrors } from "../src/react-app/domains/automations/automation-mirror-cache";

const storage = new Map<string, string>();

describe("cross-device automation mirror cache", () => {
  beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, "localStorage", { value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    }, configurable: true });
    Object.defineProperty(globalThis, "window", { value: { dispatchEvent: () => true }, configurable: true });
    Object.defineProperty(globalThis, "CustomEvent", { value: class { constructor(public type: string, public init: unknown) {} }, configurable: true });
  });

  test("keeps only minimal read-only metadata and excludes opaque prompt content", () => {
    const mirror = toReadOnlyAutomationMirror({
      automationId: "automation-other",
      executorDeviceId: "device-other",
      revision: 7,
      display: { name: "Remote task", workspaceName: "Other Mac", lifecycle: "enabled" },
      documentBase64: btoa(JSON.stringify({ prompt: "private prompt" })),
    });
    expect(mirror).toEqual({
      id: "automation-other",
      name: "Remote task",
      workspaceName: "Other Mac",
      lifecycle: "enabled",
      revision: 7,
      executorDeviceId: "device-other",
      compatibility: "incompatible-read-only",
    });
    writeReadOnlyAutomationMirrors("org-1", [mirror!]);
    expect(JSON.stringify([...storage.values()])).not.toContain("private prompt");
    expect(readReadOnlyAutomationMirrors("org-1")).toEqual([mirror]);
  });
});
