/** @jsxImportSource react */
import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readDenSettings } from "@/app/lib/den";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  ArrowLeft,
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Ellipsis,
  FileCode2,
  GitPullRequestArrow,
  MessageSquareText,
  LoaderCircle,
  Pin,
  RefreshCw,
  Search,
  Users,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppSecondarySidebarResizeHandle } from "@/react-app/shell/app-secondary-sidebar-resize-handle";
import { AppSecondarySidebarTopControls } from "@/react-app/shell/app-secondary-sidebar-top-controls";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { appInsetSidebarCssWidth, useWorkspaceShellLayout } from "@/react-app/shell/workspace-shell-layout";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";
import type { ReviewConnectionStatus } from "@jugglework/types/reviews";

import {
  useReviewChecks,
  useReviewConnection,
  useReviewDetail,
  useReviewFiles,
  useReviewInbox,
  useReviewThreads,
  reviewQueryKeys,
} from "./review-queries";
import { reviewViewModel } from "./review-view-model";
import { useReviewWorkspaceEndpoint } from "./use-review-workspace-endpoint";
import { ReviewWorkflowControls } from "./review-workflow-controls";
import { ReviewHeaderActions } from "./review-header-actions";
import { ReviewGitHubConnection } from "./review-github-connection";
import { MarkdownBlock } from "@/react-app/domains/session/surface/markdown";
import type {
  ReviewCheckState,
  ReviewDetailTab,
  ReviewPreview,
  ReviewRelationship,
} from "./review-types";

type ReviewPageProps = {
  workspaceId: string;
  reviewId: string | null;
  active: boolean;
  onSelectReview: (reviewId: string | null) => void;
  onOpenReviewSession?: (sessionId: string) => void;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onOpenConnect: () => void;
  onOpenTaskSearch: () => void;
  onOpenCreateWorkspace: OpenCreateWorkspace;
};

const INBOX_SECTIONS: Array<{ value: ReviewRelationship; en: string; zh: string }> = [
  { value: "authored", en: "My pull requests", zh: "我创建的" },
  { value: "requested", en: "Review requests", zh: "待我审查" },
  { value: "team", en: "My team's review requests", zh: "需要我的团队审查" },
  { value: "recently_merged", en: "Recently merged", zh: "最近合并" },
];

const TABS: Array<{ value: ReviewDetailTab; en: string; zh: string }> = [
  { value: "summary", en: "Summary", zh: "摘要" },
  { value: "changes", en: "Changes", zh: "变更" },
  { value: "checks", en: "Checks", zh: "检查" },
  { value: "threads", en: "Threads", zh: "讨论" },
];

function pinnedStorageKey(workspaceId: string) { return `jugglework:review-pins:${workspaceId}`; }
function readPinnedReviews(workspaceId: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(pinnedStorageKey(workspaceId)) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
  } catch { return []; }
}

function text(en: string, zh: string) {
  return currentLocale() === "zh" ? zh : en;
}

export function reviewMatches(review: ReviewPreview, query: string, relationship: "all" | ReviewRelationship) {
  if (relationship !== "all" && review.relationship !== relationship) return false;
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [review.title, review.owner, review.repository, review.author, `#${review.number}`, ...review.labels]
    .join(" ")
    .toLocaleLowerCase()
    .includes(normalized);
}

function ReviewAvatar({ review, size = "md" }: { review: ReviewPreview; size?: "sm" | "md" }) {
  if (review.authorAvatarUrl) {
    return <img src={review.authorAvatarUrl} alt="" className={cn("shrink-0 rounded-full object-cover ring-1 ring-dls-border", size === "sm" ? "size-6" : "size-8")} />;
  }
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-5 to-blue-5 font-semibold text-violet-11 ring-1 ring-violet-7/40",
      size === "sm" ? "size-6 text-[9px]" : "size-8 text-xs",
    )} aria-hidden="true">
      {review.authorInitials}
    </span>
  );
}

function InboxRow({ review, selected, onSelect }: { review: ReviewPreview; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`review-inbox-item-${review.id}`}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-dls-hover/70",
        selected && "bg-dls-hover/60",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[15px] font-medium leading-[1.45] text-dls-text">{review.title}</span>
        <span className="mt-1.5 flex min-w-0 items-center gap-2 text-[13px] text-dls-secondary">
          <ReviewAvatar review={review} size="sm" />
          <span className="truncate">{review.author}</span>
          <span>·</span>
          <span className="shrink-0">{review.updatedAt}</span>
          {review.draft ? <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{text("Draft", "草稿")}</Badge> : null}
          {review.pinned ? <Pin className="ml-auto size-3 fill-current text-dls-secondary" aria-label={text("Pinned", "已固定")} /> : null}
          {selected ? <span className={cn("size-2 rounded-full bg-blue-9", !review.pinned && "ml-auto")} aria-hidden="true" /> : null}
        </span>
      </span>
    </button>
  );
}

type ReviewInboxSectionState = {
  relationship: ReviewRelationship;
  reviews: ReviewPreview[];
  loading?: boolean;
  refreshing?: boolean;
  hasNextPage?: boolean;
  loadingNextPage?: boolean;
  error?: string | null;
  onLoadMore?: () => void;
  onRetry?: () => void;
};

function ReviewInbox(props: {
  sections: ReviewInboxSectionState[];
  expandedSections: ReviewRelationship[];
  reviewId: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onToggleSection: (relationship: ReviewRelationship) => void;
  onSelectReview: (reviewId: string) => void;
  onOpenUrl?: () => void;
}) {
  const refreshing = props.sections.some((section) => props.expandedSections.includes(section.relationship) && section.refreshing);
  return (
    <aside className={cn(
      "h-full min-h-0 w-full shrink-0 flex-col overflow-hidden border-r border-dls-border bg-[var(--app-secondary-sidebar-bg)] md:flex md:w-[var(--jugglework-left-sidebar-width)]",
      props.reviewId ? "hidden" : "flex",
    )} aria-label={text("Pull request inbox", "拉取请求收件箱")}>
      <div className="shrink-0 px-5 pb-2 pt-5 mac:pt-7">
        <div className="flex items-center gap-2">
          <h1 className="text-[24px] font-semibold tracking-tight text-dls-text">{text("Code Review", "代码审查")}</h1>
          {refreshing ? <RefreshCw className="size-3 animate-spin text-dls-secondary" aria-label={text("Refreshing", "正在刷新")} /> : null}
          {props.onOpenUrl ? <Button className="ml-auto" variant="ghost" size="icon-sm" onClick={props.onOpenUrl} aria-label={text("Open pull request URL", "打开拉取请求链接")}><Ellipsis className="size-5" /></Button> : null}
        </div>
        <label className="relative mt-5 block">
          <Search className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-dls-secondary" />
          <input
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={text("Search or paste Pull Request URL", "搜索或粘贴 Pull Request 链接")}
            className="h-12 w-full rounded-full border-0 bg-dls-hover pl-12 pr-4 text-[15px] text-dls-text outline-none ring-1 ring-transparent transition placeholder:text-dls-secondary focus:ring-dls-border"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <nav className="space-y-1" aria-label={text("Review sections", "代码审查分组")}>
          {INBOX_SECTIONS.map((definition) => {
            const section = props.sections.find((candidate) => candidate.relationship === definition.value) ?? { relationship: definition.value, reviews: [] };
            const expanded = props.expandedSections.includes(definition.value);
            return <section key={definition.value} aria-labelledby={`review-section-${definition.value}`}>
            <button
              type="button"
              id={`review-section-${definition.value}`}
              aria-expanded={expanded}
              onClick={() => props.onToggleSection(definition.value)}
              className="flex min-h-11 w-full items-center gap-1 rounded-lg px-2 text-left text-[15px] font-semibold text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            >
              <span>{text(definition.en, definition.zh)}</span>
              {expanded ? <ChevronDown className="size-4" strokeWidth={2} /> : <ChevronRight className="size-4" strokeWidth={2} />}
            </button>
            {expanded ? <div className="pb-3" role="list">
              {section.loading ? (
                <div className="flex min-h-20 items-center justify-center gap-2 text-xs text-dls-secondary"><LoaderCircle className="size-4 animate-spin" />{text("Loading pull requests…", "正在加载拉取请求…")}</div>
              ) : section.error && !section.reviews.length ? (
                <div className="flex min-h-24 flex-col items-center justify-center px-5 text-center"><AlertCircle className="size-5 text-amber-10" /><p className="mt-2 text-xs font-medium text-dls-text">{text("Pull requests could not be loaded", "无法加载拉取请求")}</p><p className="mt-1 text-xs text-dls-secondary">{section.error}</p><Button variant="outline" size="sm" className="mt-3" onClick={section.onRetry}><RefreshCw />{text("Retry", "重试")}</Button></div>
              ) : section.reviews.length ? <>
                <div className="space-y-0.5">
                  {section.reviews.map((review) => <div role="listitem" key={review.id}><InboxRow review={review} selected={review.id === props.reviewId} onSelect={() => props.onSelectReview(review.id)} /></div>)}
                </div>
                {section.hasNextPage ? <div className="p-2"><Button variant="outline" size="sm" className="w-full" disabled={section.loadingNextPage} onClick={section.onLoadMore}>{section.loadingNextPage ? <LoaderCircle className="animate-spin" /> : null}{text("Load more", "加载更多")}</Button></div> : null}
              </> : <p className="px-2 pb-2 text-xs leading-5 text-dls-secondary">{props.query.trim() ? text("No matching pull requests", "没有匹配的拉取请求") : text("No pull requests", "暂无 Pull Request")}</p>}
            </div> : null}
            </section>;
          })}
        </nav>
      </div>
    </aside>
  );
}

function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-violet-4 text-violet-11"><GitPullRequestArrow className="size-7" /></span>
      <h2 className="mt-4 text-base font-semibold text-dls-text">{text("Select a pull request", "选择一个拉取请求")}</h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-dls-secondary">{text("Choose an item from the Inbox to inspect its summary, changed files, checks, and review threads.", "从收件箱选择一项，查看摘要、变更文件、检查结果和审查讨论。")}</p>
    </div>
  );
}

function UnknownDetail({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center" data-testid="review-not-found">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-amber-4 text-amber-11"><GitPullRequestArrow className="size-7" /></span>
      <h2 className="mt-4 text-base font-semibold text-dls-text">{text("Pull request not found", "未找到拉取请求")}</h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-dls-secondary">{text("This preview link does not match an available item.", "该预览链接与当前可用条目不匹配。")}</p>
      <Button variant="outline" className="mt-5" onClick={onBack}><ArrowLeft />{text("Return to Inbox", "返回收件箱")}</Button>
    </div>
  );
}

function ReviewHeader(props: {
  review: ReviewPreview;
  onBack: () => void;
  actions?: ReactNode;
  endpoint?: ReturnType<typeof useReviewWorkspaceEndpoint>["endpoint"];
  operations?: ReviewConnectionStatus["operations"];
  pinned?: boolean;
  onTogglePin?: () => void;
  onChanged?: () => void | Promise<void>;
}) {
  const { review, onBack } = props;
  return (
    <header className="shrink-0 bg-background px-5 pb-3 pt-4 md:px-7 mac:pt-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onBack} aria-label={text("Back to Inbox", "返回收件箱")}><ArrowLeft /></Button>
        {props.endpoint ? <ReviewHeaderActions endpoint={props.endpoint} review={review} operations={props.operations} pinned={Boolean(props.pinned)} onTogglePin={props.onTogglePin ?? (() => undefined)} onChanged={props.onChanged ?? (() => undefined)} workflowActions={props.actions} /> : <>
          {review.draft ? <Badge variant="outline" className="h-8 rounded-full px-3 text-xs">{text("Draft", "草稿")}</Badge> : <Badge variant="secondary" className="h-8 rounded-full bg-green-4 px-3 text-xs text-green-11"><GitPullRequestArrow className="mr-1 size-3.5" />Open</Badge>}
          <div className="min-w-0 text-xs text-dls-secondary"><span>{review.repository}</span> <span>#{review.number}</span></div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{props.actions ?? <>
          <Button variant="outline" disabled title={text("Available after AI Review is connected", "接入 AI Review 后可用")}><Bot />{text("Review with JuggleWork", "使用 JuggleWork 审查")}</Button>
          <Button disabled title={text("Available after provider write access is connected", "接入平台写权限后可用")}>{text("Submit review", "提交审查")}</Button>
          </>}</div>
        </>}
      </div>
      <h2 className="mt-5 text-[22px] font-semibold leading-8 tracking-tight text-dls-text">{review.title}</h2>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-xs text-dls-secondary">
        <ReviewAvatar review={review} size="sm" />
        <span className="font-medium text-dls-text">{review.author}</span>
        <span>{review.updatedAt}</span>
        <span>·</span>
        <span className="max-w-52 truncate font-mono">{review.headBranch}</span>
        <span>→</span>
        <span className="font-mono">{review.baseBranch}</span>
        <span className="hidden font-mono text-[10px] xl:inline">{review.headRevision.slice(0, 8)}</span>
      </div>
    </header>
  );
}

function SummaryView({ review, onTabChange }: { review: ReviewPreview; onTabChange: (tab: ReviewDetailTab) => void }) {
  const failedChecks = review.checks.filter((check) => check.state === "failure");
  const pendingChecks = review.checks.filter((check) => check.state === "running" || check.state === "queued");
  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-8 px-5 pb-12 pt-2 md:px-7 lg:grid-cols-[minmax(0,1fr)_260px] xl:grid-cols-[minmax(0,1fr)_300px]">
      <article className="min-w-0 pb-12 pt-2 text-[15px] leading-7 text-dls-text">
        {review.body ? <MarkdownBlock text={review.body} copyCodeBlocks /> : <p className="text-dls-secondary">{text("No pull request description was provided.", "该 Pull Request 没有填写描述。")}</p>}
      </article>
      <aside className="divide-y divide-dls-border text-sm lg:border-l lg:border-dls-border lg:pl-6 xl:pl-7">
        <button type="button" onClick={() => onTabChange("changes")} className="w-full py-4 text-left">
          <span className="text-xs text-dls-secondary">{text("Changes", "变更")}</span>
          <span className="mt-2 flex items-center gap-3 font-medium text-dls-text"><FileCode2 className="size-4" />{review.changedFiles} {text(review.changedFiles === 1 ? "file" : "files", "个文件")} <span className="ml-auto text-green-11">+{review.additions}</span><span className="text-red-11">-{review.deletions}</span></span>
        </button>
        <button type="button" onClick={() => onTabChange("threads")} className="w-full py-4 text-left">
          <span className="text-xs text-dls-secondary">{text("Threads", "讨论")}</span>
          <span className="mt-2 flex items-center gap-3 font-medium text-dls-text"><MessageSquareText className="size-4" />{text("Code review", "代码审查")}<span className="ml-auto text-xs text-dls-secondary">{review.threads.length || text("No comments", "无评论")}</span></span>
        </button>
        <div className="py-4">
          <span className="text-xs text-dls-secondary">{text("Reviewers", "评审人")}</span>
          <span className="mt-2 flex items-center gap-3 text-dls-secondary"><Users className="size-4" />{text("No reviewers", "暂无评审人")}</span>
        </div>
        <button type="button" onClick={() => onTabChange("checks")} className="w-full py-4 text-left">
          <span className="flex items-center text-xs text-dls-secondary"><span>{text("Checks", "检查")}</span><ChevronRight className="ml-auto size-4" /></span>
          {!review.checks.length ? <span className="mt-2 block text-dls-secondary">{text("No checks", "暂无检查")}</span> : (
            <span className="mt-2 block space-y-2">
              {review.checks.slice(0, 5).map((check) => <span key={check.id} className="flex min-w-0 items-center gap-2"><CheckIcon state={check.state} /><span className="truncate text-xs text-dls-text">{check.name}</span></span>)}
              {review.checks.length > 5 ? <span className="block text-xs text-dls-secondary">{text("Show more", "显示更多")}</span> : null}
            </span>
          )}
          {review.checks.length ? <span className="mt-3 block text-[11px] text-dls-secondary">{failedChecks.length ? text(`${failedChecks.length} failed`, `${failedChecks.length} 项失败`) : pendingChecks.length ? text(`${pendingChecks.length} pending`, `${pendingChecks.length} 项进行中`) : text("All checks passed", "所有检查均已通过")}</span> : null}
        </button>
        {review.labels.length ? <div className="py-4"><span className="text-xs text-dls-secondary">{text("Labels", "标签")}</span><div className="mt-2 flex flex-wrap gap-2">{review.labels.map((label) => <Badge key={label} variant="outline">{label}</Badge>)}</div></div> : null}
      </aside>
    </div>
  );
}

function EmptyTab({ children }: { children: string }) {
  return <div className="flex min-h-64 items-center justify-center p-8 text-center text-sm text-dls-secondary">{children}</div>;
}

function ChangesView({ review, truncated }: { review: ReviewPreview; truncated?: boolean }) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      {truncated ? <div className="rounded-xl border border-amber-7 bg-amber-3 px-4 py-3 text-xs text-amber-11">{text("Some patches were truncated to keep this review responsive.", "部分补丁已截断，以保持审查页面流畅。")}</div> : null}
      {!review.files.length ? <EmptyTab>{text("No changed files were returned.", "没有返回变更文件。")}</EmptyTab> : null}
      {review.files.map((file) => (
        <section key={file.path} className="overflow-hidden rounded-2xl border border-dls-border bg-background">
          <header className="flex items-center gap-2 border-b border-dls-border bg-dls-hover/50 px-4 py-3"><FileCode2 className="size-4 text-dls-secondary" /><span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-dls-text">{file.path}</span><span className="text-[11px] text-green-11">+{file.additions}</span><span className="text-[11px] text-red-11">-{file.deletions}</span></header>
          <div className="overflow-x-auto bg-[#0d1117] py-2 font-mono text-[12px] leading-5 text-[#c9d1d9]">
            {file.patch.map((line, index) => (
              <div key={`${line.kind}-${index}`} className={cn("grid min-w-[720px] grid-cols-[46px_46px_1fr] px-2", line.kind === "addition" && "bg-[#1b4721]/55", line.kind === "deletion" && "bg-[#5a1e24]/55")}>
                <span className="select-none pr-2 text-right text-[#6e7681]">{line.oldLine ?? ""}</span><span className="select-none pr-3 text-right text-[#6e7681]">{line.newLine ?? ""}</span><code className="whitespace-pre">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}{line.text}</code>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CheckIcon({ state }: { state: ReviewCheckState }) {
  if (state === "success") return <CheckCircle2 className="size-5 text-green-10" />;
  if (state === "failure") return <XCircle className="size-5 text-red-10" />;
  if (state === "running") return <Clock3 className="size-5 animate-pulse text-blue-10" />;
  return <Circle className="size-5 text-dls-secondary" />;
}

function ChecksView({ review }: { review: ReviewPreview }) {
  const passed = review.checks.filter((check) => check.state === "success").length;
  return (
    <div className="mx-auto w-full max-w-4xl p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between"><div><h3 className="text-sm font-semibold text-dls-text">{text("Checks", "检查")}</h3><p className="mt-1 text-xs text-dls-secondary">{passed} / {review.checks.length} {text("checks passed", "项检查通过")}</p></div><Badge variant={passed === review.checks.length ? "secondary" : "outline"}>{passed === review.checks.length ? text("All passed", "全部通过") : text("In progress", "进行中")}</Badge></div>
      <div className="overflow-hidden rounded-2xl border border-dls-border bg-background">
        {!review.checks.length ? <EmptyTab>{text("No checks are available for this revision.", "当前版本没有可用检查。")}</EmptyTab> : null}
        {review.checks.map((check, index) => <div key={check.id} className={cn("flex items-center gap-3 px-4 py-4", index > 0 && "border-t border-dls-border")}><CheckIcon state={check.state} /><div className="min-w-0 flex-1"><p className="text-sm font-medium text-dls-text">{check.name}</p><p className="mt-0.5 truncate text-xs text-dls-secondary">{check.detail}</p></div>{check.duration ? <span className="text-xs text-dls-secondary">{check.duration}</span> : null}</div>)}
      </div>
    </div>
  );
}

function ThreadsView({ review }: { review: ReviewPreview }) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      {!review.threads.length ? <EmptyTab>{text("No review threads yet.", "暂无审查讨论。")}</EmptyTab> : null}
      {review.threads.map((thread) => <article key={thread.id} className={cn("rounded-2xl border bg-background p-4", thread.resolved ? "border-dls-border opacity-75" : "border-dls-border")}><div className="flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-full bg-dls-hover text-[10px] font-semibold">{thread.initials}</span><span className="text-xs font-semibold text-dls-text">{thread.author}</span><span className="text-[11px] text-dls-secondary">{thread.age}</span>{thread.reviewDecision ? <Badge variant="secondary" className="ml-auto">{thread.reviewDecision === "approved" ? text("Approved", "已批准") : text("Changes requested", "请求修改")}</Badge> : null}{thread.resolved ? <Badge variant="secondary" className="ml-auto">{text("Resolved", "已解决")}</Badge> : null}</div>{thread.path ? <div className="mt-3 rounded-lg bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">{thread.path}{thread.line ? `:${thread.line}` : ""}</div> : null}{(thread.comments?.length ? thread.comments : [{ id: thread.id, author: thread.author, body: thread.body, age: thread.age }]).map((comment, index) => <div key={comment.id} className={cn("mt-3", index > 0 && "border-t border-dls-border pt-3")}>{index > 0 ? <p className="text-xs text-dls-secondary">{comment.author} · {comment.age}</p> : null}<p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-dls-text">{comment.body}</p></div>)}</article>)}
      <div className="rounded-2xl border border-dashed border-dls-border p-5 text-center text-xs text-dls-secondary">{text("Use Submit review to publish a review or discussion comment to GitHub.", "接入平台写权限后，可回复或解决讨论。")}</div>
    </div>
  );
}

function DetailState(props: { loading?: boolean; error?: boolean; onRetry?: () => void }) {
  return <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-dls-secondary">{props.loading ? <><LoaderCircle className="size-6 animate-spin" /><span>{text("Loading pull request…", "正在加载拉取请求…")}</span></> : <><AlertCircle className="size-6 text-amber-10" /><span>{text("This section could not be loaded.", "无法加载此内容。")}</span>{props.onRetry ? <Button variant="outline" onClick={props.onRetry}><RefreshCw />{text("Retry", "重试")}</Button> : null}</>}</div>;
}

function ReviewDetail({ review, unknown, loading, actions, endpoint, operations, pinned, onTogglePin, onChanged, tab, onTabChange, tabLoading, tabError, truncated, revisionChanged, onRetryTab, onBack }: { review: ReviewPreview | null; unknown: boolean; loading?: boolean; actions?: ReactNode; endpoint?: ReturnType<typeof useReviewWorkspaceEndpoint>["endpoint"]; operations?: ReviewConnectionStatus["operations"]; pinned?: boolean; onTogglePin?: () => void; onChanged?: () => void | Promise<void>; tab: ReviewDetailTab; onTabChange: (tab: ReviewDetailTab) => void; tabLoading?: boolean; tabError?: boolean; truncated?: boolean; revisionChanged?: boolean; onRetryTab?: () => void; onBack: () => void }) {

  return (
    <main className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background", review || unknown || loading ? "flex" : "hidden md:flex")}>
      {loading ? <DetailState loading /> : unknown ? <UnknownDetail onBack={onBack} /> : review ? (
        <>
          <ReviewHeader review={review} onBack={onBack} actions={actions} endpoint={endpoint} operations={operations} pinned={pinned} onTogglePin={onTogglePin} onChanged={onChanged} />
          <div className="shrink-0 overflow-x-auto border-b border-dls-border bg-background px-5 md:px-7" role="tablist" aria-label={text("Pull request sections", "拉取请求内容")}>{TABS.map((item) => <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} onClick={() => onTabChange(item.value)} className={cn("relative h-9 whitespace-nowrap px-2.5 text-[11px] font-medium text-dls-secondary transition-colors hover:text-dls-text", tab === item.value && "text-dls-text after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-dls-text")}>{text(item.en, item.zh)}{item.value === "changes" ? ` ${review.changedFiles}` : item.value === "checks" ? ` ${review.checks.length}` : item.value === "threads" ? ` ${review.threads.length}` : ""}</button>)}</div>
          <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
            {revisionChanged ? <div className="m-4 rounded-xl border border-amber-7 bg-amber-3 px-4 py-3 text-xs text-amber-11">{text("The pull request revision changed while this tab was loading. Refresh before relying on line positions.", "加载期间拉取请求版本发生变化，请刷新后再依赖行位置。")}</div> : null}
            {tabLoading || tabError ? <DetailState loading={tabLoading} error={tabError} onRetry={onRetryTab} /> : null}
            {!tabLoading && !tabError && tab === "summary" ? <SummaryView review={review} onTabChange={onTabChange} /> : null}
            {!tabLoading && !tabError && tab === "changes" ? <ChangesView review={review} truncated={truncated} /> : null}
            {!tabLoading && !tabError && tab === "checks" ? <ChecksView review={review} /> : null}
            {!tabLoading && !tabError && tab === "threads" ? <ThreadsView review={review} /> : null}
          </div>
        </>
      ) : <EmptyDetail />}
    </main>
  );
}

export function ReviewPage(props: ReviewPageProps) {
  const queryClient = useQueryClient();
  const [urlDialog, setUrlDialog] = useState(false);
  const [url, setUrl] = useState("");
  const [openingUrl, setOpeningUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const openUrlGeneration = useRef(0);
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const { leftSidebarResizing, leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  const pageStyle = {
    "--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth),
  } as CSSProperties;
  const [query, setQuery] = useState("");
  const [expandedSections, setExpandedSections] = useState<ReviewRelationship[]>(["authored"]);
  const [tab, setTab] = useState<ReviewDetailTab>("summary");
  const [pinnedReviewIds, setPinnedReviewIds] = useState<string[]>(() => readPinnedReviews(props.workspaceId));
  useEffect(() => setPinnedReviewIds(readPinnedReviews(props.workspaceId)), [props.workspaceId]);
  const togglePinnedReview = (reviewId: string) => setPinnedReviewIds((current) => {
    const next = current.includes(reviewId) ? current.filter((id) => id !== reviewId) : [reviewId, ...current.filter((id) => id !== reviewId)];
    localStorage.setItem(pinnedStorageKey(props.workspaceId), JSON.stringify(next));
    return next;
  });
  const deferredQuery = useDeferredValue(query);
  const workspace = useReviewWorkspaceEndpoint(props.workspaceId, props.active);
  useEffect(() => { openUrlGeneration.current++; setUrlDialog(false); setOpeningUrl(false); setExpandedSections(["authored"]); }, [props.workspaceId, workspace.endpoint]);
  const toggleInboxSection = (relationship: ReviewRelationship) => setExpandedSections((current) => current.includes(relationship) ? current.filter((item) => item !== relationship) : [...current, relationship]);
  async function openReviewUrl() {
    if (!workspace.endpoint || openingUrl) return;
    const endpoint = workspace.endpoint;
    const generation = openUrlGeneration.current;
    const settings = readDenSettings();
    setOpeningUrl(true); setUrlError(null);
    try {
      const result = await endpoint.client.resolveReviewUrl(endpoint.workspaceId, url.trim());
      const current = readDenSettings();
      if (generation !== openUrlGeneration.current || current.authToken !== settings.authToken || current.activeOrgId !== settings.activeOrgId || current.baseUrl !== settings.baseUrl) return;
      queryClient.setQueryData(reviewQueryKeys.detail(endpoint, result.item.id), result);
      setUrlDialog(false);
      props.onSelectReview(result.item.id);
    } catch (error) { if (generation === openUrlGeneration.current) setUrlError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === openUrlGeneration.current) setOpeningUrl(false); }
  }
  const connection = useReviewConnection(workspace.endpoint, props.active);
  const inboxReady = connection.data?.state === "ready";
  const authoredInbox = useReviewInbox(workspace.endpoint, { active: props.active && expandedSections.includes("authored"), ready: inboxReady, relationship: "authored", query: deferredQuery });
  const requestedInbox = useReviewInbox(workspace.endpoint, { active: props.active && expandedSections.includes("requested"), ready: inboxReady, relationship: "review_requested", query: deferredQuery });
  const teamInbox = useReviewInbox(workspace.endpoint, { active: props.active && expandedSections.includes("team"), ready: inboxReady, relationship: "team_review_requested", query: deferredQuery });
  const mergedInbox = useReviewInbox(workspace.endpoint, { active: props.active && expandedSections.includes("recently_merged"), ready: inboxReady, relationship: "recently_merged", query: deferredQuery });
  const detail = useReviewDetail(workspace.endpoint, props.reviewId, props.active);
  const selectedReviewActive = props.active && Boolean(props.reviewId);
  const files = useReviewFiles(workspace.endpoint, props.reviewId, selectedReviewActive && tab === "changes");
  const checks = useReviewChecks(workspace.endpoint, props.reviewId, selectedReviewActive);
  const threads = useReviewThreads(workspace.endpoint, props.reviewId, selectedReviewActive);
  const listItems = useMemo(() => [authoredInbox.data, requestedInbox.data, teamInbox.data, mergedInbox.data].flatMap((data) => data?.pages.flatMap((page) => page.items) ?? []), [authoredInbox.data, mergedInbox.data, requestedInbox.data, teamInbox.data]);
  const selectedItem = detail.data?.item ?? listItems.find((item) => item.id === props.reviewId) ?? null;
  const reviewsFor = (data: typeof authoredInbox.data) => (data?.pages.flatMap((page) => page.items) ?? []).map((item) => ({ ...reviewViewModel({ item }), pinned: pinnedReviewIds.includes(item.id) })).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const inboxSections: ReviewInboxSectionState[] = [
    { relationship: "authored", reviews: reviewsFor(authoredInbox.data), loading: authoredInbox.isLoading, refreshing: authoredInbox.isFetching && !authoredInbox.isLoading, error: authoredInbox.error instanceof Error ? authoredInbox.error.message : null, hasNextPage: authoredInbox.hasNextPage, loadingNextPage: authoredInbox.isFetchingNextPage, onLoadMore: () => void authoredInbox.fetchNextPage(), onRetry: () => void authoredInbox.refetch() },
    { relationship: "requested", reviews: reviewsFor(requestedInbox.data), loading: requestedInbox.isLoading, refreshing: requestedInbox.isFetching && !requestedInbox.isLoading, error: requestedInbox.error instanceof Error ? requestedInbox.error.message : null, hasNextPage: requestedInbox.hasNextPage, loadingNextPage: requestedInbox.isFetchingNextPage, onLoadMore: () => void requestedInbox.fetchNextPage(), onRetry: () => void requestedInbox.refetch() },
    { relationship: "team", reviews: reviewsFor(teamInbox.data), loading: teamInbox.isLoading, refreshing: teamInbox.isFetching && !teamInbox.isLoading, error: teamInbox.error instanceof Error ? teamInbox.error.message : null, hasNextPage: teamInbox.hasNextPage, loadingNextPage: teamInbox.isFetchingNextPage, onLoadMore: () => void teamInbox.fetchNextPage(), onRetry: () => void teamInbox.refetch() },
    { relationship: "recently_merged", reviews: reviewsFor(mergedInbox.data), loading: mergedInbox.isLoading, refreshing: mergedInbox.isFetching && !mergedInbox.isLoading, error: mergedInbox.error instanceof Error ? mergedInbox.error.message : null, hasNextPage: mergedInbox.hasNextPage, loadingNextPage: mergedInbox.isFetchingNextPage, onLoadMore: () => void mergedInbox.fetchNextPage(), onRetry: () => void mergedInbox.refetch() },
  ];
  const review = useMemo(() => selectedItem ? { ...reviewViewModel({ item: selectedItem, detail: detail.data, files: files.data, checks: checks.data, threads: threads.data }), pinned: pinnedReviewIds.includes(selectedItem.id) } : null, [checks.data, detail.data, files.data, pinnedReviewIds, selectedItem, threads.data]);
  const unknown = props.reviewId !== null && detail.isError;
  const tabQuery = tab === "changes" ? files : tab === "checks" ? checks : tab === "threads" ? threads : detail;
  useEffect(() => setTab("summary"), [props.reviewId]);

  return (
    <div
      className="flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag"
      style={pageStyle}
      data-testid="review-page"
      data-workspace-id={props.workspaceId}
    >
      <AppNavigationRail
        workspaceId={props.workspaceId}
        reviewsActive
        onOpenAccount={props.onOpenAccount}
        onOpenHome={props.onOpenHome}
        onOpenApps={props.onOpenApps}
        onOpenChat={props.onOpenChat}
        onOpenReviews={() => undefined}
        onOpenSettings={props.onOpenSettings}
        onOpenTaskSearch={props.onOpenTaskSearch}
        onOpenCreateWorkspace={props.onOpenCreateWorkspace}
      />
      <AppSecondarySidebarTopControls
        sidebarOpen={sidebarOpen}
        onOpenTaskSearch={props.onOpenTaskSearch}
        onToggleSidebar={toggleSidebar}
      />
      <AppInsetSurface className="relative" testId="review-inset-surface">
        {workspace.loading || connection.isLoading ? <ConnectedState loading /> : connection.data?.state !== "ready" ? <ReviewGitHubConnection key={props.workspaceId} connectionId={connection.data?.connectionId} onConnected={() => { void connection.refetch(); }}>
          {(open) => <ConnectedState connection={connection.data} error={workspace.error ?? (connection.error instanceof Error ? connection.error.message : null)} onConnect={connection.data?.state === "disabled_in_workspace" ? props.onOpenConnect : open} onRetry={() => void connection.refetch()} />}
        </ReviewGitHubConnection> : (
          <ReviewWorkbench
          endpoint={workspace.endpoint}
          operations={connection.data.operations}
          pinned={Boolean(review?.pinned)}
          onTogglePin={() => { if (review) togglePinnedReview(review.id); }}
          onChanged={async () => {
            if (!workspace.endpoint) return;
            await queryClient.invalidateQueries({ queryKey: ["reviews", workspace.endpoint.baseUrl, workspace.endpoint.workspaceId] });
          }}
          actions={workspace.endpoint && review ? <ReviewWorkflowControls
            key={`${workspace.endpoint.baseUrl}:${workspace.endpoint.workspaceId}:${review.id}`}
            endpoint={workspace.endpoint} review={review} active={props.active}
            operations={connection.data.operations}
            onOpenSession={(id) => props.onOpenReviewSession?.(id)}
          /> : undefined}
          onOpenUrl={() => { setUrlError(null); setUrlDialog(true); }}
          sections={inboxSections}
          expandedSections={expandedSections}
          reviewId={props.reviewId}
          query={query}
          review={review}
          unknown={unknown}
          loading={Boolean(props.reviewId && detail.isLoading)}
          tab={tab}
          onTabChange={setTab}
          tabLoading={tab !== "summary" && tabQuery.isLoading}
          tabError={tab !== "summary" && tabQuery.isError}
          truncated={tab === "changes" ? files.data?.truncated : tab === "threads" ? threads.data?.truncated : false}
          revisionChanged={tab !== "summary" && Boolean((tab === "changes" ? files.data?.headRevision : tab === "checks" ? checks.data?.headRevision : threads.data?.headRevision) && detail.data?.item.headRevision !== "unknown" && (tab === "changes" ? files.data?.headRevision : tab === "checks" ? checks.data?.headRevision : threads.data?.headRevision) !== "unknown" && (tab === "changes" ? files.data?.headRevision : tab === "checks" ? checks.data?.headRevision : threads.data?.headRevision) !== detail.data?.item.headRevision)}
          onRetryTab={() => void tabQuery.refetch()}
          onQueryChange={setQuery}
          onToggleSection={toggleInboxSection}
          onSelectReview={props.onSelectReview}
          sidebarOpen={sidebarOpen}
          />
        )}
        {connection.data?.state === "ready" && sidebarOpen ? (
          <AppSecondarySidebarResizeHandle
            resizing={leftSidebarResizing}
            onPointerDown={startLeftSidebarResize}
          />
        ) : null}
      </AppInsetSurface>
      <Dialog open={urlDialog} onOpenChange={(open) => { setUrlDialog(open); if (!open) { openUrlGeneration.current++; setOpeningUrl(false); } }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>{text("Open a pull request", "打开拉取请求")}</DialogTitle>
          <DialogDescription>{text("Paste a GitHub pull request URL. Access uses your existing organization connector.", "粘贴 GitHub 拉取请求链接，使用当前组织连接器读取。")}</DialogDescription>
          <input aria-label={text("Pull request URL", "拉取请求链接")} className="h-10 w-full rounded-xl border border-dls-border bg-background px-3 text-sm" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository/pull/123" onKeyDown={(event) => { if (event.key === "Enter") void openReviewUrl(); }} />
          {urlError ? <p role="alert" className="text-sm text-red-11">{urlError}</p> : null}
          <Button disabled={openingUrl || !url.trim()} onClick={() => { void openReviewUrl(); }}>{openingUrl ? <LoaderCircle className="animate-spin" /> : null}{text("Open pull request", "打开拉取请求")}</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ReviewWorkbench(props: {
  actions?: ReactNode;
  endpoint?: ReturnType<typeof useReviewWorkspaceEndpoint>["endpoint"];
  operations?: ReviewConnectionStatus["operations"];
  pinned?: boolean;
  onTogglePin?: () => void;
  onChanged?: () => void | Promise<void>;
  onOpenUrl?: () => void;
  sections: ReviewInboxSectionState[];
  expandedSections: ReviewRelationship[];
  reviewId: string | null;
  query: string;
  review: ReviewPreview | null;
  unknown: boolean;
  loading?: boolean;
  tab?: ReviewDetailTab;
  onTabChange?: (tab: ReviewDetailTab) => void;
  tabLoading?: boolean;
  tabError?: boolean;
  truncated?: boolean;
  revisionChanged?: boolean;
  onRetryTab?: () => void;
  onQueryChange: (query: string) => void;
  onToggleSection: (relationship: ReviewRelationship) => void;
  onSelectReview: (reviewId: string | null) => void;
  sidebarOpen?: boolean;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="review-workbench">
      <div className={cn(
        "h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-linear",
        props.sidebarOpen !== false ? "w-full md:w-[var(--jugglework-left-sidebar-width)]" : "w-0",
        props.reviewId && "hidden md:block",
      )} data-app-secondary-sidebar-frame>
      {props.sidebarOpen !== false ? <ReviewInbox
        sections={props.sections}
        expandedSections={props.expandedSections}
        reviewId={props.reviewId}
        query={props.query}
        onQueryChange={props.onQueryChange}
        onToggleSection={props.onToggleSection}
        onSelectReview={props.onSelectReview}
        onOpenUrl={props.onOpenUrl}
      /> : null}
      </div>
      <ReviewDetail actions={props.actions} endpoint={props.endpoint} operations={props.operations} pinned={props.pinned} onTogglePin={props.onTogglePin} onChanged={props.onChanged} review={props.review} unknown={props.unknown} loading={props.loading} tab={props.tab ?? "summary"} onTabChange={props.onTabChange ?? (() => undefined)} tabLoading={props.tabLoading} tabError={props.tabError} truncated={props.truncated} revisionChanged={props.revisionChanged} onRetryTab={props.onRetryTab} onBack={() => props.onSelectReview(null)} />
    </div>
  );
}

export function ConnectedState(props: { loading?: boolean; connection?: ReviewConnectionStatus; error?: string | null; onConnect?: () => void; onRetry?: () => void }) {
  const state = props.connection?.state;
  const requiresAdministrator = state === "not_connected"
    || state === "organization_admin_action_required"
    || state === "provider_admin_action_required";
  if (!props.loading && !props.error && (requiresAdministrator || state === "member_authorization_required")) {
    return (
      <section
        className="relative isolate flex min-h-0 min-w-0 flex-1 overflow-y-auto bg-dls-surface px-6 py-12 mac:titlebar-no-drag sm:px-10"
        aria-labelledby="review-setup-title"
        data-testid="review-connection-state"
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden font-mono text-3xl text-dls-text/[0.025] select-none">
          <span className="absolute left-[4%] top-[8%] -rotate-12">{"{ / }"}</span>
          <span className="absolute bottom-[12%] left-[6%] rotate-12">{"< + >"}</span>
          <span className="absolute right-[5%] top-[24%] rotate-12">{"( )"}</span>
          <span className="absolute bottom-[8%] right-[7%] -rotate-12">{"[ ; ]"}</span>
        </div>
        <div className="relative m-auto flex w-full max-w-xl flex-col items-center text-center" data-testid="review-github-setup">
          <div aria-hidden="true" className="mb-7 flex size-14 items-center justify-center rounded-2xl bg-black text-white sm:mb-8 sm:size-16 sm:rounded-[18px]">
            <GitPullRequestArrow className="size-9 sm:size-10" strokeWidth={2.25} />
          </div>
          <h1 id="review-setup-title" className="text-2xl font-semibold tracking-tight text-dls-text sm:text-[28px] sm:leading-9">
            {text("Code review", "代码审查")}
          </h1>
          <p className="mt-4 text-sm leading-6 text-dls-text sm:text-base">
            {requiresAdministrator
              ? text(
                "Code Review only uses GitHub connections provided by your organization. Ask an organization administrator to add and configure GitHub.",
                "代码评审只使用组织下发的 GitHub 连接。请联系组织管理员添加并配置 GitHub。",
              )
              : text(
                "Your organization provides GitHub. Authorize your account in Connect settings to start reviewing pull requests.",
                "你的组织已提供 GitHub。请在连接设置中授权你的账号，然后开始评审 Pull Request。",
              )}
          </p>
          <Button size="lg" className="mt-7 h-10 w-48 max-w-full gap-2 rounded-full text-sm sm:mt-8" onClick={props.onConnect}>
            {text("Open Connect settings", "打开连接设置")}
          </Button>
        </div>
      </section>
    );
  }
  const unavailable = !props.loading && (!state || state === "unavailable");
  const title = props.loading
    ? text("Checking GitHub connection…", "正在检查 GitHub 连接…")
    : state === "disabled_in_workspace"
      ? text("GitHub is disabled for this workspace", "当前工作区已停用 GitHub")
      : state === "organization_admin_action_required" || state === "provider_admin_action_required"
        ? text("GitHub needs administrator setup", "GitHub 需要管理员配置")
        : unavailable
          ? text("GitHub connection needs attention", "需要检查 GitHub 连接")
          : text("Connect your GitHub account", "连接你的 GitHub 账号");
  const description = props.connection?.hint
    ?? props.error
    ?? (unavailable
      ? text(
        "Open Connect settings to check whether GitHub is available to you and authorize your account, then retry.",
        "请打开连接设置，检查组织是否已提供 GitHub，并授权你自己的 GitHub 账号，然后重试。",
      )
      : text(
        "JuggleWork uses your member-authorized GitHub account through Connect.",
        "JuggleWork 通过 Connect 使用你本人授权的 GitHub 账号。",
      ));

  return <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-dls-surface/40 p-8" data-testid="review-connection-state"><div className="max-w-md rounded-2xl border border-dls-border bg-background p-7 text-center shadow-[var(--dls-card-shadow)]">{props.loading ? <LoaderCircle className="mx-auto size-7 animate-spin text-violet-11" /> : <GitPullRequestArrow className="mx-auto size-8 text-violet-11" />}<h2 className="mt-4 text-base font-semibold text-dls-text">{title}</h2><p className="mt-2 text-sm leading-6 text-dls-secondary">{description}</p><div className="mt-5 flex flex-wrap justify-center gap-2">{!props.loading ? <Button onClick={props.onConnect}>{text("Open Connect settings", "打开连接设置")}</Button> : null}{unavailable ? <Button variant="outline" onClick={props.onRetry}><RefreshCw />{text("Retry", "重试")}</Button> : null}</div></div></div>;
}
