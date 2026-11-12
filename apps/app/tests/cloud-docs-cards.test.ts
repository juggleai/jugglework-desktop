import { describe, expect, test } from "bun:test";
import {
  bindDocsMessage,
  dedupeDocsMessages,
  docsMessageSource,
  parseDocsCard,
  type ChatConnectionScope,
} from "../src/react-app/domains/jugglechat/docs-message";
import {
  openDocsCard,
  openDocsSource,
  parseCloudDocsTarget,
} from "../src/react-app/domains/cloud-docs/docs-card-navigation";
import {
  createDocsNotificationAction,
  parseDocsNotificationAction,
} from "../src/react-app/domains/jugglechat/docs-notification-action";
import type { ChatMessage } from "../src/react-app/domains/jugglechat/types";

const botA = "jw_docs_" + "a".repeat(32),
  botB = "jw_docs_" + "b".repeat(32);
const scope: ChatConnectionScope = Object.freeze({
  key: "scopeA",
  server: "https://example.test/deployment-a",
  userId: "u",
  tenantId: "a",
  authFingerprint: "4:1234",
  imUserId: "u",
});
const card = (): ChatMessage => ({
  messageId: "message-1",
  name: "jw:docs-notification",
  conversationId: "docs_a",
  conversationType: 2,
  sender: { id: botA },
  content: {
    contractVersion: 1,
    eventId: "00000000-0000-4000-8000-000000000001",
    tenantId: "a",
    pageId: "page_1",
    commentId: "comment_1",
    kind: "comment.created",
    occurredAt: "2026-11-06T00:00:00Z",
    part: "group",
  },
});

describe("云文档固定卡片", () => {
  test("未知版本、URL、路径和任意展示字段无动作", () => {
    for (const patch of [
      { contractVersion: 2 },
      { pageId: "../secret" },
      { url: "https://external.test" },
      { title: "private" },
      { commentId: "x?y" },
    ])
      expect(
        parseDocsCard({ ...card(), content: { ...card().content, ...patch } }),
      ).toBeNull();
    expect(parseDocsCard(card())?.pageId).toBe("page_1");
  });
  test("实际助手和会话均匹配才能绑定，转发或 JSON 伪造不能继承动作", () => {
    const bound = bindDocsMessage(card(), scope);
    expect(docsMessageSource(bound)?.scope).toBe(scope);
    for (const patch of [
      { sender: { id: "human" } },
      { conversationType: 1, conversationId: "regular" },
      { isSender: true },
    ])
      expect(
        docsMessageSource(
          bindDocsMessage({ ...card(), ...patch }, scope),
        ),
      ).toBeNull();
    expect(docsMessageSource(JSON.parse(JSON.stringify(bound)))).toBeNull();
    expect(
      docsMessageSource(
        bindDocsMessage(bound, { ...scope, tenantId: "b" }),
      ),
    ).toBeNull();
  });
  test("同一事件的不同 IM 消息去重，未修改外部 SDK 消息和未读索引", () => {
    const a = bindDocsMessage(card(), scope),
      b = bindDocsMessage(
        { ...card(), messageId: "message-2" },
        scope,
      );
    expect(dedupeDocsMessages([a, b])).toEqual([a]);
    expect(
      dedupeDocsMessages([
        a,
        { ...b, content: { ...b.content, eventId: "other" } },
      ]),
    ).toEqual([a]);
    expect(card().messageId).toBe("message-1");
  });

});

describe("卡片交接状态机", () => {
  function fixture() {
    let account = { ...scope };
    const paths: string[] = [],
      validations: unknown[] = [];
    return {
      paths,
      validations,
      get account() {
        return account;
      },
      set account(value) {
        account = value;
      },
      navigation: {
        readAccount: () => account,
        organizations: [{ id: "a", name: "A" }],
        confirmSwitch: () => true,
        switchOrganization: async (id: string) => {
          account = { ...account, tenantId: id };
        },
        validate: async (payload: unknown) => {
          validations.push(payload);
          return { valid: true };
        },
        navigate: (path: string) => {
          paths.push(path);
        },
      },
    };
  }
  test("同组织核对持久事件后构造固定页面和评论路由", async () => {
    const f = fixture();
    expect(
      await openDocsCard(bindDocsMessage(card(), scope), f.navigation),
    ).toBe("opened");
    expect(f.paths).toEqual([
      "/cloud-docs/a?pageId=page_1&commentId=comment_1",
    ]);
    expect(f.validations).toHaveLength(1);
  });
  test("系统通知保留接收时来源并复用同一交接状态机", async () => {
    const f = fixture();
    const action = createDocsNotificationAction(
      bindDocsMessage(card(), scope),
    );
    expect(action).not.toBeNull();
    const parsed = parseDocsNotificationAction(action);
    expect(parsed).not.toBeNull();
    expect(
      await openDocsSource(
        parsed!.source,
        parsed!.payload,
        parsed!.conversationId,
        f.navigation,
      ),
    ).toBe("opened");
    expect(f.paths).toEqual([
      "/cloud-docs/a?pageId=page_1&commentId=comment_1",
    ]);
    expect(
      parseDocsNotificationAction({
        ...action,
        source: { ...action!.source, token: "secret" },
      }),
    ).toBeNull();
  });
  test("另一部署前缀、用户或凭据的旧动作失效", async () => {
    for (const patch of [
      { server: "https://example.test/deployment-b" },
      { userId: "other" },
      { authFingerprint: "new" },
    ]) {
      const f = fixture();
      f.account = { ...f.account, ...patch };
      expect(
        await openDocsCard(
          bindDocsMessage(card(), scope),
          f.navigation,
        ),
      ).toBe("source-changed");
      expect(f.validations).toHaveLength(0);
      expect(f.paths).toHaveLength(0);
    }
  });
  test("切换取消不改变组织；服务端已切换且 IM 不可用仍按真实组织打开", async () => {
    const f = fixture();
    f.account = { ...f.account, tenantId: "b" };
    f.navigation.confirmSwitch = () => false;
    const message = bindDocsMessage(card(), scope);
    expect(await openDocsCard(message, f.navigation)).toBe("cancelled");
    expect(f.account.tenantId).toBe("b");
    f.navigation.confirmSwitch = () => true;
    expect(await openDocsCard(message, f.navigation)).toBe("opened");
    expect(f.account.tenantId).toBe("a");
  });
  test("组织切换返回但目标未生效、或者校验时 B→C，不导航", async () => {
    const f = fixture();
    f.account = { ...f.account, tenantId: "b" };
    f.navigation.switchOrganization = async () => {};
    const message = bindDocsMessage(card(), scope);
    expect(await openDocsCard(message, f.navigation)).toBe("source-changed");
    f.account = { ...scope };
    f.navigation.validate = async () => {
      f.account = { ...f.account, tenantId: "c" };
      return { valid: true };
    };
    expect(await openDocsCard(message, f.navigation)).toBe("source-changed");
    expect(f.paths).toHaveLength(0);
  });
  test("卡片与系统通知同时点击只执行一次交接", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.navigation.validate = async (payload: unknown) => {
      f.validations.push(payload);
      await gate;
      return { valid: true };
    };
    const message = bindDocsMessage(card(), scope);
    const action = createDocsNotificationAction(message)!;
    const fromCard = openDocsCard(message, f.navigation);
    const fromSystem = openDocsSource(
      action.source,
      action.payload,
      action.conversationId,
      f.navigation,
    );
    await Promise.resolve();
    expect(f.validations).toHaveLength(1);
    release();
    expect(await Promise.all([fromCard, fromSystem])).toEqual([
      "opened",
      "opened",
    ]);
    expect(f.paths).toEqual([
      "/cloud-docs/a?pageId=page_1&commentId=comment_1",
    ]);
  });
  test("成员失效、事件被改写和未知来源均不导航", async () => {
    const f = fixture();
    f.navigation.validate = async () => ({ valid: false });
    expect(
      await openDocsCard(bindDocsMessage(card(), scope), f.navigation),
    ).toBe("unavailable");
    expect(await openDocsCard(card(), f.navigation)).toBe("unavailable");
    expect(f.paths).toHaveLength(0);
  });
  test("页面定位拒绝重复字段、URL 和无页面的评论参数", () => {
    for (const query of [
      "?pageId=x&pageId=y",
      "?pageId=https://other.test",
      "?commentId=x",
      "?pageId=x&commentId=../y",
    ])
      expect(parseCloudDocsTarget(query)).toBeNull();
    expect(parseCloudDocsTarget("")).toEqual({ kind: "home" });
  });
});
