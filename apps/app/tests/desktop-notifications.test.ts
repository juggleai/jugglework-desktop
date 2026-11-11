import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { LOCAL_PREFERENCES_KEY } from "../src/react-app/kernel/local-preferences-storage";
import { notifyDesktopEvent } from "../src/react-app/shell/desktop-notifications";

type DesktopCall = { command: string; args: unknown[] };

const storage = new Map<string, string>();
const calls: DesktopCall[] = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};

function setPreference(value: "off" | "important" | "all") {
  localStorageStub.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({ desktopNotifications: value }));
}

function installRuntime({ focused }: { focused: boolean }) {
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: localStorageStub,
      __JUGGLEWORK_ELECTRON__: {
        invokeDesktop: async (command: string, ...args: unknown[]) => {
          calls.push({ command, args });
          return { ok: true };
        },
      },
    },
    configurable: true,
  });

  Object.defineProperty(globalThis, "document", {
    value: {
      visibilityState: focused ? "visible" : "hidden",
      hasFocus: () => focused,
    },
    configurable: true,
  });
}

describe("desktop notifications", () => {
  beforeEach(() => {
    storage.clear();
    calls.length = 0;
    installRuntime({ focused: false });
  });

  test("off suppresses important events", () => {
    setPreference("off");

    notifyDesktopEvent({ type: "task.failed", sessionId: "session-a", errorText: "Boom" });

    expect(calls).toHaveLength(0);
  });

  test("important sends attention events but not completions", async () => {
    setPreference("important");

    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });
    notifyDesktopEvent({ type: "question.asked", sessionId: "session-a", question: "Question: Continue?" });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "desktopNotificationShow",
      args: [{ title: "Question needs your answer", body: "Question: Continue?" }],
    });
  });

  test("all sends task completion notifications", async () => {
    setPreference("all");

    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "desktopNotificationShow",
      args: [{ title: "Task completed", body: "The session finished running." }],
    });
  });

  test("automation failures are important and include an internal details target", async () => {
    setPreference("important");

    notifyDesktopEvent({
      type: "automation.failed",
      automationName: "每日汇总",
      errorText: "连接器需要重新授权",
      href: "/automations/runs",
    });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "desktopNotificationShow",
      args: [{
        title: "Automation failed: 每日汇总",
        body: "连接器需要重新授权",
        href: "/automations/runs",
      }],
    });
  });

  test("product task reminders are important and open the task deep link", async () => {
    setPreference("important");
    notifyDesktopEvent({ type: "product-task.reminder", taskTitle: "Follow up", href: "/tasks/task%2Fone" });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "desktopNotificationShow", args: [{ title: "Task reminder", body: "Follow up", href: "/tasks/task%2Fone" }] });
  });

  test("cloud document mentions preserve the restricted click action", async () => {
    setPreference("important");
    const action = {
      type: "docs.open" as const,
      contractVersion: 1 as const,
      source: {
        server: "https://source.test/deployment",
        userId: "user_a",
        tenantId: "org_a",
        authFingerprint: "4:1234",
      },
      payload: {
        contractVersion: 1 as const,
        eventId: "00000000-0000-4000-8000-000000000001",
        tenantId: "org_a",
        pageId: "page_a",
        kind: "comment.user_mention",
        occurredAt: "2026-11-06T00:00:00Z",
        part: "direct" as const,
      },
      conversationId: "jw_docs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    notifyDesktopEvent({
      type: "docs.collaboration",
      action,
      important: true,
    });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "desktopNotificationShow",
      args: [
        {
          title: "Cloud document notification",
          body: "Someone mentioned you in a cloud document.",
          action,
        },
      ],
    });
  });

  test("group cards never claim every member was mentioned", async () => {
    setPreference("important");
    const action = {
      type: "docs.open" as const,
      contractVersion: 1 as const,
      source: {
        server: "https://source.test/deployment",
        userId: "user_a",
        tenantId: "org_a",
        authFingerprint: "4:1234",
      },
      payload: {
        contractVersion: 1 as const,
        eventId: "00000000-0000-4000-8000-000000000002",
        tenantId: "org_a",
        pageId: "page_a",
        kind: "comment.user_mention",
        occurredAt: "2026-11-06T00:00:00Z",
        part: "group" as const,
      },
      conversationId: "docs_org_a",
    };
    notifyDesktopEvent({
      type: "docs.collaboration",
      action,
      important: false,
    });
    await Promise.resolve();
    expect(calls).toHaveLength(0);

    setPreference("all");
    notifyDesktopEvent({
      type: "docs.collaboration",
      action,
      important: false,
    });
    await Promise.resolve();
    expect(calls[0]).toMatchObject({
      command: "desktopNotificationShow",
      args: [
        {
          title: "Cloud document notification",
          body: "There is a new collaboration update in cloud documents.",
        },
      ],
    });
  });

  test("focused app suppresses native popups", () => {
    setPreference("all");
    installRuntime({ focused: true });

    notifyDesktopEvent({ type: "task.failed", sessionId: "session-a", errorText: "Boom" });

    expect(calls).toHaveLength(0);
  });
});

afterAll(() => {
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalDocument)
    Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});
