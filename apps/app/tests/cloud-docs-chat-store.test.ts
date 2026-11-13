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
const bot = (id: string) => "jw_docs_" + (id === "a" ? "a" : "b").repeat(24);
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
    docsConversationContext: async () => { throw new Error("ordinary chat must not call Docs classification"); },
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

test("不同 AppKey 组织切换直接使用 SDK 会话，无 Docs 分类依赖", async () => {
  pages = async () => ({ conversations: [conversation('docs_' + tenant, 3), conversation('regular', 2)], isFinished: true });
  await store.getState().bootstrap();
  expect(store.getState().conversations.map(c => c.conversationId)).toEqual(['docs_a', 'regular']);
  expect(store.getState().totalUnreadCount).toBe(5);
  tenant = 'b'; host.dispatchEvent(new Event(denSettingsChangedEvent));
  expect(store.getState().messages).toEqual([]); await flush();
  expect(store.getState().conversations.map(c => c.conversationId)).toEqual(['docs_b', 'regular']);
  hasIM = false; host.dispatchEvent(new Event(denSettingsChangedEvent));
  expect(store.getState().conversations).toEqual([]);
});

test("Docs 分类服务不可用也不撤下群、历史、回复和置顶", async () => {
  failContext = true;
  await store.getState().bootstrap();
  await store.getState().selectConversation(conversation('docs_a'), { loadHistory: false });
  store.setState({ messages: [message('old')], replyTo: message('reply'), pinnedMessage: { message: message('pinned') } });
  await store.getState().loadConversations();
  expect(store.getState().activeConversation?.conversationId).toBe('docs_a');
  expect(store.getState().replyTo?.messageId).toBe('reply');
  expect(store.getState().pinnedMessage?.message.messageId).toBe('pinned');
});

test("当前 SDK 的完整分页保留全部普通群，不按 Docs 命名筛选", async () => {
  const calls: number[] = [];
  pages = async ({time}) => { calls.push(time); return time===0 ? {conversations:[conversation('docs_b',50,2,200)],isFinished:false} : {conversations:[conversation('docs_a',4,2,100)],isFinished:true}; };
  await store.getState().bootstrap(); expect(calls).toEqual([0,200]);
  expect(store.getState().totalUnreadCount).toBe(54);
});

test("A 历史迟到不能回填 B 或清除其未读", async () => {
  await store.getState().bootstrap();
  const old=deferred<any>(); history=()=>old.promise;
  const pending=store.getState().selectConversation(conversation('docs_a')); await flush();
  tenant='b'; await store.getState().bootstrap();
  old.resolve({messages:[message('old')],isFinished:true}); await pending;
  expect(store.getState().messages).toEqual([]); expect(cleared).toEqual([]);
});

test("当前组织卡片绑定且去重，其他组织载荷无动作", async () => {
  await store.getState().bootstrap();
  history=async()=>({messages:[message('first'),message('duplicate')],isFinished:true});
  await store.getState().selectConversation(conversation('docs_a'));
  expect(store.getState().messages).toHaveLength(1);
  expect(docsMessageSource(store.getState().messages[0])).not.toBeNull();
});
