import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ChatConnectionScope } from "../src/react-app/domains/jugglechat/docs-message";
import type { ChatConversation } from "../src/react-app/domains/jugglechat/types";

const root = new URL("../src/", import.meta.url);
// Windows 下 URL#pathname 会带前导斜杠（/D:/...），Bun 解析不了，这里归一化。
const modulePath = (path: string) =>
  decodeURIComponent(new URL(path, root).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const host = new EventTarget();
Object.assign(host, {
  localStorage: { getItem: () => null },
  __JUGGLEWORK_ELECTRON__: { invokeDesktop: async () => ({ ok: true }) },
});
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "window", { configurable: true, value: host });
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { visibilityState: "hidden", hasFocus: () => false },
});
const realDateNow = Date.now;
let fakeNow = 1_000_000;
Date.now = () => fakeNow;

let scope: ChatConnectionScope | null = null;
let callCount = 0;
type PageBehavior =
  | { kind: "hang" }
  | { kind: "ok"; conversations?: ChatConversation[] }
  | { kind: "reject"; message: string }
  | { kind: "manual" };
let behavior: PageBehavior = { kind: "ok" };
let manual: { promise: Promise<any>; resolve: (value: any) => void } | null = null;

let connected = true;
const runtime = {
  reset: mock(() => {}),
  connect: async () => {},
  isConnected: () => connected,
  subscribe: () => {},
  initialize: async () => ({}),
  getConversations: (_params: any) => {
    callCount += 1;
    if (behavior.kind === "hang") return new Promise(() => {});
    if (behavior.kind === "reject") return Promise.reject(new Error(behavior.message));
    if (behavior.kind === "manual") {
      manual = (() => {
        let resolve!: (value: any) => void;
        const promise = new Promise<any>((r) => { resolve = r; });
        return { promise, resolve };
      })();
      return manual.promise;
    }
    return Promise.resolve({ conversations: behavior.conversations ?? [], isFinished: true });
  },
  getTotalUnreadCount: async () => ({ count: 0 }),
  getMessages: async () => ({ messages: [], isFinished: true }),
  getTopMessage: async () => ({}),
  clearUnread: async () => {},
};

const actualDen = await import(`${modulePath("app/lib/den.ts")}?chat-loading-actual`);
mock.module(modulePath("app/lib/den.ts"), () => ({
  ...actualDen,
  readDenSettings: () => ({ authToken: "auth", activeOrgId: "org-a", baseUrl: "https://source.test" }),
  readDenIMLoginBootstrap: () => ({
    imUserId: "im-a", token: "im-token", appKey: "app", websocketUrl: "wss://im.test",
  }),
  readDenUserId: () => "user-a",
}));
const actualServer = await import(`${modulePath("app/lib/jugglework-server.ts")}?chat-loading-actual`);
mock.module(modulePath("app/lib/jugglework-server.ts"), () => ({
  ...actualServer,
  createJuggleWorkServerClient: () => ({}),
}));
mock.module(modulePath("react-app/shell/jugglework-connection.ts"), () => ({
  resolveJuggleWorkConnection: async () => ({}),
}));
mock.module(modulePath("react-app/domains/jugglechat/chat-connection.ts"), () => ({
  readChatConnectionScope: () => scope,
}));
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
mock.module(modulePath("react-app/domains/automations/automation-readiness-events.ts"), () => ({
  dispatchAutomationReadinessUnblocked: () => {},
}));

const { useJuggleChatStore: store } = await import("../src/react-app/domains/jugglechat/store");

afterAll(() => {
  mock.restore();
  Date.now = realDateNow;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
let scopeSeq = 0;
function nextScope(key = `scope-${++scopeSeq}`): ChatConnectionScope {
  return Object.freeze({
    key,
    tenantId: "org-a",
    server: "https://source.test",
    userId: "user-a",
    authFingerprint: "4:1",
    imUserId: "im-a",
  });
}
function prepare(next: ChatConnectionScope) {
  scope = next;
  connected = true;
  runtime.connect = async () => {};
  store.setState({
    connectionScope: next,
    status: "connected",
    user: { id: "im-a", token: "im-token", authorization: "Bearer auth", isUsed: true },
    conversations: [],
    conversationsInitialized: false,
    loadingConversations: false,
    error: null,
  });
  callCount = 0;
  manual = null;
}

test("会话请求失败时 loadingConversations 复位并上报错误", async () => {
  prepare(nextScope());
  behavior = { kind: "reject", message: "组织会话分页暂时不可用" };
  await store.getState().loadConversations();
  expect(store.getState().loadingConversations).toBe(false);
  expect(store.getState().error).toContain("分页");
});

test("请求永久挂起后 stale 窗口外的重试会真正发起新请求并结束 loading", async () => {
  prepare(nextScope());
  behavior = { kind: "hang" };
  const first = store.getState().loadConversations();
  await flush();
  expect(store.getState().loadingConversations).toBe(true);
  expect(callCount).toBe(1);

  // 同 scope、未过期：复用挂起的 promise，不重复请求
  const second = store.getState().loadConversations();
  await flush();
  expect(callCount).toBe(1);

  fakeNow += 31_000;
  behavior = { kind: "ok" };
  const third = store.getState().loadConversations();
  await third;
  expect(callCount).toBe(2);
  expect(store.getState().loadingConversations).toBe(false);
  void first;
  void second;
});

test("请求返回时来源已失效，loadingConversations 仍然复位", async () => {
  prepare(nextScope());
  behavior = { kind: "manual" };
  const pending = store.getState().loadConversations();
  await flush();
  expect(store.getState().loadingConversations).toBe(true);
  expect(manual).not.toBeNull();
  scope = null; // 组织/凭据在等待期间失效
  manual!.resolve({ conversations: [], isFinished: true });
  await pending;
  expect(store.getState().loadingConversations).toBe(false);
});

test("连接失败时 status 落到 error，不会停在 initializing", async () => {
  prepare(nextScope());
  connected = false;
  runtime.connect = async () => {
    throw new Error("IM 连接超时，请检查网络后重试");
  };
  await store.getState().bootstrap();
  expect(store.getState().status).toBe("error");
  expect(store.getState().error).toContain("超时");
});

describe("selectConversation / loadEarlierMessages 的 loading 兜底", () => {
  test("历史请求失败后 loadingMessages 复位", async () => {
    prepare(nextScope());
    store.setState({ conversationsInitialized: true });
    runtime.getMessages = async () => { throw new Error("history failed"); };
    await store.getState().selectConversation({ conversationId: "c1", conversationType: 2 } as ChatConversation);
    expect(store.getState().loadingMessages).toBe(false);
    expect(store.getState().error).toContain("history failed");
  });
});
