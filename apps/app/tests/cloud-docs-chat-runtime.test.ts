import { afterAll, expect, mock, test } from "bun:test";
import type { ChatConnectionScope } from "../src/react-app/domains/jugglechat/docs-message";
const original = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalElements = Object.getOwnPropertyDescriptor(
  globalThis,
  "customElements",
);
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { OSS: {}, location: { origin: "https://test.invalid" } },
});
Object.defineProperty(globalThis, "customElements", {
  configurable: true,
  value: { get: () => true },
});
let tenant = "a";
const scope = (): ChatConnectionScope => ({
  key: tenant,
  server: "https://source.test",
  tenantId: tenant,
  userId: "u",
  imUserId: "same",
  authFingerprint: "same",
});
class FakeSDKClient {
  Event = {
    STATE_CHANGED: "state",
    MESSAGE_RECEIVED: "message",
    CONVERSATION_CHANGED: "conversation",
    CONVERSATION_ADDED: "add",
  };
  callbacks = new Map<string, Function[]>();
  registered: any[] = [];
  connections = 0;
  on(name: string, fn: Function) {
    this.callbacks.set(name, [...(this.callbacks.get(name) ?? []), fn]);
  }
  emit(name: string, payload: unknown) {
    this.callbacks.get(name)?.forEach((fn) => fn(payload));
  }
  registerMessage(messages: any[]) {
    this.registered = messages;
  }
  isConnected() {
    return false;
  }
  getCurrentUser() {
    return null;
  }
  async connect() {
    this.connections++;
    return { id: "same" };
  }
  disconnect() {}
}
const clients: FakeSDKClient[] = [];
mock.module(
  "../src/react-app/domains/jugglechat/vendor/juggleim-es-1.9.13.js",
  () => ({
    default: {
      init: () => {
        const c = new FakeSDKClient();
        clients.push(c);
        return c;
      },
    },
  }),
);
mock.module(
  "../src/react-app/domains/jugglechat/vendor/jugglecall-es-1.0.0.js",
  () => ({ default: {} }),
);
mock.module("../src/react-app/domains/jugglechat/storage.ts", () => ({
  getServerSetting: () => ({
    app_key: "shared-app",
    im_servers: ["https://same-im.test"],
  }),
}));
mock.module("../src/react-app/domains/jugglechat/chat-connection.ts", () => ({
  readChatConnectionScope: scope,
}));
const { juggleChatRuntime: runtime } =
  await import("../src/react-app/domains/jugglechat/runtime");
afterAll(() => {
  runtime.reset();
  mock.restore();
  if (original) Object.defineProperty(globalThis, "window", original);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalElements)
    Object.defineProperty(globalThis, "customElements", originalElements);
  else Reflect.deleteProperty(globalThis, "customElements");
});

test("卡片注册存储与计数；相同凭据的 A→B→A 不接受旧连接事件", async () => {
  const received: string[] = [];
  const unsubscribe = runtime.subscribe("message", (_message, source) =>
    received.push(source.tenantId),
  );
  const a = await runtime.initialize();
  expect(
    a.registered.find((r: any) => r.name === "jw:docs-notification"),
  ).toEqual({ name: "jw:docs-notification", isCount: true, isStorage: true });
  a.emit("message", {});
  tenant = "b";
  a.emit("message", {});
  const b = await runtime.initialize();
  b.emit("message", {});
  tenant = "a";
  runtime.reset();
  const nextA = await runtime.initialize();
  a.emit("message", {});
  b.emit("message", {});
  nextA.emit("message", {});
  expect(received).toEqual(["a", "b", "a"]);
  expect(clients).toHaveLength(3);
  unsubscribe();
});

test("同一新连接的并行启动只建立一次 SDK 连接", async () => {
  runtime.reset();
  await Promise.all([
    runtime.connect({ id: "same", token: "token" }),
    runtime.connect({ id: "same", token: "token" }),
  ]);
  expect(clients.at(-1)!.connections).toBe(1);
});
