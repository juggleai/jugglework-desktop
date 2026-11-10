import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import {
  docsMessageSource,
  type ChatConnectionScope,
} from "../src/react-app/domains/jugglechat/docs-message";
import type {
  ChatConversation,
  ChatMessage,
} from "../src/react-app/domains/jugglechat/types";

const root = new URL("../src/", import.meta.url);
const modulePath = (path: string) => new URL(path, root).pathname;
const host = new EventTarget();
const desktopCalls: Array<{ command: string; args: unknown[] }> = [];
const localStorageValues = new Map<string, string>([
  ["jugglework.preferences", JSON.stringify({ desktopNotifications: "all" })],
]);
Object.assign(host, {
  localStorage: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
  },
  __JUGGLEWORK_ELECTRON__: {
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      desktopCalls.push({ command, args });
      return { ok: true };
    },
  },
});
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: host,
});
const bot = (id: string) => "jw_docs_" + (id === "a" ? "a" : "b").repeat(32);
let tenant = "a",
  hasIM = true,
  failContext = false;
let pages: (params: { time: number }) => Promise<any>;
let history: () => Promise<any>;
const cleared: string[] = [];
const listeners = new Map<string, Function>();
const scope = (): ChatConnectionScope | null =>
  hasIM
    ? {
        key: tenant,
        tenantId: tenant,
        server: "https://source.test/prefix",
        userId: "source-user",
        authFingerprint: "4:1234",
        imUserId: "shared-im-user",
      }
    : null;
const runtime = {
  reset: mock(() => {}),
  connect: async () => {},
  isConnected: () => true,
  subscribe: (name: string, listener: Function) => {
    listeners.set(name, listener);
  },
  getConversations: (params: any) => pages(params),
  getMessages: () => history(),
  getTopMessage: async () => ({}),
  clearUnread: async (c: ChatConversation) => {
    cleared.push(c.conversationId);
  },
};
// TIPS: Bun 的模块 mock 会影响同进程加载的其他测试；保留真实导出，仅替换本用例依赖的网络状态。
const actualDen = await import(
  `${modulePath("app/lib/den.ts")}?cloud-docs-chat-store-actual`
);
mock.module(modulePath("app/lib/den.ts"), () => ({
  ...actualDen,
  getDenMcpUrl: () => "https://source.test/prefix/mcp",
  readDenSettings: () => ({ authToken: "auth", activeOrgId: tenant }),
  readDenIMLoginBootstrap: () =>
    hasIM ? { imUserId: "shared-im-user", token: "same-token" } : null,
  createDenClient: () => ({
    docsConversationContext: async (id: string, ids: string[]) => {
      if (failContext) throw new Error("offline");
      return {
        tenantId: id,
        botIMUserId: bot(id),
        groupId: "docs_" + id,
        groups: ids.map((conversationId) => ({
          conversationId,
          managed: conversationId.startsWith("docs_"),
          currentTenant: conversationId === "docs_" + id,
        })),
      };
    },
  }),
}));
const actualJuggleWorkServer = await import(
  `${modulePath("app/lib/jugglework-server.ts")}?cloud-docs-chat-store-actual`
);
mock.module(modulePath("app/lib/jugglework-server.ts"), () => ({
  ...actualJuggleWorkServer,
  createJuggleWorkServerClient: () => ({}),
}));
mock.module(modulePath("react-app/shell/jugglework-connection.ts"), () => ({
  resolveJuggleWorkConnection: async () => ({}),
}));
mock.module(
  modulePath("react-app/domains/jugglechat/chat-connection.ts"),
  () => ({ readChatConnectionScope: scope }),
);
mock.module(modulePath("react-app/domains/jugglechat/runtime.ts"), () => ({
  juggleChatRuntime: runtime,
}));
mock.module(modulePath("react-app/domains/jugglechat/skill-bridge.ts"), () => ({
  startJuggleChatSkillBridge: () => {},
}));
mock.module(modulePath("react-app/domains/jugglechat/api.ts"), () => ({
  getMembers: async () => ({ members: [] }),
  getChatGroupsForContacts: async () => [],
}));
mock.module(
  modulePath("react-app/domains/automations/automation-readiness-events.ts"),
  () => ({ dispatchAutomationReadinessUnblocked: () => {} }),
);
const { useJuggleChatStore: store } =
  await import("../src/react-app/domains/jugglechat/store");
const { denSettingsChangedEvent } =
  await import("../src/app/lib/den-session-events");
afterAll(() => {
  mock.restore();
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalDocument)
    Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});
const conversation = (
  id: string,
  unread = 1,
  type = 2,
  sortTime = 100,
): ChatConversation => ({
  conversationId: id,
  conversationType: type,
  unreadCount: unread,
  sortTime,
});
const message = (id: string, tenantId = "a"): ChatMessage => ({
  ...conversation("docs_" + tenantId),
  messageId: id,
  sender: { id: bot(tenantId) },
  name: "jw:docs-notification",
  content: {
    contractVersion: 1,
    eventId: "00000000-0000-4000-8000-000000000001",
    tenantId,
    pageId: "page_1",
    kind: "comment.created",
    occurredAt: "2026-11-06T00:00:00Z",
    part: "group",
  },
});
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: host,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "hidden",
      hasFocus: () => false,
    },
  });
  hasIM = false;
  await store.getState().bootstrap();
  tenant = "a";
  hasIM = true;
  failContext = false;
  cleared.length = 0;
  desktopCalls.length = 0;
  pages = async () => ({
    conversations: [
      conversation("docs_a", 3),
      conversation("docs_b", 7),
      conversation("regular", 2),
      conversation(bot("b"), 9, 1),
    ],
    isFinished: true,
  });
  history = async () => ({ messages: [], isFinished: true });
});

test("共用 App 和 IM 凭据时仅汇总当前组织文档会话；无聊天组件时切换也立即清空", async () => {
  await store.getState().bootstrap();
  expect(store.getState().conversations.map((c) => c.conversationId)).toEqual([
    "docs_a",
    "regular",
  ]);
  expect(store.getState().totalUnreadCount).toBe(5);
  tenant = "b";
  host.dispatchEvent(new Event(denSettingsChangedEvent));
  expect(store.getState().messages).toEqual([]);
  expect(store.getState().totalUnreadCount).toBe(0);
  await flush();
  expect(store.getState().conversations.map((c) => c.conversationId)).toEqual([
    "docs_b",
    "regular",
    bot("b"),
  ]);
  expect(store.getState().totalUnreadCount).toBe(18);
  hasIM = false;
  host.dispatchEvent(new Event(denSettingsChangedEvent));
  expect(store.getState().conversations).toEqual([]);
  expect(store.getState().totalUnreadCount).toBe(0);
});

test("同 App 的其他组织实时卡片不产生系统通知，当前组织只通知一次", async () => {
  await store.getState().bootstrap();
  listeners.get("message")!(message("other", "b"), scope());
  await flush();
  expect(desktopCalls).toHaveLength(0);
  listeners.get("message")!(message("current"), scope());
  await flush();
  expect(desktopCalls).toHaveLength(1);
  listeners.get("message")!(message("duplicate"), scope());
  await flush();
  expect(desktopCalls).toHaveLength(1);
});

test("完整翻页后再发布未读，不把第一页当作全部会话", async () => {
  const calls: number[] = [];
  pages = async ({ time }) => {
    calls.push(time);
    return time === 0
      ? {
          conversations: [conversation("docs_b", 50, 2, 200)],
          isFinished: false,
        }
      : {
          conversations: [conversation("docs_a", 4, 2, 100)],
          isFinished: true,
        };
  };
  await store.getState().bootstrap();
  expect(calls).toEqual([0, 200]);
  expect(store.getState().totalUnreadCount).toBe(4);
});

test("A 历史迟到时即使 B→A 返回同一凭据也不回填、不清未读", async () => {
  await store.getState().bootstrap();
  const old = deferred<any>();
  history = () => old.promise;
  const pending = store.getState().selectConversation(conversation("docs_a"));
  await flush();
  tenant = "b";
  await store.getState().bootstrap();
  tenant = "a";
  await store.getState().bootstrap();
  old.resolve({ messages: [message("old")], isFinished: true });
  await pending;
  expect(store.getState().messages).toEqual([]);
  expect(cleared).toEqual([]);
});

test("离线历史绑定来源并按事件去重，另一组织会话不能进入历史或清未读", async () => {
  await store.getState().bootstrap();
  history = async () => ({
    messages: [message("first"), message("duplicate")],
    isFinished: true,
  });
  await store.getState().selectConversation(conversation("docs_b"));
  expect(cleared).toEqual([]);
  await store.getState().selectConversation(conversation("docs_a"));
  expect(store.getState().messages).toHaveLength(1);
  expect(docsMessageSource(store.getState().messages[0])?.scope.tenantId).toBe(
    "a",
  );
  expect(cleared).toEqual(["docs_a"]);
  listeners.get("message-updated")!({
    ...message("first"),
    content: { ...message("first").content, contractVersion: 2 },
  });
  expect(docsMessageSource(store.getState().messages[0])).toBeNull();
});

test("源分类失败即撤下群历史、回复和置顶，保留普通私聊", async () => {
  await store.getState().bootstrap();
  await store
    .getState()
    .selectConversation(conversation("docs_a"), { loadHistory: false });
  store.setState({
    messages: [message("old")],
    replyTo: message("reply"),
    pinnedMessage: { message: message("pinned") },
  });
  failContext = true;
  listeners.get("message")!(
    { ...message("new"), conversationId: "new_unknown_group" },
    scope(),
  );
  await flush();
  expect(store.getState().activeConversation).toBeNull();
  expect(store.getState().messages).toEqual([]);
  expect(store.getState().pinnedMessage).toBeNull();
  expect(store.getState().replyTo).toBeNull();
  expect(store.getState().totalUnreadCount).toBe(0);
});
