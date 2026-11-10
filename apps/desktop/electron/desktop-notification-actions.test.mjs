import assert from "node:assert/strict";
import test from "node:test";

import {
  bindDesktopNotificationClick,
  createDesktopNotificationActionRelay,
  sanitizeDesktopNotificationAction,
} from "./desktop-notification-actions.mjs";

/** @returns {import("@jugglework/types/desktop-ipc").DesktopNotificationAction} */
const action = () => ({
  type: "docs.open",
  contractVersion: 1,
  source: {
    server: "https://source.test/deployment",
    userId: "user_a",
    tenantId: "org_a",
    authFingerprint: "12:345678",
  },
  payload: {
    contractVersion: 1,
    eventId: "00000000-0000-4000-8000-000000000001",
    tenantId: "org_a",
    pageId: "page_a",
    commentId: "comment_a",
    kind: "comment.user_mention",
    occurredAt: "2026-11-06T00:00:00Z",
    part: "direct",
  },
  conversationId: "jw_docs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

test("系统通知动作只保留固定来源和文档定位", () => {
  assert.deepEqual(sanitizeDesktopNotificationAction(action()), action());
});

test("系统通知动作拒绝跨租户、任意 URL、凭据和额外字段", () => {
  const samples = [
    { payload: { ...action().payload, tenantId: "org_b" } },
    { payload: { ...action().payload, pageId: "https://evil.test" } },
    { source: { ...action().source, server: "https://user:secret@source.test" } },
    { source: { ...action().source, token: "secret" } },
    { href: "https://evil.test" },
  ];
  for (const patch of samples)
    assert.equal(sanitizeDesktopNotificationAction({ ...action(), ...patch }), null);
});

test("渲染器就绪前的通知动作会暂存并只交接一次", () => {
  const received = [];
  const relay = createDesktopNotificationActionRelay({
    send(owner, value) {
      received.push([owner, value.payload.eventId]);
      return true;
    },
  });

  assert.equal(relay.enqueue(action()), "queued");
  assert.equal(relay.enqueue(action()), "queued");
  assert.equal(relay.pendingCount(), 1);
  assert.equal(relay.ready("renderer-a"), 1);
  assert.deepEqual(received, [["renderer-a", action().payload.eventId]]);
  assert.equal(relay.pendingCount(), 0);
});

test("渲染器重载后动作等待新监听恢复再交接", () => {
  const received = [];
  const relay = createDesktopNotificationActionRelay({
    send(owner, value) {
      received.push([owner, value.payload.eventId]);
      return owner === "renderer-a" || owner === "renderer-b";
    },
  });

  relay.ready("renderer-a");
  assert.equal(relay.enqueue(action()), "delivered");
  relay.reset("renderer-a");
  const second = action();
  second.payload.eventId = "00000000-0000-4000-8000-000000000002";
  assert.equal(relay.enqueue(second), "queued");
  assert.equal(relay.ready("renderer-b"), 1);
  assert.deepEqual(received, [
    ["renderer-a", action().payload.eventId],
    ["renderer-b", second.payload.eventId],
  ]);
});

test("Electron 通知点击在窗口聚焦失败时仍保留动作", async () => {
  /** @type {Array<() => void>} */
  const clicks = [];
  const focusError = new Error("window is loading");
  const errors = [];
  const received = [];
  const relay = createDesktopNotificationActionRelay({
    send(owner, value) {
      received.push([owner, value.payload.eventId]);
      return true;
    },
  });
  bindDesktopNotificationClick(
    { on(event, callback) { assert.equal(event, "click"); clicks.push(callback); } },
    {
      action: action(),
      relay,
      focus: async () => { throw focusError; },
      onFocusError: error => errors.push(error),
    }
  );

  const click = clicks[0];
  if (!click) throw new Error("notification click listener was not registered");
  click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relay.pendingCount(), 1);
  assert.deepEqual(errors, [focusError]);
  assert.equal(relay.ready("renderer"), 1);
  assert.deepEqual(received, [["renderer", action().payload.eventId]]);
});
