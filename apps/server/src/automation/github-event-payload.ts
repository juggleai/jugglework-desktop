import type { GithubEventDelivery } from "./event-pipeline.js";
import type { GithubEventDeliveryDetail } from "./github-event-client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * 把一条 GitHub webhook 原始 payload（`claimDelivery` 认领到的明文）翻译成
 * `AutomationEventPipeline` 真正处理的 `GithubEventDelivery` 形状。
 *
 * TIPS: 每种事件类型的字段路径都是照着 GitHub 官方 webhook payload schema 逐一核对的
 * （https://docs.github.com/webhooks/webhook-events-and-payloads），不是猜的——这几种
 * 事件类型是服务端 `HandleWebhook` 已经识别、这次改动之前桌面端唯一没接上的一段。
 *
 * `changedPaths` 大多数事件类型天然拿不到：GitHub 的 push/pull_request/issues 系
 * webhook payload 都不带完整改动文件清单（需要额外一次 REST 调用才能补，这次改动没做，
 * 见 `event-pipeline.ts` 里 `GithubEventDelivery.changedPaths` 的注释）。唯一的例外是
 * `pull_request_review_comment`——这是针对具体某一行代码的评论，payload 自带
 * `comment.path`，不需要额外请求就能填这一个文件路径。
 */
export function parseGithubEventDeliveryPayload(detail: GithubEventDeliveryDetail): GithubEventDelivery {
  const base = {
    id: detail.id,
    automationId: detail.automationId,
    entityRef: detail.entityRef,
    eventType: detail.eventType,
    ...(detail.action !== undefined ? { action: detail.action } : {}),
    authorIsAppIdentity: detail.authorIsAppIdentity,
    githubEventTimestampMs: detail.eventTimestampMs,
  };

  const payload = isRecord(detail.payload) ? detail.payload : {};
  const extracted = extractByEventType(detail.eventType, detail.action, payload);

  return {
    ...base,
    untrustedText: extracted.untrustedText,
    isEntityClosingEvent: extracted.isEntityClosingEvent,
    ...(extracted.sourceUrl !== undefined ? { sourceUrl: extracted.sourceUrl } : {}),
    ...(extracted.changedPaths !== undefined ? { changedPaths: extracted.changedPaths } : {}),
  };
}

type ExtractedFields = {
  untrustedText: Array<{ label: string; text: string }>;
  sourceUrl?: string;
  isEntityClosingEvent: boolean;
  changedPaths?: string[];
};

function extractByEventType(eventType: string, action: string | undefined, payload: Record<string, unknown>): ExtractedFields {
  switch (eventType) {
    case "pull_request":
      return extractPullRequest(action, payload);
    case "issues":
      return extractIssue(action, payload);
    case "issue_comment":
      return extractIssueComment(payload);
    case "pull_request_review":
      return extractPullRequestReview(payload);
    case "pull_request_review_comment":
      return extractPullRequestReviewComment(payload);
    case "release":
      return extractRelease(payload);
    default:
      // TIPS: 只有服务端 HandleWebhook 已识别、路由给自动化订阅的事件类型才会走到这里——
      // 一条未知类型的投递不该整体失败，退化成"没有可提取内容"，交给上游的匹配/过滤逻辑
      // 自己决定要不要处理，而不是在解析这一层就抛错中断整批投递。
      return { untrustedText: [], isEntityClosingEvent: false };
  }
}

function textEntry(label: string, text: string | undefined): { label: string; text: string } | null {
  const trimmed = text?.trim();
  return trimmed ? { label, text: trimmed } : null;
}

function extractPullRequest(action: string | undefined, payload: Record<string, unknown>): ExtractedFields {
  const pr = isRecord(payload.pull_request) ? payload.pull_request : {};
  const entries = [
    textEntry("PR 标题", asString(pr.title)),
    textEntry("PR 正文", asString(pr.body)),
  ].filter((entry): entry is { label: string; text: string } => entry !== null);
  return {
    untrustedText: entries,
    sourceUrl: asString(pr.html_url),
    // TIPS: 合并（merged）和直接关闭都是 action === "closed"，pull_request.merged 区分
    // 两种情形，但对"这个实体的会话该不该退休"这个判断本身两者是同一回事——都是这个 PR
    // 的生命周期结束了，见 event-pipeline.ts 里 isEntityClosingEvent 消费方的注释。
    isEntityClosingEvent: action === "closed",
  };
}

function extractIssue(action: string | undefined, payload: Record<string, unknown>): ExtractedFields {
  const issue = isRecord(payload.issue) ? payload.issue : {};
  const entries = [
    textEntry("Issue 标题", asString(issue.title)),
    textEntry("Issue 正文", asString(issue.body)),
  ].filter((entry): entry is { label: string; text: string } => entry !== null);
  return {
    untrustedText: entries,
    sourceUrl: asString(issue.html_url),
    isEntityClosingEvent: action === "closed",
  };
}

function extractIssueComment(payload: Record<string, unknown>): ExtractedFields {
  const issue = isRecord(payload.issue) ? payload.issue : {};
  const comment = isRecord(payload.comment) ? payload.comment : {};
  const entries = [
    textEntry("所在 Issue/PR 标题", asString(issue.title)),
    textEntry("评论正文", asString(comment.body)),
  ].filter((entry): entry is { label: string; text: string } => entry !== null);
  return {
    untrustedText: entries,
    sourceUrl: asString(comment.html_url),
    // TIPS: 评论本身不会让所在的 Issue/PR 结束——关闭状态由 issues.closed / pull_request.closed
    // 各自的事件负责，这里永远是 false。
    isEntityClosingEvent: false,
  };
}

function extractPullRequestReview(payload: Record<string, unknown>): ExtractedFields {
  const review = isRecord(payload.review) ? payload.review : {};
  const pr = isRecord(payload.pull_request) ? payload.pull_request : {};
  const state = asString(review.state);
  const entries = [
    textEntry("PR 标题", asString(pr.title)),
    textEntry(state ? `审查意见（${state}）` : "审查意见", asString(review.body)),
  ].filter((entry): entry is { label: string; text: string } => entry !== null);
  return {
    untrustedText: entries,
    sourceUrl: asString(review.html_url),
    isEntityClosingEvent: false,
  };
}

function extractPullRequestReviewComment(payload: Record<string, unknown>): ExtractedFields {
  const comment = isRecord(payload.comment) ? payload.comment : {};
  const pr = isRecord(payload.pull_request) ? payload.pull_request : {};
  const entries = [
    textEntry("PR 标题", asString(pr.title)),
    textEntry("行内评论正文", asString(comment.body)),
  ].filter((entry): entry is { label: string; text: string } => entry !== null);
  const path = asString(comment.path);
  return {
    untrustedText: entries,
    sourceUrl: asString(comment.html_url),
    isEntityClosingEvent: false,
    // TIPS: 行内评论天然带着它所在的文件路径，是这几种事件类型里唯一不需要额外 API
    // 调用就能填 changedPaths 的——填一个元素的数组，不是完整改动清单，但对路径 glob
    // 过滤（task 5.1）已经是有意义的信号。
    ...(path ? { changedPaths: [path] } : {}),
  };
}

function extractRelease(payload: Record<string, unknown>): ExtractedFields {
  const release = isRecord(payload.release) ? payload.release : {};
  const entries = [
    textEntry("发布名称", asString(release.name) ?? asString(release.tag_name)),
    textEntry("发布说明", asString(release.body)),
  ].filter((entry): entry is { label: string; text: string } => entry !== null);
  return {
    untrustedText: entries,
    sourceUrl: asString(release.html_url),
    isEntityClosingEvent: false,
  };
}
