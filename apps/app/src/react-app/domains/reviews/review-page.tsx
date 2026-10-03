/** @jsxImportSource react */
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  FileCode2,
  GitBranch,
  GitPullRequestArrow,
  MessageSquareText,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import type { OpenCreateWorkspace } from "@/react-app/domains/workspace/types";
import type { ReviewConnectionStatus, ReviewRelationship as WireReviewRelationship } from "@jugglework/types/reviews";

import {
  useReviewChecks,
  useReviewConnection,
  useReviewDetail,
  useReviewFiles,
  useReviewInbox,
  useReviewThreads,
} from "./review-queries";
import { reviewViewModel } from "./review-view-model";
import { useReviewWorkspaceEndpoint } from "./use-review-workspace-endpoint";
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
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onOpenConnect: () => void;
  onOpenTaskSearch: () => void;
  onOpenCreateWorkspace: OpenCreateWorkspace;
};

const FILTERS: Array<{ value: "all" | ReviewRelationship; en: string; zh: string }> = [
  { value: "all", en: "All open", zh: "全部待处理" },
  { value: "requested", en: "Requested", zh: "等待我审查" },
  { value: "team", en: "My team", zh: "等待团队审查" },
  { value: "authored", en: "Authored", zh: "我创建的" },
  { value: "reviewed", en: "Reviewed", zh: "已审查" },
];

const TABS: Array<{ value: ReviewDetailTab; en: string; zh: string }> = [
  { value: "summary", en: "Summary", zh: "摘要" },
  { value: "changes", en: "Changes", zh: "变更" },
  { value: "checks", en: "Checks", zh: "检查" },
  { value: "threads", en: "Threads", zh: "讨论" },
];

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
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-5 to-blue-5 font-semibold text-violet-11 ring-1 ring-violet-7/40",
      size === "sm" ? "size-7 text-[10px]" : "size-9 text-xs",
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
        "group flex w-full items-start gap-3 border-b border-dls-border px-4 py-3.5 text-left transition-colors hover:bg-dls-hover/70",
        selected && "bg-dls-active/70 hover:bg-dls-active",
      )}
    >
      <ReviewAvatar review={review} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[11px] text-dls-secondary">
          <span className="truncate font-medium text-dls-text">{review.owner}/{review.repository}</span>
          <span>#{review.number}</span>
          <span className="ml-auto shrink-0">{review.updatedAt}</span>
        </span>
        <span className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-5 text-dls-text">{review.title}</span>
        <span className="mt-2 flex items-center gap-2 text-[11px] text-dls-secondary">
          {review.draft ? <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{text("Draft", "草稿")}</Badge> : null}
          {review.pinned ? <span className="font-medium text-violet-11">{text("Pinned", "已置顶")}</span> : null}
          <span className="ml-auto flex items-center gap-1"><MessageSquareText className="size-3" />{review.comments}</span>
          <span className="text-green-11">+{review.additions}</span>
          <span className="text-red-11">-{review.deletions}</span>
        </span>
      </span>
      <ChevronRight className="mt-5 size-4 shrink-0 text-dls-secondary opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function ReviewInbox(props: {
  reviews: ReviewPreview[];
  reviewId: string | null;
  query: string;
  relationship: "all" | ReviewRelationship;
  onQueryChange: (query: string) => void;
  onRelationshipChange: (relationship: "all" | ReviewRelationship) => void;
  onSelectReview: (reviewId: string) => void;
  loading?: boolean;
  refreshing?: boolean;
  hasNextPage?: boolean;
  loadingNextPage?: boolean;
  onLoadMore?: () => void;
  connectionName?: string;
  error?: string | null;
  onRetry?: () => void;
  onRefresh?: () => void;
}) {
  return (
    <aside className={cn(
      "min-h-0 w-full shrink-0 flex-col border-r border-dls-border bg-dls-sidebar md:flex md:w-[360px] lg:w-[400px] xl:w-[440px]",
      props.reviewId ? "hidden" : "flex",
    )} aria-label={text("Pull request inbox", "拉取请求收件箱")}>
      <div className="shrink-0 border-b border-dls-border px-4 pb-3 pt-3 mac:pt-5">
        <div className="flex items-center gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-[15px] font-semibold text-dls-text">{text("Code Review", "代码审查")}</h1>
              <Badge variant="secondary" className="bg-green-4 text-[10px] text-green-11">{text("Connected", "已连接")}</Badge>
              {props.refreshing ? <RefreshCw className="size-3 animate-spin text-dls-secondary" aria-label={text("Refreshing", "正在刷新")} /> : null}
            </div>
            <p className="mt-0.5 text-[11px] text-dls-secondary">{props.connectionName ?? "GitHub"} · {text("Read only", "只读")}</p>
          </div>
          <span className="ml-auto rounded-full bg-dls-hover px-2 py-1 text-[11px] font-medium text-dls-secondary">{props.reviews.length}</span>
          <Button variant="ghost" size="icon-sm" onClick={props.onRefresh} disabled={props.refreshing} aria-label={text("Refresh pull requests", "刷新拉取请求")}><RefreshCw className={cn("size-3.5", props.refreshing && "animate-spin")} /></Button>
        </div>
        <label className="relative mt-3 block">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-dls-secondary" />
          <input
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={text("Search pull requests", "搜索拉取请求")}
            className="h-9 w-full rounded-xl border border-dls-border bg-background pl-9 pr-3 text-xs text-dls-text outline-none transition focus:border-dls-accent"
          />
        </label>
        <select
          value={props.relationship}
          onChange={(event) => props.onRelationshipChange(event.target.value as "all" | ReviewRelationship)}
          aria-label={text("Review relationship", "审查关系")}
          className="mt-2 h-8 w-full rounded-lg border border-dls-border bg-background px-2.5 text-xs text-dls-text outline-none"
        >
          {FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{text(filter.en, filter.zh)}</option>)}
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="list">
        {props.loading ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-xs text-dls-secondary"><LoaderCircle className="size-4 animate-spin" />{text("Loading pull requests…", "正在加载拉取请求…")}</div>
        ) : props.error && !props.reviews.length ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center"><AlertCircle className="size-7 text-amber-10" /><p className="mt-3 text-sm font-medium text-dls-text">{text("Pull requests could not be loaded", "无法加载拉取请求")}</p><p className="mt-1 text-xs leading-5 text-dls-secondary">{props.error}</p><Button variant="outline" className="mt-4" onClick={props.onRetry}><RefreshCw />{text("Retry", "重试")}</Button></div>
        ) : props.reviews.length ? <>
          {props.reviews.map((review) => (
          <div role="listitem" key={review.id}>
            <InboxRow review={review} selected={review.id === props.reviewId} onSelect={() => props.onSelectReview(review.id)} />
          </div>
          ))}
          {props.hasNextPage ? <div className="p-3"><Button variant="outline" className="w-full" disabled={props.loadingNextPage} onClick={props.onLoadMore}>{props.loadingNextPage ? <LoaderCircle className="animate-spin" /> : null}{text("Load more", "加载更多")}</Button></div> : null}
        </> : (
          <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center">
            <Search className="size-7 text-dls-secondary/60" />
            <p className="mt-3 text-sm font-medium text-dls-text">{text("No matching pull requests", "没有匹配的拉取请求")}</p>
            <p className="mt-1 text-xs leading-5 text-dls-secondary">{text("Try another search or relationship filter.", "请尝试其他搜索词或审查筛选条件。")}</p>
          </div>
        )}
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

function ReviewHeader({ review, onBack }: { review: ReviewPreview; onBack: () => void }) {
  return (
    <header className="shrink-0 border-b border-dls-border bg-background px-4 py-3 md:px-6 mac:pt-5">
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onBack} aria-label={text("Back to Inbox", "返回收件箱")}><ArrowLeft /></Button>
        <ReviewAvatar review={review} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-dls-secondary">
            <span className="font-medium text-dls-text">{review.owner}/{review.repository}</span>
            <span>#{review.number}</span>
            {review.draft ? <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{text("Draft", "草稿")}</Badge> : <Badge variant="secondary" className="h-4 bg-green-4 px-1.5 text-[10px] text-green-11">{text("Open", "开放")}</Badge>}
          </div>
          <h2 className="mt-1 truncate text-[16px] font-semibold text-dls-text">{review.title}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-dls-secondary">
            <span>{text("by", "作者")} {review.author}</span>
            <span className="flex items-center gap-1"><GitBranch className="size-3" />{review.baseBranch} ← {review.headBranch}</span>
            <span className="font-mono">{review.headRevision}</span>
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <Button variant="outline" disabled title={text("Available after AI Review is connected", "接入 AI Review 后可用")}><Bot />{text("Review with JuggleWork", "使用 JuggleWork 审查")}</Button>
          <Button disabled title={text("Available after provider write access is connected", "接入平台写权限后可用")}>{text("Submit review", "提交审查")}</Button>
        </div>
      </div>
    </header>
  );
}

function SummaryView({ review }: { review: ReviewPreview }) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-5">
        <section className="rounded-2xl border border-dls-border bg-background p-5 shadow-[var(--dls-card-shadow)]">
          <div className="flex items-center gap-2"><GitPullRequestArrow className="size-4 text-violet-11" /><h3 className="text-sm font-semibold text-dls-text">{text("Pull request overview", "拉取请求概览")}</h3><Badge variant="secondary" className="ml-auto text-[10px]">{text("GitHub", "GitHub")}</Badge></div>
          <ul className="mt-4 space-y-3">
            {review.summary.map((item) => <li key={item} className="flex gap-2.5 text-sm leading-6 text-dls-text"><Check className="mt-1 size-4 shrink-0 text-green-10" /><span>{item}</span></li>)}
          </ul>
        </section>
        <section className="rounded-2xl border border-dls-border bg-background p-5">
          <h3 className="text-sm font-semibold text-dls-text">{text("Description", "描述")}</h3>
          <p className="mt-3 text-sm leading-6 text-dls-secondary">{review.body}</p>
        </section>
        <section className="rounded-2xl border border-dashed border-violet-7 bg-violet-2/60 p-5">
          <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-5 text-violet-11" /><div><h3 className="text-sm font-semibold text-dls-text">{text("Private AI review is coming next", "下一步将接入私有 AI 审查")}</h3><p className="mt-1 text-xs leading-5 text-dls-secondary">{text("Findings will stay private until you explicitly choose to publish a comment or review decision.", "AI 发现默认保持私有，只有在你明确选择后才会发布评论或审查结论。")}</p></div></div>
        </section>
      </div>
      <aside className="space-y-4">
        <section className="rounded-2xl border border-dls-border bg-background p-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-dls-secondary">{text("Change", "变更")}</h3>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-dls-hover p-2"><dt className="text-[10px] text-dls-secondary">{text("Files", "文件")}</dt><dd className="mt-1 text-sm font-semibold">{review.changedFiles}</dd></div>
            <div className="rounded-xl bg-green-3 p-2"><dt className="text-[10px] text-green-11">{text("Added", "新增")}</dt><dd className="mt-1 text-sm font-semibold text-green-11">+{review.additions}</dd></div>
            <div className="rounded-xl bg-red-3 p-2"><dt className="text-[10px] text-red-11">{text("Removed", "删除")}</dt><dd className="mt-1 text-sm font-semibold text-red-11">-{review.deletions}</dd></div>
          </dl>
        </section>
        <section className="rounded-2xl border border-dls-border bg-background p-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-dls-secondary">{text("Labels", "标签")}</h3>
          <div className="mt-3 flex flex-wrap gap-2">{review.labels.map((label) => <Badge key={label} variant="outline">{label}</Badge>)}</div>
        </section>
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
      {review.threads.map((thread) => <article key={thread.id} className={cn("rounded-2xl border bg-background p-4", thread.resolved ? "border-dls-border opacity-75" : "border-dls-border")}><div className="flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-full bg-dls-hover text-[10px] font-semibold">{thread.initials}</span><span className="text-xs font-semibold text-dls-text">{thread.author}</span><span className="text-[11px] text-dls-secondary">{thread.age}</span>{thread.resolved ? <Badge variant="secondary" className="ml-auto">{text("Resolved", "已解决")}</Badge> : null}</div>{thread.path ? <div className="mt-3 rounded-lg bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">{thread.path}{thread.line ? `:${thread.line}` : ""}</div> : null}<p className="mt-3 text-sm leading-6 text-dls-text">{thread.body}</p></article>)}
      <div className="rounded-2xl border border-dashed border-dls-border p-5 text-center text-xs text-dls-secondary">{text("Replying and resolving threads will be available after provider write access is connected.", "接入平台写权限后，可回复或解决讨论。")}</div>
    </div>
  );
}

function DetailState(props: { loading?: boolean; error?: boolean; onRetry?: () => void }) {
  return <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-dls-secondary">{props.loading ? <><LoaderCircle className="size-6 animate-spin" /><span>{text("Loading pull request…", "正在加载拉取请求…")}</span></> : <><AlertCircle className="size-6 text-amber-10" /><span>{text("This section could not be loaded.", "无法加载此内容。")}</span>{props.onRetry ? <Button variant="outline" onClick={props.onRetry}><RefreshCw />{text("Retry", "重试")}</Button> : null}</>}</div>;
}

function ReviewDetail({ review, unknown, loading, tab, onTabChange, tabLoading, tabError, truncated, revisionChanged, onRetryTab, onBack }: { review: ReviewPreview | null; unknown: boolean; loading?: boolean; tab: ReviewDetailTab; onTabChange: (tab: ReviewDetailTab) => void; tabLoading?: boolean; tabError?: boolean; truncated?: boolean; revisionChanged?: boolean; onRetryTab?: () => void; onBack: () => void }) {

  return (
    <main className={cn("min-h-0 min-w-0 flex-1 flex-col bg-dls-surface/40", review || unknown || loading ? "flex" : "hidden md:flex")}>
      {loading ? <DetailState loading /> : unknown ? <UnknownDetail onBack={onBack} /> : review ? (
        <>
          <ReviewHeader review={review} onBack={onBack} />
          <div className="shrink-0 overflow-x-auto border-b border-dls-border bg-background px-4 md:px-6" role="tablist" aria-label={text("Pull request sections", "拉取请求内容")}>{TABS.map((item) => <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} onClick={() => onTabChange(item.value)} className={cn("relative h-10 whitespace-nowrap px-3 text-xs font-medium text-dls-secondary transition-colors hover:text-dls-text", tab === item.value && "text-dls-text after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-dls-text")}>{text(item.en, item.zh)}{item.value === "changes" ? ` ${review.changedFiles}` : item.value === "checks" ? ` ${review.checks.length}` : item.value === "threads" ? ` ${review.threads.length}` : ""}</button>)}</div>
          <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
            {revisionChanged ? <div className="m-4 rounded-xl border border-amber-7 bg-amber-3 px-4 py-3 text-xs text-amber-11">{text("The pull request revision changed while this tab was loading. Refresh before relying on line positions.", "加载期间拉取请求版本发生变化，请刷新后再依赖行位置。")}</div> : null}
            {tabLoading || tabError ? <DetailState loading={tabLoading} error={tabError} onRetry={onRetryTab} /> : null}
            {!tabLoading && !tabError && tab === "summary" ? <SummaryView review={review} /> : null}
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
  const [query, setQuery] = useState("");
  const [relationship, setRelationship] = useState<"all" | ReviewRelationship>("all");
  const [tab, setTab] = useState<ReviewDetailTab>("summary");
  const deferredQuery = useDeferredValue(query);
  const workspace = useReviewWorkspaceEndpoint(props.workspaceId, props.active);
  const connection = useReviewConnection(workspace.endpoint, props.active);
  const wireRelationship: WireReviewRelationship = relationship === "requested" ? "review_requested" : relationship === "team" ? "team_review_requested" : relationship;
  const inbox = useReviewInbox(workspace.endpoint, { active: props.active, ready: connection.data?.state === "ready", relationship: wireRelationship, query: deferredQuery });
  const detail = useReviewDetail(workspace.endpoint, props.reviewId, props.active);
  const files = useReviewFiles(workspace.endpoint, props.reviewId, props.active && tab === "changes");
  const checks = useReviewChecks(workspace.endpoint, props.reviewId, props.active && tab === "checks");
  const threads = useReviewThreads(workspace.endpoint, props.reviewId, props.active && tab === "threads");
  const listItems = useMemo(() => inbox.data?.pages.flatMap((page) => page.items) ?? [], [inbox.data]);
  const selectedItem = detail.data?.item ?? listItems.find((item) => item.id === props.reviewId) ?? null;
  const reviews = useMemo(() => listItems.map((item) => reviewViewModel({ item })), [listItems]);
  const review = useMemo(() => selectedItem ? reviewViewModel({ item: selectedItem, detail: detail.data, files: files.data, checks: checks.data, threads: threads.data }) : null, [checks.data, detail.data, files.data, selectedItem, threads.data]);
  const unknown = props.reviewId !== null && detail.isError;
  const tabQuery = tab === "changes" ? files : tab === "checks" ? checks : tab === "threads" ? threads : detail;
  useEffect(() => setTab("summary"), [props.reviewId]);

  return (
    <div
      className="flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag"
      data-testid="review-page"
      data-workspace-id={props.workspaceId}
    >
      <AppNavigationRail
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
      <AppInsetSurface testId="review-inset-surface">
        {workspace.loading || connection.isLoading ? <ConnectedState loading /> : connection.data?.state !== "ready" ? <ConnectedState connection={connection.data} error={workspace.error ?? (connection.error instanceof Error ? connection.error.message : null)} onConnect={props.onOpenConnect} onRetry={() => void connection.refetch()} /> : (
          <ReviewWorkbench
          reviews={reviews}
          reviewId={props.reviewId}
          query={query}
          relationship={relationship}
          review={review}
          unknown={unknown}
          loading={Boolean(props.reviewId && detail.isLoading)}
          inboxLoading={inbox.isLoading}
          inboxRefreshing={inbox.isFetching && !inbox.isLoading}
          inboxError={inbox.error instanceof Error ? inbox.error.message : null}
          hasNextPage={inbox.hasNextPage}
          loadingNextPage={inbox.isFetchingNextPage}
          onLoadMore={() => void inbox.fetchNextPage()}
          onRetryInbox={() => void inbox.refetch()}
          onRefreshInbox={() => void inbox.refetch()}
          connectionName={connection.data.connectionName}
          tab={tab}
          onTabChange={setTab}
          tabLoading={tab !== "summary" && tabQuery.isLoading}
          tabError={tab !== "summary" && tabQuery.isError}
          truncated={tab === "changes" ? files.data?.truncated : tab === "threads" ? threads.data?.truncated : false}
          revisionChanged={tab !== "summary" && Boolean((tab === "changes" ? files.data?.headRevision : tab === "checks" ? checks.data?.headRevision : threads.data?.headRevision) && detail.data?.item.headRevision !== "unknown" && (tab === "changes" ? files.data?.headRevision : tab === "checks" ? checks.data?.headRevision : threads.data?.headRevision) !== "unknown" && (tab === "changes" ? files.data?.headRevision : tab === "checks" ? checks.data?.headRevision : threads.data?.headRevision) !== detail.data?.item.headRevision)}
          onRetryTab={() => void tabQuery.refetch()}
          onQueryChange={setQuery}
          onRelationshipChange={setRelationship}
          onSelectReview={props.onSelectReview}
          />
        )}
      </AppInsetSurface>
    </div>
  );
}

export function ReviewWorkbench(props: {
  reviews: ReviewPreview[];
  reviewId: string | null;
  query: string;
  relationship: "all" | ReviewRelationship;
  review: ReviewPreview | null;
  unknown: boolean;
  loading?: boolean;
  inboxLoading?: boolean;
  inboxRefreshing?: boolean;
  hasNextPage?: boolean;
  loadingNextPage?: boolean;
  onLoadMore?: () => void;
  connectionName?: string;
  inboxError?: string | null;
  onRetryInbox?: () => void;
  onRefreshInbox?: () => void;
  tab?: ReviewDetailTab;
  onTabChange?: (tab: ReviewDetailTab) => void;
  tabLoading?: boolean;
  tabError?: boolean;
  truncated?: boolean;
  revisionChanged?: boolean;
  onRetryTab?: () => void;
  onQueryChange: (query: string) => void;
  onRelationshipChange: (relationship: "all" | ReviewRelationship) => void;
  onSelectReview: (reviewId: string | null) => void;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="review-workbench">
      <ReviewInbox
        reviews={props.reviews}
        reviewId={props.reviewId}
        query={props.query}
        relationship={props.relationship}
        onQueryChange={props.onQueryChange}
        onRelationshipChange={props.onRelationshipChange}
        onSelectReview={props.onSelectReview}
        loading={props.inboxLoading}
        refreshing={props.inboxRefreshing}
        hasNextPage={props.hasNextPage}
        loadingNextPage={props.loadingNextPage}
        onLoadMore={props.onLoadMore}
        connectionName={props.connectionName}
        error={props.inboxError}
        onRetry={props.onRetryInbox}
        onRefresh={props.onRefreshInbox}
      />
      <ReviewDetail review={props.review} unknown={props.unknown} loading={props.loading} tab={props.tab ?? "summary"} onTabChange={props.onTabChange ?? (() => undefined)} tabLoading={props.tabLoading} tabError={props.tabError} truncated={props.truncated} revisionChanged={props.revisionChanged} onRetryTab={props.onRetryTab} onBack={() => props.onSelectReview(null)} />
    </div>
  );
}

export function ConnectedState(props: { loading?: boolean; connection?: ReviewConnectionStatus; error?: string | null; onConnect?: () => void; onRetry?: () => void }) {
  const state = props.connection?.state;
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
