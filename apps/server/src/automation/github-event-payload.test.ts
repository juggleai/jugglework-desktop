import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubEventDeliveryDetail } from "./github-event-client.js";
import { parseGithubEventDeliveryPayload } from "./github-event-payload.js";

function detail(overrides: Partial<GithubEventDeliveryDetail>): GithubEventDeliveryDetail {
  return {
    id: "delivery-1",
    automationId: "automation-1",
    eventType: "pull_request",
    entityRef: "github:pull_request:482",
    eventTimestampMs: Date.parse("2026-09-04T00:00:00Z"),
    payload: {},
    authorIsAppIdentity: false,
    ...overrides,
  };
}

// TIPS: 这几条 payload 形状照着 GitHub 官方 webhook 文档逐字段核对过
// （https://docs.github.com/webhooks/webhook-events-and-payloads），不是拍脑袋编的。

test("pull_request opened extracts title/body and is not a closing event", () => {
  const parsed = parseGithubEventDeliveryPayload(detail({
    eventType: "pull_request", action: "opened",
    payload: { pull_request: { title: "修复登录问题", body: "详细描述", html_url: "https://github.com/acme/repo/pull/482", merged: false } },
  }));
  assert.deepEqual(parsed.untrustedText, [
    { label: "PR 标题", text: "修复登录问题" },
    { label: "PR 正文", text: "详细描述" },
  ]);
  assert.equal(parsed.sourceUrl, "https://github.com/acme/repo/pull/482");
  assert.equal(parsed.isEntityClosingEvent, false);
  assert.equal(parsed.changedPaths, undefined);
});

test("pull_request closed (merged or not) is a closing event", () => {
  for (const merged of [true, false]) {
    const parsed = parseGithubEventDeliveryPayload(detail({
      eventType: "pull_request", action: "closed",
      payload: { pull_request: { title: "t", html_url: "https://github.com/acme/repo/pull/482", merged } },
    }));
    assert.equal(parsed.isEntityClosingEvent, true, `merged=${merged}`);
  }
});

test("pull_request with no body omits the empty entry rather than an empty-string text part", () => {
  const parsed = parseGithubEventDeliveryPayload(detail({
    eventType: "pull_request", action: "opened",
    payload: { pull_request: { title: "只有标题", body: null, html_url: "https://github.com/acme/repo/pull/1" } },
  }));
  assert.deepEqual(parsed.untrustedText, [{ label: "PR 标题", text: "只有标题" }]);
});

test("issues opened/closed", () => {
  const opened = parseGithubEventDeliveryPayload(detail({
    eventType: "issues", action: "opened", entityRef: "github:issue:9",
    payload: { issue: { title: "Bug 报告", body: "复现步骤", html_url: "https://github.com/acme/repo/issues/9" } },
  }));
  assert.deepEqual(opened.untrustedText, [
    { label: "Issue 标题", text: "Bug 报告" },
    { label: "Issue 正文", text: "复现步骤" },
  ]);
  assert.equal(opened.isEntityClosingEvent, false);

  const closed = parseGithubEventDeliveryPayload(detail({
    eventType: "issues", action: "closed", entityRef: "github:issue:9",
    payload: { issue: { title: "Bug 报告", html_url: "https://github.com/acme/repo/issues/9" } },
  }));
  assert.equal(closed.isEntityClosingEvent, true);
});

test("issue_comment never closes the entity and prefers the comment body", () => {
  const parsed = parseGithubEventDeliveryPayload(detail({
    eventType: "issue_comment", action: "created", entityRef: "github:issue:9",
    payload: {
      issue: { title: "Bug 报告" },
      comment: { body: "我也遇到了", html_url: "https://github.com/acme/repo/issues/9#issuecomment-1" },
    },
  }));
  assert.deepEqual(parsed.untrustedText, [
    { label: "所在 Issue/PR 标题", text: "Bug 报告" },
    { label: "评论正文", text: "我也遇到了" },
  ]);
  assert.equal(parsed.sourceUrl, "https://github.com/acme/repo/issues/9#issuecomment-1");
  assert.equal(parsed.isEntityClosingEvent, false);
});

// TIPS: 这条曾经是个真实 bug，不是理论上的遗漏——`extractByEventType` 的 switch 只列了
// "issue_comment"，没列服务端拆分出来的 "issue_comment_on_pull_request"（PR 对话区评论），
// 命中 default 分支静默退化成空 untrustedText/无 sourceUrl。2026-09-05 用真实 PR 下的真实
// 评论事件验证 3b.5 时，运行记录里完全没有评论内容才发现——这个自动化订阅的正是这个拆分
// 后的类型，不是纯 "issue_comment"，plain issue_comment 的测试覆盖不到它。
test("issue_comment_on_pull_request (the split-off PR-comment type) extracts the same fields as issue_comment", () => {
  const parsed = parseGithubEventDeliveryPayload(detail({
    eventType: "issue_comment_on_pull_request", action: "created", entityRef: "github:pull_request:1",
    payload: {
      issue: { title: "test PR" },
      comment: { body: "请看看这个改动", html_url: "https://github.com/acme/repo/pull/1#issuecomment-2" },
    },
  }));
  assert.deepEqual(parsed.untrustedText, [
    { label: "所在 Issue/PR 标题", text: "test PR" },
    { label: "评论正文", text: "请看看这个改动" },
  ]);
  assert.equal(parsed.sourceUrl, "https://github.com/acme/repo/pull/1#issuecomment-2");
  assert.equal(parsed.isEntityClosingEvent, false);
});

test("pull_request_review includes the review state in the label", () => {
  const parsed = parseGithubEventDeliveryPayload(detail({
    eventType: "pull_request_review", action: "submitted", entityRef: "github:pull_request:482",
    payload: {
      pull_request: { title: "修复登录问题" },
      review: { state: "approved", body: "LGTM", html_url: "https://github.com/acme/repo/pull/482#pullrequestreview-1" },
    },
  }));
  assert.deepEqual(parsed.untrustedText, [
    { label: "PR 标题", text: "修复登录问题" },
    { label: "审查意见（approved）", text: "LGTM" },
  ]);
  assert.equal(parsed.isEntityClosingEvent, false);
});

test("pull_request_review_comment fills changedPaths from comment.path without any extra API call", () => {
  const parsed = parseGithubEventDeliveryPayload(detail({
    eventType: "pull_request_review_comment", action: "created", entityRef: "github:pull_request:482",
    payload: {
      pull_request: { title: "修复登录问题" },
      comment: { body: "这里可以简化", path: "src/auth/login.ts", html_url: "https://github.com/acme/repo/pull/482#discussion_r1" },
    },
  }));
  assert.deepEqual(parsed.changedPaths, ["src/auth/login.ts"]);
  assert.equal(parsed.sourceUrl, "https://github.com/acme/repo/pull/482#discussion_r1");
});

test("release prefers name, falls back to tag_name when name is absent", () => {
  const withName = parseGithubEventDeliveryPayload(detail({
    eventType: "release", action: "published", entityRef: "github:release:1",
    payload: { release: { name: "v1.2.0", tag_name: "v1.2.0", body: "发布说明", html_url: "https://github.com/acme/repo/releases/tag/v1.2.0" } },
  }));
  assert.deepEqual(withName.untrustedText, [
    { label: "发布名称", text: "v1.2.0" },
    { label: "发布说明", text: "发布说明" },
  ]);

  const withoutName = parseGithubEventDeliveryPayload(detail({
    eventType: "release", action: "published", entityRef: "github:release:2",
    payload: { release: { tag_name: "v1.3.0", html_url: "https://github.com/acme/repo/releases/tag/v1.3.0" } },
  }));
  assert.deepEqual(withoutName.untrustedText, [{ label: "发布名称", text: "v1.3.0" }]);
});

test("an unrecognized event type degrades to no extractable content instead of throwing", () => {
  const parsed = parseGithubEventDeliveryPayload(detail({ eventType: "star", payload: { action: "created" } }));
  assert.deepEqual(parsed.untrustedText, []);
  assert.equal(parsed.isEntityClosingEvent, false);
  assert.equal(parsed.sourceUrl, undefined);
});

test("preserves the base delivery fields verbatim (id/automationId/entityRef/eventType/action/authorIsAppIdentity/timestamp)", () => {
  const parsed = parseGithubEventDeliveryPayload(detail({
    id: "delivery-42", automationId: "automation-42", eventType: "issues", action: "opened",
    entityRef: "github:issue:7", authorIsAppIdentity: true, eventTimestampMs: 1_700_000_000_000,
    payload: { issue: {} },
  }));
  assert.equal(parsed.id, "delivery-42");
  assert.equal(parsed.automationId, "automation-42");
  assert.equal(parsed.eventType, "issues");
  assert.equal(parsed.action, "opened");
  assert.equal(parsed.entityRef, "github:issue:7");
  assert.equal(parsed.authorIsAppIdentity, true);
  assert.equal(parsed.githubEventTimestampMs, 1_700_000_000_000);
});

test("a non-object payload degrades gracefully rather than throwing", () => {
  const parsed = parseGithubEventDeliveryPayload(detail({ eventType: "pull_request", action: "opened", payload: null }));
  assert.deepEqual(parsed.untrustedText, []);
  assert.equal(parsed.sourceUrl, undefined);
});
